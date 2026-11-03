'use strict';
const $ = id => document.getElementById(id);
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
// Use the same cube faces, rotations, staggering, score rows and roll chips as the solo game.
const PIPS = { 1: [22], 2: [11, 33], 3: [11, 22, 33], 4: [11, 13, 31, 33], 5: [11, 13, 22, 31, 33], 6: [11, 13, 21, 23, 31, 33] };
const REST = { 1: [0, 0], 2: [90, 0], 3: [0, 90], 4: [0, -90], 5: [-90, 0], 6: [0, 180] };
const DEPTH = 'translateZ(calc(var(--die) * -0.5))';
const TILT = DEPTH + ' rotateX(-24deg) rotateY(-32deg)';
let display = null, animating = false, animationTimer = null, swallowClick = false;
let spins = [], latest = [], previousMasks = [];

function finishAnimation() {
    clearTimeout(animationTimer);
    animating = false;
    render();
}
addEventListener('pointerdown', event => {
    swallowClick = false;
    if (!animating) return;
    document.body.classList.add('skip');
    finishAnimation();
    requestAnimationFrame(() => requestAnimationFrame(() => document.body.classList.remove('skip')));
    swallowClick = true;
    event.stopPropagation();
}, true);
addEventListener('click', event => {
    if (!swallowClick) return;
    swallowClick = false;
    event.preventDefault();
    event.stopPropagation();
}, true);

function render() {
    $('connection').textContent = connected ? 'Connected' : 'Reconnecting…';
    if (!state) return;
    const r = buildRules(state.variant), myIndex = state.you, playerCount = state.playerCount || 2;
    const mine = connected && !animating && state.phase === 'playing' && myIndex === state.turn;
    $('game-title').textContent = r.title;
    $('invite').hidden = state.phase !== 'waiting';
    $('turn').textContent = state.phase === 'waiting' ? 'Waiting for players: ' + state.players.length + '/' + playerCount + ' joined.'
        : state.phase === 'finished' ? result()
        : myIndex === state.turn ? 'Your turn' : state.players[state.turn].name + '’s turn';
    // In group games the active column may be outside the visible part of the sheet.
    $('offline').hidden = connected && state.phase === 'playing' && playerCount === 2;
    $('offline').classList.toggle('group-status', playerCount > 2);
    $('new-game').hidden = state.phase !== 'finished';

    let dice = [...$('dice').children];
    if (dice.length !== r.dice) {
        const faces = [1, 2, 3, 4, 5, 6].map(v =>
            '<div class="face f' + v + '">' + PIPS[v].map(p => '<i class="p' + p + '"></i>').join('') + '</div>').join('')
            + '<div class="core"></div><div class="core x"></div><div class="core y"></div>';
        $('dice').innerHTML = ('<div class="die" role="button" tabindex="0"><div class="cube">' + faces
            + '</div><span class="tag keep-tag">Keep</span></div>').repeat(r.dice);
        dice = [...$('dice').children];
        spins = Array.from({ length: r.dice }, () => [0, 0]);
        dice.forEach((die, i) => {
            die.onclick = () => { if (!busy && die.getAttribute('aria-disabled') === 'false') action({ type: 'hold', die: i }); };
            die.onkeydown = event => {
                if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); die.click(); }
            };
        });
    }
    const newRoll = state.rolled && (!display || !display.rolled || display.turn !== state.turn || state.rolls < display.rolls);
    const reset = !state.rolled && (!display || display.rolled || display.turn !== state.turn);
    if (newRoll) {
        animating = true;
        clearTimeout(animationTimer);
        animationTimer = setTimeout(finishAnimation, 700 + r.dice * 45);
    }
    dice.forEach((die, i) => {
        const cube = die.firstElementChild;
        die.classList.toggle('keep', state.held[i]);
        die.setAttribute('aria-label', 'Die ' + (i + 1) + ': ' + (state.rolled ? state.dice[i] : 'unrolled'));
        die.setAttribute('aria-pressed', String(state.held[i]));
        die.setAttribute('aria-disabled', String(!mine || animating || !state.rolled || state.rolls === 0));
        if (reset) {
            spins[i] = [0, 0];
            cube.style.transition = 'none';
            cube.style.transitionDelay = '0ms';
            cube.style.transform = TILT;
            void cube.offsetWidth;
            cube.style.transition = '';
        } else if (newRoll && (!state.held[i] || !display)) {
            const [rx, ry] = REST[state.dice[i]];
            spins[i][0] += 1 + Math.round(Math.random());
            spins[i][1] += 1 + Math.round(Math.random());
            cube.style.transitionDelay = i * 45 + 'ms';
            cube.style.transform = DEPTH + ' rotateX(' + (rx + 360 * spins[i][0]) + 'deg) rotateY(' + (ry + 360 * spins[i][1]) + 'deg)';
        }
    });
    display = { rolled: state.rolled, rolls: state.rolls, turn: state.turn };
    $('roll').disabled = !mine || animating || !state.rolls || state.held.every(Boolean);

    // Your score stays in the original Player column on either device.
    const seats = [myIndex, ...Array.from({ length: playerCount }, (_, i) => i).filter(i => i !== myIndex)];
    $('sheet').classList.toggle('group-game', playerCount > 2);
    const header = $('brand').parentElement;
    if (header.children.length !== seats.length + 1) {
        while (header.children.length > 1) header.lastElementChild.remove();
        seats.forEach((_, column) => {
            const th = document.createElement('th'); th.id = 'player-' + column; th.scope = 'col'; header.append(th);
        });
    }
    if ($('rolls').children.length !== seats.length) {
        $('rolls').replaceChildren(...seats.map((_, column) => {
            const counter = document.createElement('span'), name = document.createElement('span'), chips = document.createElement('b');
            name.id = 'roll-name-' + column; chips.id = 'chips-' + column;
            counter.append(name, ' rolls ', chips); return counter;
        }));
    }
    state.players.forEach((p, i) => {
        const changed = p.mask & ~(previousMasks[i] || 0);
        if (changed) latest[i] = Math.log2(changed);
        previousMasks[i] = p.mask;
    });
    seats.forEach((seat, column) => {
        const p = state.players[seat], name = p ? p.name : 'Player ' + (seat + 1);
        $('player-' + column).textContent = name;
        $('player-' + column).classList.toggle('turn', state.phase === 'playing' && state.turn === seat);
        $('roll-name-' + column).textContent = name;
        const rolls = p ? (state.phase === 'playing' && seat === state.turn ? state.rolls : p.extra) : 0;
        $('chips-' + column).innerHTML = '<i></i>'.repeat(Math.min(rolls, 5)) + '<em>×' + rolls + '</em>';
    });
    const active = state.players[state.turn];
    const placement = state.rolled ? r.placements(r.rollId(state.dice), active.mask, active.alikeScored) : null;
    const rows = [];
    const tally = (label, value, rule = false) => {
        const tr = document.createElement('tr'); tr.className = 'tally' + (rule ? ' rule' : '');
        for (const text of [label, ...seats.map(seat => state.players[seat] ? value(state.players[seat]) : '')]) {
            const td = document.createElement('td'); td.textContent = text; tr.append(td);
        }
        rows.push(tr);
    };
    const lastUpper = r.cells.reduce((last, cell, i) => cell.bonus ? i : last, -1);
    r.cells.forEach((cell, i) => {
        if (i === lastUpper + 1) {
            tally('Sum', p => {
                const pace = r.cells.reduce((sum, c, n) => sum + (c.bonus && (p.mask & (1 << n)) ? r.bonusTarget / 21 * (c.a + 1) : 0), 0);
                const diff = p.upper - pace;
                return p.upper + ' (' + (diff > 0 ? '+' : '') + diff + ')';
            }, true);
            tally('Bonus', p => p.bonus);
        }
        const row = document.createElement('tr');
        if (i === lastUpper + 1) row.className = 'rule';
        const cat = document.createElement('td'); cat.className = 'cat';
        const label = document.createElement('div'), name = document.createElement('span'), pips = document.createElement('b');
        name.textContent = cell.label;
        pips.textContent = [...cell.pips].map(v => String.fromCharCode(9855 + Number(v))).join('');
        label.append(name, pips); cat.append(label); row.append(cat);
        seats.forEach((seat, column) => {
            const td = document.createElement('td'), p = state.players[seat];
            const used = p && p.cells[i] !== null;
            const allowed = column === 0 && mine && !animating && placement && (placement.legal & (1 << i));
            td.className = column === 0 ? 'pick' : 'bot' + (latest[seat] === i ? ' latest' : '');
            if (used) td.textContent = p.cells[i];
            else if (allowed) {
                const points = placement.scores[i] + placement.bonus;
                td.textContent = points || '';
                td.classList.toggle('preview', points !== 0);
                td.setAttribute('role', 'button'); td.tabIndex = 0;
                td.setAttribute('aria-label', 'Score ' + points + ' in ' + cell.label);
                td.onclick = () => { if (!busy) action({ type: 'score', cell: i }); };
                td.onkeydown = event => {
                    if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); td.click(); }
                };
            } else if (column === 0 && mine && !used && placement && !(placement.legal & (1 << i))) {
                td.classList.add('barred');
            } else if (column !== 0 && seat === state.turn && !animating && !used && placement && (placement.legal & (1 << i))) {
                const points = placement.scores[i] + placement.bonus;
                if (points > 0) {
                    td.textContent = points;
                    td.classList.add('preview');
                }
            }
            row.append(td);
        });
        rows.push(row);
    });
    tally('Sum', p => p.score + p.bonus, true);
    $('scores').replaceChildren(...rows);
}
function result() {
    const totals = state.players.map(p => p.score + p.bonus);
    const best = Math.max(...totals);
    const winners = state.players.filter((_, i) => totals[i] === best).map(p => p.name);
    return winners.length === 1 ? `${winners[0]} wins! ${best} points.` : `${winners.join(', ')} tie for first! ${best} points each.`;
}
async function action(data) {
    if (busy || !connected) return;
    busy = true;
    if (data.type === 'hold') state.held[data.die] = !state.held[data.die];
    render(); message();
    try {
        const next = await request(`/api/rooms/${roomId}/action`, { ...data, revision: state.revision });
        if (next.revision >= state.revision) state = { ...next, you: state.you };
    } catch (error) {
        if (data.type === 'hold') state.held[data.die] = !state.held[data.die];
        message(error.message);
    } finally { busy = false; render(); }
}
$('setup').onsubmit = async event => {
    event.preventDefault(); $('submit').disabled = true; message();
    try {
        const data = await request(roomId ? `/api/rooms/${roomId}/join` : '/api/rooms', { name: $('name').value, variant: $('variant').value, playerCount: Number($('player-count').value) });
        roomId = data.id; saveCredential(data.token);
        history.replaceState(null, '', `?room=${roomId}`); connect();
    } catch (error) { message(error.message); }
    finally { $('submit').disabled = false; }
};
$('roll').onclick = () => { $('roll').disabled = true; action({ type: 'roll' }); };
$('copy').onclick = async () => {
    try { await navigator.clipboard.writeText($('invite-url').value); $('copy').textContent = 'Copied!'; }
    catch { $('invite-url').select(); message('Copy the selected invite link and send it to your friends.'); }
};
if (roomId && !/^[a-f0-9]{12}$/.test(roomId)) { message('That invite link is invalid. Create a new room.'); roomId = null; }
if (roomId) {
    try { credential = localStorage.getItem(storageKey()); } catch { /* Joining still works without storage. */ }
    if (credential) connect();
    else { $('lobby-title').textContent = 'Join your friends'; $('variant-label').hidden = true; $('player-count-label').hidden = true; $('submit').textContent = 'Join game'; $('setup-note').textContent = 'Enter your name to join the room.'; }
}
