'use strict';
const $ = id => document.getElementById(id);
const pipPositions = { 1: [5], 2: [1, 9], 3: [1, 5, 9], 4: [1, 3, 7, 9], 5: [1, 3, 5, 7, 9], 6: [1, 3, 4, 6, 7, 9] };
let roomId = new URLSearchParams(location.search).get('room');
let credential = null, state = null, source = null, connected = false, busy = false;
const storageKey = () => `yatzy-room:${roomId}`;
function message(value = '') { $('message').textContent = value; }
function saveCredential(value) {
    credential = value;
    try { localStorage.setItem(storageKey(), value); }
    catch { message('Keep this tab open: your browser cannot save your place for a refresh.'); }
}
async function request(url, body) {
    const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(credential ? { Authorization: `Bearer ${credential}` } : {}) }, body: JSON.stringify(body) });
    if (!response.headers.get('content-type')?.includes('application/json')) throw new Error('Online play needs the multiplayer server. Open the game using the address where that server is running.');
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Could not reach the game.');
    return data;
}
function connect() {
    source?.close(); connected = false;
    $('lobby').hidden = true; $('game').hidden = false;
    $('invite-url').value = `${location.origin}/multiplayer/?room=${roomId}`;
    $('connection').textContent = 'Connecting…';
    source = new EventSource(`/api/rooms/${roomId}/events?token=${encodeURIComponent(credential)}`);
    source.onmessage = event => {
        state = JSON.parse(event.data); connected = true; message(); render();
    };
    source.onerror = async () => {
        connected = false; render();
        try {
            const response = await fetch(`/api/rooms/${roomId}`, { headers: { Authorization: `Bearer ${credential}` } });
            if (response.status === 404 || response.status === 401) {
                source.close(); message('This room expired, or your player session is no longer available. Start another game.');
                $('connection').textContent = 'Room unavailable';
            }
        } catch { /* EventSource retries when the connection returns. */ }
    };
}
function render() {
    $('connection').textContent = connected ? 'Connected' : 'Reconnecting…';
    if (!state) return;
    const r = buildRules(state.variant);
    const myIndex = state.you;
    const mine = connected && !busy && state.phase === 'playing' && myIndex === state.turn;
    $('game-title').textContent = r.title;
    $('invite').hidden = state.phase !== 'waiting';
    $('turn').textContent = state.phase === 'waiting' ? 'Waiting for your friend to join…'
        : state.phase === 'finished' ? result()
        : myIndex === state.turn ? 'Your turn' : `${state.players[state.turn].name}’s turn`;
    $('rolls').textContent = `${state.rolls} roll${state.rolls === 1 ? '' : 's'} left`;
    $('roll').disabled = !mine || !state.rolls || state.held.every(Boolean);
    $('hint').textContent = state.phase === 'finished' ? 'Game complete. Play again with a new room link.'
        : mine ? 'Tap dice to keep them. Tap a score to finish your turn.' : 'Both players see each roll and score here.';
    $('dice').replaceChildren(...state.dice.map((d, i) => {
        const button = document.createElement('button');
        button.className = `die${state.held[i] ? ' held' : ''}`;
        const face = document.createElement('span'); face.className = 'die-face'; face.setAttribute('aria-hidden', 'true');
        for (const position of state.rolled ? pipPositions[d] : [5]) {
            const pip = document.createElement('i'); pip.className = 'pip';
            pip.style.gridRow = Math.ceil(position / 3); pip.style.gridColumn = (position - 1) % 3 + 1;
            face.append(pip);
        }
        button.append(face);
        const label = document.createElement('span'); label.textContent = state.held[i] ? 'Keep' : 'Die ' + (i + 1); button.append(label);
        button.setAttribute('aria-label', `Die ${i + 1}: ${state.rolled ? d : 'unrolled'}`);
        button.setAttribute('aria-pressed', String(state.held[i]));
        button.disabled = !mine || !state.rolled || state.rolls === 0;
        button.onclick = () => action({ type: 'hold', die: i });
        return button;
    }));
    for (let i = 0; i < 2; i++) $('player-' + i).textContent = state.players[i] ? `${state.players[i].name}${i === myIndex ? ' (you)' : ''}` : 'Friend';
    const active = state.players[state.turn];
    const placement = state.rolled ? r.placements(r.rollId(state.dice), active.mask, active.alikeScored) : null;
    $('scores').replaceChildren(...r.cells.map((cell, i) => {
        const row = document.createElement('tr'), heading = document.createElement('th');
        heading.scope = 'row'; heading.textContent = cell.label; row.append(heading);
        for (let j = 0; j < 2; j++) {
            const td = document.createElement('td'), p = state.players[j];
            if (p && p.cells[i] !== null) td.textContent = p.cells[i];
            else if (mine && j === myIndex && placement && (placement.legal & (1 << i))) {
                const button = document.createElement('button'); button.className = 'score-pick';
                button.textContent = placement.scores[i] + placement.bonus;
                button.setAttribute('aria-label', `Score ${button.textContent} in ${cell.label}`);
                button.onclick = () => action({ type: 'score', cell: i }); td.append(button);
            } else td.textContent = '—';
            row.append(td);
        }
        return row;
    }));
    $('totals').replaceChildren(...[['Upper sum', p => p.upper], ['Bonus', p => p.bonus], ['Total', p => p.score + p.bonus]].map(([name, value]) => {
        const tr = document.createElement('tr'), th = document.createElement('th'); th.textContent = name; tr.append(th);
        for (let i = 0; i < 2; i++) { const td = document.createElement('td'); td.textContent = state.players[i] ? value(state.players[i]) : '—'; tr.append(td); }
        return tr;
    }));
}
function result() {
    const totals = state.players.map(p => p.score + p.bonus);
    return totals[0] === totals[1] ? `A draw! ${totals[0]} points each.` : `${state.players[totals[0] > totals[1] ? 0 : 1].name} wins! ${totals[0]} – ${totals[1]}`;
}
async function action(data) {
    if (busy || !connected) return;
    busy = true; render(); message();
    try { const next = await request(`/api/rooms/${roomId}/action`, { ...data, revision: state.revision }); if (next.revision >= state.revision) state = { ...next, you: state.you }; }
    catch (error) { message(error.message); }
    finally { busy = false; render(); }
}
$('setup').onsubmit = async event => {
    event.preventDefault(); $('submit').disabled = true; message();
    try {
        const data = await request(roomId ? `/api/rooms/${roomId}/join` : '/api/rooms', { name: $('name').value, variant: $('variant').value });
        roomId = data.id; saveCredential(data.token);
        history.replaceState(null, '', `?room=${roomId}`); connect();
    } catch (error) { message(error.message); }
    finally { $('submit').disabled = false; }
};
$('roll').onclick = () => action({ type: 'roll' });
$('copy').onclick = async () => {
    try { await navigator.clipboard.writeText($('invite-url').value); $('copy').textContent = 'Copied!'; }
    catch { $('invite-url').select(); message('Copy the selected invite link and send it to your friend.'); }
};
if (roomId && !/^[a-f0-9]{12}$/.test(roomId)) { message('That invite link is invalid. Create a new room.'); roomId = null; }
if (roomId) {
    try { credential = localStorage.getItem(storageKey()); } catch { /* Joining still works without storage. */ }
    if (credential) connect();
    else { $('lobby-title').textContent = 'Join your friend'; $('variant-label').hidden = true; $('submit').textContent = 'Join game'; $('setup-note').textContent = 'Enter your name to take the second seat.'; }
}
