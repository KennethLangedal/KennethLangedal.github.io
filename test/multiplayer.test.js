'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createRoom, joinRoom, act, snapshot, rules } = require('../server/game.js');
const { createServer } = require('../server/index.js');
const start = (variant = 'yatzy') => { const room = createRoom(variant, 'Alice'); joinRoom(room, 'Bob'); return room; };
const move = (room, type, extra = {}, die = () => 6) => act(room, room.turn, { type, revision: room.revision, ...extra }, die);

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
});

test('scores, upper bonus, completed games, ties and filled categories for every variant', () => {
    for (const variant of ['yatzy', 'maxi', 'yahtzee']) {
        const room = start(variant), r = rules.get(variant);
        for (let cell = 0; cell < r.nCells; cell++) for (let player = 0; player < 2; player++) {
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
    joinRoom(room, 'Bob'); assert.throws(() => joinRoom(room, 'Eve'), /two players/);
    assert.ok(!JSON.stringify(snapshot(room)).includes(room.players[0].token));
    assert.throws(() => move(room, 'nonsense'), /Unknown action/);
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
    function eventReader(response) {
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
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
    for (const file of ['/server/index.js', '/.git/config', '/package.json', '/shared/%2e%2e/server/index.js']) assert.equal((await fetch(base + file)).status, 404);
    assert.equal((await post('/api/rooms', null)).status, 400);
    assert.equal((await post('/api/rooms', { name: 'x'.repeat(5000) })).status, 413);
    abort.abort();
});
