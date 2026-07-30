/* Scoring rules, roll indexing and score tables — all computed at load time.

   This is a transcription of src/variant.c and score_cell() in src/yatzy.c.
   The roll ids it produces are what the solver service uses to look up a
   position, so they MUST agree with the C exactly. tools/check_rules.js diffs
   this against the solver's own tables; run it after touching either side.

   Building the tables is ~500 multiset ranks and takes well under a
   millisecond, which is why these are computed rather than shipped as data. */

const CK = {
    FACE_SUM: 'faceSum',      // a = face index (0-based)
    N_PAIRS: 'nPairs',        // a = number of distinct faces needed with count >= 2
    N_OF_A_KIND: 'nOfAKind',  // a = multiplicity needed on a single face
    TWO_GROUPS: 'twoGroups',  // a, b = multiplicities on two *distinct* faces
    STRAIGHT: 'straight',     // a = run length, b = required first face (-1 = any)
    CHANCE: 'chance',
    ALL_ALIKE: 'allAlike',
};

const SM = {
    PATTERN: 'pattern',   // sum of the dice forming the pattern (Nordic style)
    SUM_ALL: 'sumAll',    // sum of all dice (Yahtzee 3/4-of-a-kind)
    FIXED: 'fixed',       // the constant in .fixed
};

/* Cell tables. The ORDER defines each cell's bit in the table_state bitmask
   and its slot in the solver's reply, so it must match src/variant.c exactly.
   `pips` is presentation only: the example dice shown next to the name. */

const VARIANTS = {
    maxi: {
        name: 'maxi', title: 'Maxi Yatzy',
        dice: 6, faces: 6, rollsPerTurn: 3, banksRolls: true,
        bonusTarget: 84, bonusPoints: 100,
        jokerRule: false, extraAllAlikeBonus: 0,
        cells: [
            { label: 'Ones', pips: '111111', kind: CK.FACE_SUM, mode: SM.PATTERN, a: 0, bonus: 1 },
            { label: 'Twos', pips: '222222', kind: CK.FACE_SUM, mode: SM.PATTERN, a: 1, bonus: 1 },
            { label: 'Threes', pips: '333333', kind: CK.FACE_SUM, mode: SM.PATTERN, a: 2, bonus: 1 },
            { label: 'Fours', pips: '444444', kind: CK.FACE_SUM, mode: SM.PATTERN, a: 3, bonus: 1 },
            { label: 'Fives', pips: '555555', kind: CK.FACE_SUM, mode: SM.PATTERN, a: 4, bonus: 1 },
            { label: 'Sixes', pips: '666666', kind: CK.FACE_SUM, mode: SM.PATTERN, a: 5, bonus: 1 },

            { label: 'One Pair', pips: '66', kind: CK.N_PAIRS, mode: SM.PATTERN, a: 1 },
            { label: 'Two Pairs', pips: '5566', kind: CK.N_PAIRS, mode: SM.PATTERN, a: 2 },
            { label: 'Three Pairs', pips: '445566', kind: CK.N_PAIRS, mode: SM.PATTERN, a: 3 },

            { label: 'Three of a Kind', pips: '666', kind: CK.N_OF_A_KIND, mode: SM.PATTERN, a: 3 },
            { label: 'Four of a Kind', pips: '6666', kind: CK.N_OF_A_KIND, mode: SM.PATTERN, a: 4 },
            { label: 'Five of a Kind', pips: '66666', kind: CK.N_OF_A_KIND, mode: SM.PATTERN, a: 5 },

            /* SM_PATTERN on a straight sums the faces in the run: 15 / 20 / 21. */
            { label: 'Small Straight', pips: '12345', kind: CK.STRAIGHT, mode: SM.PATTERN, a: 5, b: 0 },
            { label: 'Large Straight', pips: '23456', kind: CK.STRAIGHT, mode: SM.PATTERN, a: 5, b: 1 },
            { label: 'Full Straight', pips: '123456', kind: CK.STRAIGHT, mode: SM.PATTERN, a: 6, b: 0 },

            { label: 'Full House', pips: '55666', kind: CK.TWO_GROUPS, mode: SM.PATTERN, a: 2, b: 3 },
            { label: 'Castle', pips: '555666', kind: CK.TWO_GROUPS, mode: SM.PATTERN, a: 3, b: 3, exact: 1 },
            { label: 'Tower', pips: '556666', kind: CK.TWO_GROUPS, mode: SM.PATTERN, a: 2, b: 4, exact: 1 },

            { label: 'Chance', pips: '666666', kind: CK.CHANCE, mode: SM.SUM_ALL },
            { label: 'Maxi Yatzy', pips: '666666', kind: CK.ALL_ALIKE, mode: SM.FIXED, fixed: 100 },
        ],
    },

    yatzy: {
        name: 'yatzy', title: 'Yatzy',
        dice: 5, faces: 6, rollsPerTurn: 3, banksRolls: false,
        bonusTarget: 63, bonusPoints: 50,
        jokerRule: false, extraAllAlikeBonus: 0,
        cells: [
            { label: 'Ones', pips: '11111', kind: CK.FACE_SUM, mode: SM.PATTERN, a: 0, bonus: 1 },
            { label: 'Twos', pips: '22222', kind: CK.FACE_SUM, mode: SM.PATTERN, a: 1, bonus: 1 },
            { label: 'Threes', pips: '33333', kind: CK.FACE_SUM, mode: SM.PATTERN, a: 2, bonus: 1 },
            { label: 'Fours', pips: '44444', kind: CK.FACE_SUM, mode: SM.PATTERN, a: 3, bonus: 1 },
            { label: 'Fives', pips: '55555', kind: CK.FACE_SUM, mode: SM.PATTERN, a: 4, bonus: 1 },
            { label: 'Sixes', pips: '66666', kind: CK.FACE_SUM, mode: SM.PATTERN, a: 5, bonus: 1 },

            { label: 'One Pair', pips: '66', kind: CK.N_PAIRS, mode: SM.PATTERN, a: 1 },
            { label: 'Two Pairs', pips: '5566', kind: CK.N_PAIRS, mode: SM.PATTERN, a: 2 },

            { label: 'Three of a Kind', pips: '666', kind: CK.N_OF_A_KIND, mode: SM.PATTERN, a: 3 },
            { label: 'Four of a Kind', pips: '6666', kind: CK.N_OF_A_KIND, mode: SM.PATTERN, a: 4 },

            { label: 'Small Straight', pips: '12345', kind: CK.STRAIGHT, mode: SM.PATTERN, a: 5, b: 0 },
            { label: 'Large Straight', pips: '23456', kind: CK.STRAIGHT, mode: SM.PATTERN, a: 5, b: 1 },

            { label: 'Full House', pips: '55666', kind: CK.TWO_GROUPS, mode: SM.PATTERN, a: 2, b: 3, exact: 1 },
            { label: 'Chance', pips: '66666', kind: CK.CHANCE, mode: SM.SUM_ALL },
            { label: 'Yatzy', pips: '66666', kind: CK.ALL_ALIKE, mode: SM.FIXED, fixed: 50 },
        ],
    },

    yahtzee: {
        name: 'yahtzee', title: 'Yahtzee',
        dice: 5, faces: 6, rollsPerTurn: 3, banksRolls: false,
        bonusTarget: 63, bonusPoints: 35,
        jokerRule: true, extraAllAlikeBonus: 100,
        cells: [
            { label: 'Aces', pips: '11111', kind: CK.FACE_SUM, mode: SM.PATTERN, a: 0, bonus: 1 },
            { label: 'Twos', pips: '22222', kind: CK.FACE_SUM, mode: SM.PATTERN, a: 1, bonus: 1 },
            { label: 'Threes', pips: '33333', kind: CK.FACE_SUM, mode: SM.PATTERN, a: 2, bonus: 1 },
            { label: 'Fours', pips: '44444', kind: CK.FACE_SUM, mode: SM.PATTERN, a: 3, bonus: 1 },
            { label: 'Fives', pips: '55555', kind: CK.FACE_SUM, mode: SM.PATTERN, a: 4, bonus: 1 },
            { label: 'Sixes', pips: '66666', kind: CK.FACE_SUM, mode: SM.PATTERN, a: 5, bonus: 1 },

            { label: 'Three of a Kind', pips: '666', kind: CK.N_OF_A_KIND, mode: SM.SUM_ALL, a: 3 },
            { label: 'Four of a Kind', pips: '6666', kind: CK.N_OF_A_KIND, mode: SM.SUM_ALL, a: 4 },

            { label: 'Full House', pips: '55666', kind: CK.TWO_GROUPS, mode: SM.FIXED, a: 2, b: 3, exact: 1, fixed: 25 },
            { label: 'Small Straight', pips: '1234', kind: CK.STRAIGHT, mode: SM.FIXED, a: 4, b: -1, fixed: 30 },
            { label: 'Large Straight', pips: '12345', kind: CK.STRAIGHT, mode: SM.FIXED, a: 5, b: -1, fixed: 40 },

            { label: 'Chance', pips: '66666', kind: CK.CHANCE, mode: SM.SUM_ALL },
            { label: 'Yahtzee', pips: '66666', kind: CK.ALL_ALIKE, mode: SM.FIXED, fixed: 50 },
        ],
    },
};

// --- multiset indexing (mirrors src/multiset.c) ------------------------------

function binom(n, k) {
    if (k < 0 || n < 0 || k > n) return 0;
    if (k > n - k) k = n - k;

    // After step i the running value is exactly C(n - k + i, i), so the
    // division is always exact and stays well inside a double.
    let r = 1;
    for (let i = 1; i <= k; i++) r = Math.round(r * (n - k + i) / i);
    return r;
}

const msetCount = (faces, k) =>
    faces <= 0 ? (k === 0 ? 1 : 0) : binom(k + faces - 1, faces - 1);

function msetUnrank(rank, faces, k) {
    const counts = new Array(faces).fill(0);

    for (let f = 0; f < faces - 1; f++) {
        let v = 0;
        for (; ;) {
            const block = msetCount(faces - 1 - f, k - v);
            if (rank < block) break;
            rank -= block;
            v++;
        }
        counts[f] = v;
        k -= v;
    }

    counts[faces - 1] = k;
    return counts;
}

// --- scoring (mirrors score_cell() in src/yatzy.c) ---------------------------

const sumAll = counts => counts.reduce((s, c, f) => s + c * (f + 1), 0);

/* Brute force over the candidate face assignments. This runs once per
   (roll, cell) at load, so being obviously correct beats being clever. */
function scoreCell(cell, counts, nDice, nFaces) {
    let matched = 0, found = false;

    switch (cell.kind) {
        case CK.FACE_SUM:
            return counts[cell.a] * (cell.a + 1);

        case CK.CHANCE:
            found = true;
            matched = sumAll(counts);
            break;

        case CK.ALL_ALIKE:
            for (let f = 0; f < nFaces; f++)
                if (counts[f] === nDice) { found = true; matched = nDice * (f + 1); }
            break;

        case CK.N_PAIRS: {
            // Pairs are weighted equally, so take the `a` highest faces with a
            // count of at least two.
            let taken = 0;
            for (let f = nFaces - 1; f >= 0 && taken < cell.a; f--)
                if (counts[f] >= 2) { matched += 2 * (f + 1); taken++; }

            found = (taken === cell.a);
            if (!found) matched = 0;
            break;
        }

        case CK.N_OF_A_KIND:
            for (let f = 0; f < nFaces; f++)
                if (counts[f] >= cell.a) { found = true; matched = cell.a * (f + 1); }
            break;

        case CK.TWO_GROUPS:
            for (let x = 0; x < nFaces; x++)
                for (let y = 0; y < nFaces; y++) {
                    if (x === y) continue;

                    const ok = cell.exact
                        ? (counts[x] === cell.a && counts[y] === cell.b)
                        : (counts[x] >= cell.a && counts[y] >= cell.b);
                    if (!ok) continue;

                    const s = cell.a * (x + 1) + cell.b * (y + 1);
                    if (!found || s > matched) { found = true; matched = s; }
                }
            break;

        case CK.STRAIGHT:
            for (let start = 0; start + cell.a <= nFaces; start++) {
                if (cell.b >= 0 && start !== cell.b) continue;

                let ok = true, s = 0;
                for (let f = start; f < start + cell.a; f++) {
                    ok = ok && counts[f] >= 1;
                    s += f + 1;
                }

                if (ok && (!found || s > matched)) { found = true; matched = s; }
            }
            break;
    }

    if (!found) return 0;

    switch (cell.mode) {
        case SM.PATTERN: return matched;
        case SM.SUM_ALL: return sumAll(counts);
        case SM.FIXED: return cell.fixed;
    }
    return 0;
}

// --- table construction ------------------------------------------------------

/* Dice sorted ascending, three bits per die, face value minus one. This is the
   client's own key for a roll; the solver never sees it. */
function encodeRoll(dice) {
    return [...dice].sort((a, b) => a - b)
        .reduce((key, d, i) => key | (d - 1) << (3 * i), 0);
}

const encodeCounts = counts => {
    let key = 0, i = 0;
    for (let f = 0; f < counts.length; f++)
        for (let c = 0; c < counts[f]; c++) key |= f << (3 * i++);
    return key;
};

function buildRules(variantName) {
    const V = VARIANTS[variantName];
    if (!V) throw new Error(`unknown variant ${variantName}`);

    const nCells = V.cells.length;
    const nRolls = msetCount(V.faces, V.dice);

    const counts = [];        // [rollId] -> face counts
    const score = [];         // [rollId][cell] -> points
    const jokerScore = [];    // [rollId][cell] -> points when the roll is a joker
    const allAlikeFace = [];  // [rollId] -> face if all dice alike, else -1
    const idByKey = new Map();

    for (let r = 0; r < nRolls; r++) {
        const c = msetUnrank(r, V.faces, V.dice);
        counts.push(c);
        idByKey.set(encodeCounts(c), r);
        score.push(V.cells.map(cell => scoreCell(cell, c, V.dice, V.faces)));

        let face = -1;
        for (let f = 0; f < V.faces; f++) if (c[f] === V.dice) face = f;
        allAlikeFace.push(face);
    }

    // Under the joker rule the pattern counts as satisfied, so each cell pays
    // what it would on a matching roll. Only well defined for fixed and
    // sum-of-all-dice cells, which is what every joker variant uses.
    if (V.jokerRule) {
        for (let r = 0; r < nRolls; r++)
            jokerScore.push(V.cells.map((cell, i) =>
                cell.mode === SM.FIXED ? cell.fixed
                    : cell.mode === SM.SUM_ALL ? sumAll(counts[r])
                        : score[r][i]));
    }

    const bonusMask = V.cells.reduce((m, c, i) => c.bonus ? m | (1 << i) : m, 0);
    const allAlikeCell = V.cells.findIndex(c => c.kind === CK.ALL_ALIKE);
    const upperCell = new Array(V.faces).fill(-1);
    V.cells.forEach((c, i) => { if (c.kind === CK.FACE_SUM) upperCell[c.a] = i; });

    let lowerMask = ((1 << nCells) - 1) & ~bonusMask;
    if (allAlikeCell >= 0) lowerMask &= ~(1 << allAlikeCell);

    return {
        ...V, nCells, nRolls,
        counts, score, jokerScore, allAlikeFace,
        bonusMask, lowerMask, allAlikeCell, upperCell,

        rollId: dice => idByKey.get(encodeRoll(dice)),

        /* Where a roll may go, what it pays there, and any bonus on top —
           mirrors yatzy_placements() in src/yatzy.c.

           `alikeScored` says the all-alike box was filled for score rather
           than zeroed, which is what decides whether the extra bonus is paid.

           Without the joker rule this is always "any open cell, normal
           scores, no bonus", so maxi and yatzy never take the second half. */
        placements(rollId, tableState, alikeScored) {
            const open = ~tableState & ((1 << nCells) - 1);
            const plain = { legal: open, scores: score[rollId], bonus: 0 };
            if (!V.jokerRule) return plain;

            const face = allAlikeFace[rollId];
            if (face < 0 || allAlikeCell < 0) return plain;
            if (!(tableState & (1 << allAlikeCell))) return plain;

            // The roll is a joker. The bonus is paid wherever the dice end up,
            // but only if the box was filled for score rather than zeroed.
            const bonus = alikeScored ? V.extraAllAlikeBonus : 0;
            const matching = upperCell[face] >= 0 ? 1 << upperCell[face] : 0;

            // Official rules: the matching upper box, if open, MUST be used —
            // and it pays its normal face-sum score, not a joker score.
            if (open & matching)
                return { legal: matching, scores: score[rollId], bonus };

            // Otherwise any open lower box, scored as if the pattern were met.
            if (open & lowerMask)
                return { legal: open & lowerMask, scores: jokerScore[rollId], bonus };

            // Nothing left but to zero an open upper box.
            return { legal: open & bonusMask, scores: score[rollId], bonus };
        },
    };
}

if (typeof module !== 'undefined') module.exports = { buildRules, VARIANTS, encodeRoll };
