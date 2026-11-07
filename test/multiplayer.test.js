'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createRoom, joinRoom, act, snapshot, rules } = require('../server/game.js');
const { createServer } = require('../server/index.js');
const start = (variant = 'yatzy', playerCount = 2) => {
    const room = createRoom(variant, 'Alice', playerCount);
    for (let i = 1; i < playerCount; i++) joinRoom(room, 'Player ' + (i + 1));
    return room;
};
const move = (room, type, extra = {}, die = () => 6) => act(room, room.turn, { type, revision: room.revision, ...extra }, die);
function eventReader(response) {
    const reader = response.body.getReader(), decoder = new TextDecoder();
    let buffer = '';
    return async () => {
        while (!buffer.includes('\n\n')) {
            const { value, done } = await reader.read();
            assert.ok(!done);
            buffer += decoder.decode(value, { stream: true });
        }
        const end = buffer.indexOf('\n\n'), event = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        return JSON.parse(event.slice(6));
    };
}

test('turns, stale requests, held dice and roll limit are enforced', () => {
    const room = start();
    assert.throws(() => act(room, 1, { type: 'roll', revision: room.revision }), /turn/);
    assert.throws(() => move(room, 'score', { cell: 0 }), /Roll before/);
    assert.throws(() => move(room, 'hold', { die: 0 }), /Roll first/);
    move(room, 'roll'); move(room, 'hold', { die: 0 }); move(room, 'roll', {}, () => 1);
    assert.deepEqual(room.dice, [6, 1, 1, 1, 1]);
    assert.throws(() => act(room, 0, { type: 'roll', revision: 0 }), /changed/);
    move(room, 'roll', {}, () => 1); assert.throws(() => move(room, 'roll'), /No rolls/);
    move(room, 'score', { cell: 0 }); assert.equal(room.turn, 1); assert.equal(room.rolls, 3);
    assert.equal(room.players[0].cells[0], 4); assert.equal(room.rolled, false);
    assert.ok(room.held.every(v => !v));
    assert.equal(room.log.length, 3);
    assert.equal(room.log[0].who, 0);
    assert.equal(room.log[2].choice, 0);
});

test('scores, upper bonus, completed games, ties and filled categories for every variant', () => {
    for (const variant of ['yatzy', 'maxi', 'yahtzee']) for (const playerCount of [2, 3, 4, 5]) {
        const room = start(variant, playerCount), r = rules.get(variant);
        for (let cell = 0; cell < r.nCells; cell++) for (let player = 0; player < playerCount; player++) {
            assert.equal(room.turn, player);
            move(room, 'roll', {}, () => cell < 6 ? cell + 1 : 6);
            if (cell > 0) assert.throws(() => move(room, 'score', { cell: 0 }), /available/);
            move(room, 'score', { cell });
        }
        assert.equal(room.phase, 'finished');
        for (const p of room.players) {
            assert.equal(p.upper, r.dice * 21); assert.equal(p.bonus, r.bonusPoints);
            assert.equal(p.mask, (1 << r.nCells) - 1);
            assert.equal(p.score, p.cells.reduce((a, b) => a + b, 0));
        }
        assert.equal(room.players[0].score, room.players[1].score);
        assert.throws(() => move(room, 'roll'), /not in progress/);
    }
});

test('Maxi unused rolls carry to the same player on their next turn', () => {
    const room = start('maxi');
    move(room, 'roll'); move(room, 'score', { cell: 0 });
    assert.equal(room.rolls, 3);
    move(room, 'roll'); move(room, 'score', { cell: 0 });
    assert.equal(room.rolls, 5);
});

test('Yahtzee joker forces matching upper box and awards extra bonus', () => {
    const room = start('yahtzee'), r = rules.get('yahtzee');
    for (let player = 0; player < 2; player++) { move(room, 'roll'); move(room, 'score', { cell: r.allAlikeCell }); }
    move(room, 'roll');
    assert.throws(() => move(room, 'score', { cell: 0 }), /available/);
    move(room, 'score', { cell: 5 });
    assert.equal(room.players[0].cells[5], 130); assert.equal(room.players[0].upper, 30);
});

test('room validation, full rooms and public snapshots never expose tokens', () => {
    assert.throws(() => createRoom('unknown', 'Alice'), /variant/);
    assert.throws(() => createRoom('yatzy', ' '), /name/);
    const room = createRoom('yatzy', '<b>Alice</b>');
    assert.throws(() => move(room, 'roll'), /not in progress/);
    joinRoom(room, 'Bob'); assert.throws(() => joinRoom(room, 'Eve'), /full/);
    assert.ok(!JSON.stringify(snapshot(room)).includes(room.players[0].token));
    assert.throws(() => move(room, 'nonsense'), /Unknown action/);
});

test('five-player rooms wait for every seat, reject overflow and validate the player count', () => {
    for (const count of [0, 1, 6, 2.5, '5', null]) assert.throws(() => createRoom('maxi', 'Alice', count), /2–5/);
    assert.equal(createRoom('maxi', 'Alice').playerCount, 2);
    const room = createRoom('maxi', 'Alice', 5);
    for (let i = 1; i < 5; i++) {
        assert.equal(room.phase, 'waiting');
        assert.throws(() => move(room, 'roll'), /not in progress/);
        joinRoom(room, 'Player ' + (i + 1));
    }
    assert.equal(room.phase, 'playing');
    assert.throws(() => joinRoom(room, 'Sixth player'), /full/);
    for (const p of room.players) assert.ok(!JSON.stringify(snapshot(room)).includes(p.token));
});

test('five Maxi players keep their own bank of rolls and wrap back to the first player', () => {
    const room = start('maxi', 5);
    for (let player = 0; player < 5; player++) {
        assert.equal(room.turn, player);
        assert.equal(room.rolls, 3);
        for (let roll = 0; roll < (player % 3) + 1; roll++) move(room, 'roll');
        move(room, 'score', { cell: 0 });
    }
    assert.equal(room.turn, 0);
    for (let player = 0; player < 5; player++) {
        assert.equal(room.turn, player);
        assert.equal(room.rolls, 3 + 2 - player % 3);
        const before = JSON.stringify(snapshot(room));
        assert.throws(() => act(room, (player + 1) % 5, { type: 'roll', revision: room.revision }), /turn/);
        assert.equal(JSON.stringify(snapshot(room)), before);
        move(room, 'roll'); move(room, 'score', { cell: 1 });
    }
    assert.equal(room.turn, 0);
});

test('HTTP room lifecycle, authentication, SSE sync, reload and public file isolation', async t => {
    const server = createServer();
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => { server.closeAllConnections(); server.close(); });
    const base = `http://127.0.0.1:${server.address().port}`;
    const post = (url, body, token) => fetch(base + url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
    const created = await post('/api/rooms', { name: 'Alice', variant: 'yatzy' });
    assert.equal(created.status, 201);
    const { id, token } = await created.json();
    const endpoint = `/api/rooms/${id}`;
    assert.equal((await post(endpoint + '/action', { type: 'roll' })).status, 401);
    assert.equal((await fetch(base + endpoint + '/events?token=wrong')).status, 401);
    const abort = new AbortController(); t.after(() => abort.abort());
    const events = await fetch(base + endpoint + '/events?token=' + token, { signal: abort.signal });
    assert.equal(events.headers.get('content-type'), 'text/event-stream');
    const nextEvent = eventReader(events);
    const initial = await nextEvent(); assert.equal(initial.you, 0); assert.equal(initial.phase, 'waiting');
    const guest = await (await post(endpoint + '/join', { name: 'Bob' })).json();
    const joined = await nextEvent(); assert.equal(joined.phase, 'playing');
    assert.ok(!JSON.stringify(joined).includes(guest.token));
    const guestEvents = await fetch(base + endpoint + '/events?token=' + guest.token, { signal: abort.signal });
    const nextGuestEvent = eventReader(guestEvents);
    assert.deepEqual(await nextGuestEvent(), { ...joined, you: 1 });
    assert.equal((await post(endpoint + '/join', { name: 'Eve' })).status, 400);
    assert.equal((await post(endpoint + '/action', { type: 'roll', revision: joined.revision }, guest.token)).status, 400);
    assert.equal((await post(endpoint + '/action', { type: 'roll', revision: joined.revision }, token)).status, 200);
    const rolled = await nextEvent(); assert.equal(rolled.rolled, true); assert.equal(rolled.rolls, 2);
    assert.deepEqual(await nextGuestEvent(), { ...rolled, you: 1 });
    assert.equal((await post(endpoint + '/action', { type: 'hold', die: 0, revision: rolled.revision }, token)).status, 200);
    const held = await nextEvent();
    assert.equal(held.held[0], true);
    assert.deepEqual(await nextGuestEvent(), { ...held, you: 1 });
    assert.equal((await post(endpoint + '/action', { type: 'score', cell: 0, revision: held.revision }, token)).status, 200);
    const scored = await nextEvent();
    assert.equal(scored.turn, 1);
    assert.notEqual(scored.players[0].cells[0], null);
    assert.deepEqual(await nextGuestEvent(), { ...scored, you: 1 });
    const restored = await (await fetch(base + endpoint, { headers: { Authorization: `Bearer ${guest.token}` } })).json();
    assert.deepEqual(restored, { ...scored, you: 1 });
    assert.equal((await fetch(base + '/multiplayer/')).status, 200);
    assert.equal((await fetch(base + '/multiplayer/analysis.js')).status, 200);
    assert.ok(Array.isArray(restored.log) && restored.log.length > 0);
    for (const file of ['/server/index.js', '/.git/config', '/package.json', '/shared/%2e%2e/server/index.js']) assert.equal((await fetch(base + file)).status, 404);
    assert.equal((await post('/api/rooms', null)).status, 400);
    assert.equal((await post('/api/rooms', { name: 'x'.repeat(5000) })).status, 413);
    abort.abort();
});

test('five authenticated players receive live rolls and scores, restore their seats and rotate turns', { timeout: 10000 }, async t => {
    const server = createServer();
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const abort = new AbortController();
    t.after(() => { abort.abort(); server.closeAllConnections(); server.close(); });
    const base = `http://127.0.0.1:${server.address().port}`;
    const post = (path, body, token) => fetch(base + path, {
        method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body)
    });
    assert.equal((await post('/api/rooms', { name: 'Alice', variant: 'maxi', playerCount: 6 })).status, 400);
    const created = await post('/api/rooms', { name: 'Alice', variant: 'maxi', playerCount: 5 });
    assert.equal(created.status, 201);
    const { id, token } = await created.json(), endpoint = '/api/rooms/' + id, tokens = [token];
    const get = token => fetch(base + endpoint, { headers: { Authorization: 'Bearer ' + token } }).then(r => r.json());
    for (let player = 1; player < 5; player++) {
        const waiting = await get(token);
        assert.equal(waiting.phase, 'waiting');
        assert.equal(waiting.players.length, player);
        assert.equal((await post(endpoint + '/action', { type: 'roll', revision: waiting.revision }, token)).status, 400);
        const joined = await post(endpoint + '/join', { name: 'Player ' + (player + 1) });
        assert.equal(joined.status, 200); tokens.push((await joined.json()).token);
    }
    assert.equal((await post(endpoint + '/join', { name: 'Sixth' })).status, 400);
    const readers = await Promise.all(tokens.map(async playerToken => {
        const response = await fetch(base + endpoint + '/events?token=' + playerToken, { signal: abort.signal });
        assert.equal(response.status, 200);
        return eventReader(response);
    }));
    async function readAll() {
        const states = await Promise.all(readers.map(read => read()));
        states.forEach((state, you) => {
            assert.deepEqual(state, { ...states[0], you });
            for (const secret of tokens) assert.ok(!JSON.stringify(state).includes(secret));
        });
        return states[0];
    }
    let current = await readAll();
    assert.equal(current.phase, 'playing'); assert.equal(current.playerCount, 5);
    for (let player = 0; player < 5; player++) {
        assert.equal(current.turn, player);
        assert.equal((await post(endpoint + '/action', { type: 'roll', revision: current.revision }, tokens[(player + 1) % 5])).status, 400);
        assert.equal((await post(endpoint + '/action', { type: 'roll', revision: current.revision }, tokens[player])).status, 200);
        current = await readAll(); assert.equal(current.rolled, true);
        assert.equal((await post(endpoint + '/action', { type: 'score', cell: 0, revision: current.revision }, tokens[player])).status, 200);
        current = await readAll(); assert.notEqual(current.players[player].cells[0], null);
    }
    assert.equal(current.turn, 0); assert.equal(current.rolls, 5);
    for (let player = 0; player < 5; player++) assert.deepEqual(await get(tokens[player]), { ...current, you: player });
});
