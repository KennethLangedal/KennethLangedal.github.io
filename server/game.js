'use strict';
const { randomInt, randomBytes } = require('node:crypto');
const { buildRules } = require('../shared/rules.js');
const rules = new Map(['yatzy', 'maxi', 'yahtzee'].map(v => [v, buildRules(v)]));
const token = () => randomBytes(24).toString('hex');
const emptyScoreSheet = r => ({ cells: Array(r.nCells).fill(null), mask: 0, upper: 0, score: 0, bonus: 0, extra: 0, alikeScored: false });
const player = (name, r) => ({ name: cleanName(name), token: token(), ...emptyScoreSheet(r) });
const freshTurn = (r, extra = 0) => ({
    rolls: r.rollsPerTurn + extra, dice: Array(r.dice).fill(1), held: Array(r.dice).fill(false), rolled: false
});
function check(ok, message) { if (!ok) throw new Error(message); }
function cleanName(value) {
    check(typeof value === 'string' && value.trim().length > 0 && value.trim().length <= 24, 'Enter a name of 1–24 characters.');
    return value.trim();
}
function sortedHoldMask(dice, held) {
    const indices = Array.from({ length: dice.length }, (_, i) => i).sort((a, b) => dice[a] - dice[b]);
    return indices.reduce((m, d, i) => held[d] ? m | (1 << i) : m, 0);
}
function createRoom(variant, name, playerCount = 2) {
    check(rules.has(variant), 'Unknown game variant.');
    check(Number.isInteger(playerCount) && playerCount >= 2 && playerCount <= 5, 'Choose 2–5 players.');
    const r = rules.get(variant);
    return { variant, playerCount, players: [player(name, r)], phase: 'waiting', round: 1, turn: 0,
        ...freshTurn(r), revision: 0, log: [], updated: Date.now() };
}
function joinRoom(room, name) {
    check(room.phase === 'waiting' && room.players.length < room.playerCount, 'This room is full.');
    const p = player(name, rules.get(room.variant));
    room.players.push(p);
    if (room.players.length === room.playerCount) room.phase = 'playing';
    room.revision++; room.updated = Date.now();
    return p;
}
function act(room, index, action, randomDie = () => randomInt(1, 7)) {
    if (action.type !== 'replay') {
        check(room.phase === 'playing', 'The game is not in progress.');
        check(index === room.turn, 'Wait for your turn.');
    }
    check(action.revision === room.revision, 'The game changed. Please try again.');
    const r = rules.get(room.variant), p = room.players[index];
    if (action.type === 'replay') {
        check(index === 0, 'Only the room creator can start a rematch.');
        check(room.phase === 'finished', 'Finish the current game before playing again.');
        for (const player of room.players) Object.assign(player, emptyScoreSheet(r));
        Object.assign(room, freshTurn(r), { phase: 'playing', round: room.round + 1, turn: 0, log: [] });
    } else if (action.type === 'roll') {
        check(room.rolls > 0, 'No rolls left. Choose a score.');
        check(!room.held.every(Boolean), 'Release at least one die to roll.');
        if (room.rolled) {
            room.log.push({
                who: index,
                choice: r.nCells + sortedHoldMask(room.dice, room.held),
                pos: { mask: p.mask, bonus: Math.min(p.upper, r.bonusTarget), rolls: room.rolls, id: r.rollId(room.dice), joker: (r.jokerRule && p.alikeScored) ? 1 : 0 },
                score: p.score,
                dice: [...room.dice]
            });
        }
        room.dice = room.dice.map((d, i) => room.held[i] ? d : randomDie());
        room.rolls--; room.rolled = true;
    } else if (action.type === 'hold') {
        check(room.rolled && room.rolls > 0, 'Roll first, or choose a score.');
        check(Number.isInteger(action.die) && action.die >= 0 && action.die < r.dice, 'Invalid die.');
        room.held[action.die] = !room.held[action.die];
    } else if (action.type === 'score') {
        check(room.rolled, 'Roll before choosing a score.');
        const i = action.cell;
        check(Number.isInteger(i) && i >= 0 && i < r.nCells, 'Invalid category.');
        const placement = r.placements(r.rollId(room.dice), p.mask, p.alikeScored);
        check(Boolean(placement.legal & (1 << i)), 'Choose an available category.');
        room.log.push({
            who: index,
            choice: i,
            pos: { mask: p.mask, bonus: Math.min(p.upper, r.bonusTarget), rolls: room.rolls, id: r.rollId(room.dice), joker: (r.jokerRule && p.alikeScored) ? 1 : 0 },
            score: p.score,
            dice: [...room.dice]
        });
        const points = placement.scores[i];
        p.cells[i] = points + placement.bonus; p.score += p.cells[i]; p.mask |= 1 << i;
        if (i === r.allAlikeCell && points > 0) p.alikeScored = true;
        if (r.bonusMask & (1 << i)) p.upper += points;
        p.bonus = p.upper >= r.bonusTarget ? r.bonusPoints : 0;
        p.extra = r.banksRolls ? room.rolls : 0;
        if (room.players.every(s => s.mask === (1 << r.nCells) - 1)) room.phase = 'finished';
        else {
            room.turn = (index + 1) % room.players.length;
            Object.assign(room, freshTurn(r, room.players[room.turn].extra));
        }
    } else throw new Error('Unknown action.');
    room.revision++; room.updated = Date.now();
}
function snapshot(room) {
    const { updated, players, ...state } = room;
    return { ...state, players: players.map(({ token, ...p }) => p) };
}
module.exports = { createRoom, joinRoom, act, snapshot, rules };
