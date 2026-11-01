'use strict';
const { randomInt, randomBytes } = require('node:crypto');
const { buildRules } = require('../shared/rules.js');
const rules = new Map(['yatzy', 'maxi', 'yahtzee'].map(v => [v, buildRules(v)]));
const token = () => randomBytes(24).toString('hex');
const player = name => ({ name, token: token(), cells: [], mask: 0, upper: 0, score: 0, bonus: 0, extra: 0, alikeScored: false });
function check(ok, message) { if (!ok) throw new Error(message); }
function cleanName(value) {
    check(typeof value === 'string' && value.trim().length > 0 && value.trim().length <= 24, 'Enter a name of 1–24 characters.');
    return value.trim();
}
function createRoom(variant, name) {
    check(rules.has(variant), 'Unknown game variant.');
    const r = rules.get(variant);
    const p = player(cleanName(name)); p.cells = Array(r.nCells).fill(null);
    return { variant, players: [p], phase: 'waiting', turn: 0, rolls: r.rollsPerTurn,
        dice: Array(r.dice).fill(1), held: Array(r.dice).fill(false), rolled: false, revision: 0, updated: Date.now() };
}
function joinRoom(room, name) {
    check(room.phase === 'waiting' && room.players.length === 1, 'This room already has two players.');
    const p = player(cleanName(name)); p.cells = Array(rules.get(room.variant).nCells).fill(null);
    room.players.push(p); room.phase = 'playing'; room.revision++; room.updated = Date.now();
    return p;
}
function act(room, index, action, randomDie = () => randomInt(1, 7)) {
    check(room.phase === 'playing', 'The game is not in progress.');
    check(index === room.turn, 'Wait for your turn.');
    check(action.revision === room.revision, 'The game changed. Please try again.');
    const r = rules.get(room.variant), p = room.players[index];
    if (action.type === 'roll') {
        check(room.rolls > 0, 'No rolls left. Choose a score.');
        check(!room.held.every(Boolean), 'Release at least one die to roll.');
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
        const points = placement.scores[i];
        p.cells[i] = points + placement.bonus; p.score += p.cells[i]; p.mask |= 1 << i;
        if (i === r.allAlikeCell && points > 0) p.alikeScored = true;
        if (r.bonusMask & (1 << i)) p.upper += points;
        p.bonus = p.upper >= r.bonusTarget ? r.bonusPoints : 0;
        p.extra = r.banksRolls ? room.rolls : 0;
        if (room.players.every(s => s.mask === (1 << r.nCells) - 1)) room.phase = 'finished';
        else {
            room.turn = 1 - index;
            room.rolls = r.rollsPerTurn + room.players[room.turn].extra;
            room.rolled = false; room.held.fill(false); room.dice.fill(1);
        }
    } else throw new Error('Unknown action.');
    room.revision++; room.updated = Date.now();
}
function snapshot(room) {
    const { updated, players, ...state } = room;
    return { ...state, players: players.map(({ token, ...p }) => p) };
}
module.exports = { createRoom, joinRoom, act, snapshot, rules };
