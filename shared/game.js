/* The game itself: score sheet, dice, and the robot opponent.

   Nothing here is specific to one variant. Everything that differs between
   Maxi Yatzy, Yatzy and Yahtzee — dice count, categories, scoring, the bonus,
   whether unused rolls carry over, the joker rule — comes out of buildRules()
   in rules.js. Each variant's index.html sets VARIANT before loading this.

   Expected values come from the solver service in fetchEV(). */

const R = buildRules(VARIANT);

const $ = id => document.getElementById(id);
const N = R.dice;                  // dice in play
const C = R.nCells;                // scoring categories
const HOLDS = 1 << N;              // hold masks the solver reports on
const FULL = (1 << C) - 1;         // every category filled
const ALL_HELD = HOLDS - 1;

const ROLL_MS = 700;               // must match the .cube transition in styles.css
const RETRIES = 1;                 // extra solver attempts before calling it down
const RETRY_MS = 400;
const SOLVER = `${SOLVER_HOST}/${R.name}`;

/* The solver's reply is C + HOLDS numbers: one per category, then one per hold
   mask. These name the two halves so the offsets never appear as literals. */
const holdAt = mask => C + mask;

// Which of the 3x3 pip slots each face uses, as row-column pairs.
const PIPS = {
    1: [22], 2: [11, 33], 3: [11, 22, 33],
    4: [11, 13, 31, 33], 5: [11, 13, 22, 31, 33], 6: [11, 13, 21, 23, 31, 33],
};

// Cube rotation that brings each value to the front, in [rotateX, rotateY].
const REST = { 1: [0, 0], 2: [90, 0], 3: [0, 90], 4: [0, -90], 5: [-90, 0], 6: [0, 180] };

const DEPTH = 'translateZ(calc(var(--die) * -0.5))';
const TILT = `${DEPTH} rotateX(-24deg) rotateY(-32deg)`;   // resting corner-on view

const glyph = v => String.fromCharCode(9855 + +v);         // 1..6 -> ⚀..⚅
const pips = s => [...s].map(glyph).join('');

/* Dice of each face needed to hit the bonus exactly on pace: the target split
   evenly over the upper section, which is 84/21 = 4 for Maxi Yatzy and
   63/21 = 3 for the five-dice variants. The sheet shows the running deviation
   from this, so "+2" means two points ahead of the bonus pace. */
const BONUS_PACE = R.bonusTarget / (R.faces * (R.faces + 1) / 2);

// --- build the page ---------------------------------------------------------

document.title = `${R.title} Solver`;

const totalRow = (name, key, rule) => `<tr class="tally${rule ? ' rule' : ''}">
    <td>${name}</td><td id="human-${key}"></td><td id="robot-${key}"></td></tr>`;

// The upper section is closed off after the last bonus-scoring category.
const lastUpper = R.cells.reduce((last, c, i) => c.bonus ? i : last, -1);

$('rows').innerHTML = R.cells.map((cell, i) =>
    (i === lastUpper + 1 ? totalRow('Sum', 'upper', 1) + totalRow('Bonus', 'bonus') : '') +
    `<tr class="${i === lastUpper + 1 ? 'rule' : ''}">
        <td class="cat"><div><span>${cell.label}</span><b>${pips(cell.pips)}</b></div></td>
        <td class="pick" data-i="${i}"></td><td class="bot"></td></tr>`
).join('') + totalRow('Sum', 'total', 1);

const faces = [1, 2, 3, 4, 5, 6].map(v =>
    `<div class="face f${v}">${PIPS[v].map(p => `<i class="p${p}"></i>`).join('')}</div>`).join('') +
    '<div class="core"></div><div class="core x"></div><div class="core y"></div>';

$('dice').innerHTML = `<div class="die"><div class="cube">${faces}</div>
    <span class="tag keep-tag">Keep</span><span class="tag best-tag">Best</span></div>`.repeat(N);

const dieEls = [...document.querySelectorAll('.die')];
const cubes = dieEls.map(d => d.firstElementChild);
const picks = [...document.querySelectorAll('td.pick')];
const bots = [...document.querySelectorAll('td.bot')];
const evToggle = $('ev-toggle'), rollBtn = $('roll'), bestBtn = $('best-btn'), panel = $('ev-panel');

// --- state ------------------------------------------------------------------

const newSide = () => ({
    score: 0, upper: 0, diff: 0, bonus: 0,
    target: R.bonusTarget,         // points still needed for the bonus
    mask: 0,                       // which categories are filled in
    cells: Array(C).fill(0),
    extra: 0,                      // rolls carried into the next turn
    last: -1,
    alikeScored: false,            // the all-alike box was filled for score
});

const G = {
    turn: 'human', rolls: R.rollsPerTurn, rolled: false, scored: false,
    dice: Array(N).fill(1),
    gameId: null, startEV: null, lastHold: -1,
    human: newSide(), robot: newSide(),
};

// Answers are cached by position, so the post-game analysis mostly re-reads
// what play already fetched instead of asking the solver again.
const evCache = new Map();

// One entry per decision by either player, holding just enough to price it
// against the solver afterwards. See analysis.js.
const log = [];
const record = (who, side, choice) => log.push({
    who, choice, pos: posOf(side, G.rolls), score: side.score, dice: [...G.dice],
});

let ev = null;                     // expected values for the human's position
let evBusy = false;
let solverDown = false;
let token = 0;                     // invalidates EV requests that are now stale

// --- rules helpers ----------------------------------------------------------

/* Where the current roll may go for this player, what it pays, and any bonus.
   Only the joker rule makes this interesting; without it every open category
   is legal at face value. */
const placementsFor = side =>
    R.placements(R.rollId(G.dice), side.mask, side.alikeScored);

// --- solver -----------------------------------------------------------------

/* Everything that identifies a decision point to the solver.

   `joker` says the all-alike box was filled FOR SCORE rather than zeroed, which
   is what makes later all-alike rolls worth an extra bonus. The solver keeps
   both cases as separate positions, so leaving it out does not merely lose the
   bonus -- it asks about a different game, one where the box was zeroed. On
   Yahtzee that is worth around 130 points at the moment a second Yahtzee lands,
   and the robot has no reason to chase one. */
const posOf = (side, rolls) => ({
    mask: side.mask, bonus: R.bonusTarget - side.target, rolls,
    id: R.rollId(G.dice),
    joker: (R.jokerRule && side.alikeScored) ? 1 : 0,
});

// The joker flag has to be part of the cache key too: the same sheet reached
// with the box scored and with it zeroed are different positions with different
// answers, and without this one would be served from the other's cache entry.
const posKey = p => `${p.mask}|${p.bonus}|${p.rolls}|${p.id}|${p.joker}`;

/* Returns C + HOLDS floats: the EV of scoring each category, then the EV of
   each hold, indexed by a bitmask over the dice sorted by value. Each value
   covers the rest of the game including the bonus, so adding the points
   already banked turns it into a projected final total. */
async function fetchEV(pos, track) {
    // The game id and hold are for the server's log only; they never change
    // the numbers that come back, so a missing or stale id is harmless.
    const tag = track && G.gameId
        ? `&g=${G.gameId}` + (G.lastHold >= 0 ? `&hold=${G.lastHold}` : '')
        : '';
    // joker is only sent when set: the service rejects joker=1 on a sheet whose
    // all-alike box is still open, and omitting it means the same as zero.
    const joker = pos.joker ? '&joker=1' : '';
    const res = await fetch(SOLVER +
        `/?table=${pos.mask}&bonus=${pos.bonus}&rolls=${pos.rolls}&id=${pos.id}${joker}${tag}`);
    if (!res.ok) throw new Error(`solver returned ${res.status}`);
    return [...new Float64Array(await res.arrayBuffer())];
}

// Asks the server for a game id and the true start-of-game expectation. Purely
// optional: if it fails the game plays exactly as before, just untracked.
async function newGame() {
    G.gameId = null;
    G.startEV = null;
    try {
        const res = await fetch(SOLVER + '/new');
        if (!res.ok) return;
        const d = await res.json();
        G.gameId = d.game;
        G.startEV = d.ev;
    } catch (err) {
        console.info('tracking unavailable:', err);
    }
}

// Every solver call goes through here, so one dropped request can't strand the
// game. Returns null once it has given up, and tracks reachability so the page
// can say so. Recovers on its own as soon as a later call gets through.
async function askSolver(pos, track) {
    const key = posKey(pos);
    if (evCache.has(key)) return evCache.get(key);
    for (let attempt = 0; attempt <= RETRIES; attempt++) {
        try {
            const data = await fetchEV(pos, track);
            evCache.set(key, data);
            setSolverDown(false);
            return data;
        } catch (err) {
            if (attempt === RETRIES) console.error('EV unavailable:', err);
            // Deliberately not the skippable sleep(): a tap should not cut this.
            else await new Promise(done => setTimeout(done, RETRY_MS));
        }
    }
    setSolverDown(true);
    return null;
}

function setSolverDown(down) {
    if (down === solverDown) return;
    solverDown = down;
    render();
}

async function loadEV() {
    if (G.turn !== 'human' || !G.rolled) { ev = null; return render(); }
    const mine = token;
    evBusy = true;
    render();
    const data = await askSolver(posOf(G.human, G.rolls), true);
    // The solver scores the rest of the game, so add what is already banked.
    if (mine === token) {
        ev = data && data.map(v => v + G.human.score);
        evBusy = false;
        render();
    }
}

// Dice positions sorted by value: the order the solver's hold masks refer to.
const order = () => [...Array(N).keys()].sort((a, b) => G.dice[a] - G.dice[b]);
const holdMask = () => order().reduce(
    (m, d, i) => dieEls[d].classList.contains('keep') ? m | 1 << i : m, 0);
const setHold = mask => order().forEach((d, i) =>
    dieEls[d].classList.toggle('keep', !!(mask >> i & 1)));

const bestHold = data => {
    let best = 0;
    for (let m = 1; m < HOLDS; m++) if (data[holdAt(m)] > data[holdAt(best)]) best = m;
    return best;
};

// --- animation --------------------------------------------------------------

// Every wait can be cut short by a tap; body.skip collapses the CSS transitions
// for one frame so the dice land immediately instead of finishing their tumble.
const pending = [];

const sleep = ms => new Promise(done => {
    const cut = () => {
        clearTimeout(timer);
        const at = pending.indexOf(cut);
        if (at >= 0) pending.splice(at, 1);
        done();
    };
    const timer = setTimeout(cut, ms);
    pending.push(cut);
});

function skipAnimations() {
    document.body.classList.add('skip');
    pending.splice(0).forEach(cut => cut());
    requestAnimationFrame(() => requestAnimationFrame(() =>
        document.body.classList.remove('skip')));
}

// The tap that skips must not also toggle a die or fill in a category, so the
// click that same press turns into is dropped. Clearing the flag on every
// press keeps a gesture that never produced a click (a drag, a scroll) from
// stranding it and eating someone's next tap.
let swallowClick = false;

addEventListener('pointerdown', e => {
    swallowClick = false;
    if (!pending.length) return;
    skipAnimations();
    swallowClick = true;
    e.stopPropagation();
}, true);

addEventListener('click', e => {
    if (!swallowClick) return;
    swallowClick = false;
    e.stopPropagation();
    e.preventDefault();
}, true);

const spins = [0, 1].map(() => Array(N).fill(0));   // whole turns so far, per axis

// Tumbles die i onto value v. Whole turns only ever accumulate, so the cube
// keeps spinning forwards instead of unwinding to the nearest equal angle, and
// the two axes advance separately so it tumbles rather than rolling flat.
function showFace(i, v, delay) {
    const [rx, ry] = REST[v];
    const x = spins[0][i] += 1 + Math.round(Math.random());
    const y = spins[1][i] += 1 + Math.round(Math.random());
    cubes[i].style.transitionDelay = `${delay}ms`;
    cubes[i].style.transform = `${DEPTH} rotateX(${rx + 360 * x}deg) rotateY(${ry + 360 * y}deg)`;
}

function resetDice() {
    dieEls.forEach((die, i) => {
        die.classList.remove('keep', 'best');
        spins[0][i] = spins[1][i] = 0;
        const cube = cubes[i];
        cube.style.transition = 'none';
        cube.style.transitionDelay = '0ms';
        cube.style.transform = TILT;
        void cube.offsetWidth;     // commit the jump before transitions come back
        cube.style.transition = '';
    });
}

async function rollDice() {
    if (!G.rolls) return;
    rollBtn.disabled = true;
    const rolling = [...Array(N).keys()].filter(i => !dieEls[i].classList.contains('keep'));
    rolling.forEach((i, n) => {
        G.dice[i] = 1 + Math.floor(Math.random() * 6);
        showFace(i, G.dice[i], n * 45);          // stagger so they don't land in unison
    });
    if (rolling.length) await sleep(ROLL_MS + rolling.length * 45);
    G.rolls--;
    G.rolled = true;
}

// --- scoring ----------------------------------------------------------------

function score(side, i) {
    const p = placementsFor(side);
    const points = p.scores[i];

    side.mask |= 1 << i;
    side.cells[i] = points + p.bonus;
    side.score += points + p.bonus;
    side.last = i;

    // Filling the all-alike box for score is what arms the joker rule and the
    // extra bonus for later all-alike rolls.
    if (i === R.allAlikeCell && points > 0) side.alikeScored = true;

    if (R.bonusMask >> i & 1) {
        side.upper += points;
        // How far ahead of the pace needed for the bonus this leaves them.
        side.diff += points - BONUS_PACE * (R.cells[i].a + 1);
        side.target = Math.max(0, side.target - points);
        if (!side.target) side.bonus = R.bonusPoints;
    }

    side.extra = R.banksRolls ? G.rolls : 0;   // unused rolls carry over
    G.rolls = 0;
    G.scored = true;               // this turn is over, even if it lingers on screen
}

// --- rendering --------------------------------------------------------------

// A short overlapping stack of chips, with the real count alongside it, so the
// width barely moves whether someone is holding 2 rolls or 20.
const CHIP_STACK = 5;
function chips(el, n) {
    el.innerHTML = '<i></i>'.repeat(Math.min(n, CHIP_STACK)) + `<em>×${n}</em>`;
}

const holdText = mask =>
    !mask ? `(reroll all)` : mask === ALL_HELD ? '(keep all)' :
        order().filter((_, i) => mask >> i & 1).map(d => glyph(G.dice[d])).join(' ');

function render() {
    for (const who of ['human', 'robot']) {
        const side = G[who];
        $(`${who}-upper`).textContent =
            `${side.upper} (${side.diff > 0 ? '+' : ''}${side.diff})`;
        $(`${who}-bonus`).textContent = side.bonus;
        $(`${who}-total`).textContent = side.score + side.bonus;
        $(`th-${who}`).classList.toggle('turn', G.turn === who);
        // Whoever is mid-turn shows what is left of it. Everyone else shows the
        // bank they will add to next turn, including a player who has just
        // scored and is still on screen while the result is read.
        const inPlay = G.turn === who && !G.scored;
        chips($(`${who}-chips`), inPlay ? G.rolls : side.extra);
    }

    const human = G.human, robot = G.robot;
    const place = G.rolled ? placementsFor(human) : null;
    // Fall back to plain previews if the solver never answered.
    const useEV = evToggle.checked && G.turn === 'human' && G.rolled && (ev || evBusy);
    const legal = place ? place.legal : 0;
    const topEV = useEV && ev
        ? Math.max(...ev.slice(0, C).filter((_, i) => legal >> i & 1))
        : NaN;

    picks.forEach((cell, i) => {
        const used = human.mask >> i & 1;
        const allowed = legal >> i & 1;
        cell.className = 'pick';
        cell.textContent =
            used ? human.cells[i] :
                !place || G.turn !== 'human' ? '' :
                    !allowed ? '' :
                        useEV ? (evBusy ? '…' : ev[i].toFixed(2)) :
                            (place.scores[i] + place.bonus) || '';
        if (!used && cell.textContent) cell.classList.add('preview');
        // Under the joker rule most categories can be closed off entirely.
        if (!used && place && !allowed) cell.classList.add('barred');
        if (!used && useEV && !evBusy && allowed && ev[i] === topEV) cell.classList.add('best');

        bots[i].textContent = (robot.mask >> i & 1) ? robot.cells[i] : '';
        bots[i].className = 'bot' + (robot.last === i ? ' latest' : '');
    });

    // Hold advice only makes sense while a reroll is still available.
    const advising = useEV && !evBusy && G.rolls > 0;
    const best = advising ? bestHold(ev) : 0;
    order().forEach((d, i) => dieEls[d].classList.toggle('best', advising && !!(best >> i & 1)));

    panel.hidden = !(evToggle.checked && G.turn === 'human' && G.rolled);
    if (!panel.hidden) {
        const idle = evBusy ? '…' : '-';
        const spent = ev && !G.rolls ? 'N/A' : idle;
        $('cur-ev').textContent = advising ? ev[holdAt(holdMask())].toFixed(2) : spent;
        $('best-ev').textContent = advising ? ev[holdAt(best)].toFixed(2) : spent;
        $('best-dice').textContent = advising ? holdText(best) : '';
        bestBtn.disabled = !advising;
    }

    $('offline').hidden = !solverDown;
    rollBtn.disabled = !(G.turn === 'human' && G.rolls > 0);
}

// --- turns ------------------------------------------------------------------

async function playTurns() {
    while (G.human.mask !== FULL || G.robot.mask !== FULL) {
        resetDice();
        G.dice = Array(N).fill(1);
        G.rolled = false;
        G.scored = false;
        G.lastHold = -1;
        G.rolls = R.rollsPerTurn + G[G.turn].extra;
        render();
        if (G.turn === 'human') return;   // hand control back to the player
        await robotTurn();
        G.turn = 'human';
    }
    gameOver();
}

async function robotTurn() {
    while (G.rolls > 0) {
        await sleep(500);
        await rollDice();
        render();
        await sleep(500);

        const data = await askSolver(posOf(G.robot, G.rolls));
        const legal = placementsFor(G.robot).legal;

        // With no rolls left only the categories are a legal choice, so the
        // robot can never hold its way out of ever filling one in.
        let choice;
        if (data) {
            choice = -1;
            for (let i = 0; i < C; i++)
                if ((legal >> i & 1) && (choice < 0 || data[i] > data[choice])) choice = i;
            if (G.rolls > 0)
                for (let m = 0; m < HOLDS; m++)
                    if (data[holdAt(m)] > data[choice]) choice = holdAt(m);
        } else {
            choice = greedy(G.robot);     // solver down: keep the game playable
        }
        // Refilling a used or barred category would stall the game.
        if (choice < C && !(legal >> choice & 1)) choice = greedy(G.robot);
        if (data) record('robot', G.robot, choice);   // unpriced guesses are not decisions

        // Leave the scoring dice on screen; the next turn resets them.
        if (choice >= C) setHold(choice - C);
        else { score(G.robot, choice); setHold(0); }
    }
    render();
    await sleep(1500);
}

// Highest points available right now, ignoring everything about the future.
function greedy(side) {
    const p = placementsFor(side);
    let best = -1;
    for (let i = 0; i < C; i++)
        if ((p.legal >> i & 1) && (best < 0 || p.scores[i] > p.scores[best])) best = i;
    return best;
}

function gameOver() {
    rollBtn.disabled = true;
    showAnalysis();                // analysis.js
}

// --- input ------------------------------------------------------------------

rollBtn.onclick = async () => {
    if (G.turn !== 'human' || !G.rolls) return;
    // Remember what was held going into this roll, so the log can show the
    // decision rather than only its outcome.
    G.lastHold = G.rolled ? holdMask() : -1;
    if (G.rolled) record('human', G.human, holdAt(holdMask()));   // rerolling is a choice
    token++;
    ev = null;
    await rollDice();
    render();
    loadEV();
};

dieEls.forEach(die => die.onclick = () => {
    if (G.turn !== 'human' || !G.rolled) return;
    die.classList.toggle('keep');
    render();
});

$('rows').onclick = e => {
    const cell = e.target.closest('td.pick');
    if (!cell || G.turn !== 'human' || !G.rolled) return;
    const i = +cell.dataset.i;
    if (!(placementsFor(G.human).legal >> i & 1)) return;   // filled in, or barred
    record('human', G.human, i);
    score(G.human, i);
    token++;
    ev = null;
    G.turn = 'robot';
    playTurns();
};

evToggle.onchange = () => {
    if (G.turn === 'human' && G.rolled && !ev && !evBusy) loadEV();
    else render();
};

/* Revealing the expected values.

   The checkbox that drives all of this is hidden: showing the solver's answers
   turns the game into a tutorial, which is worth having but not worth offering
   before someone has played once. So it is reached by a gesture instead, and
   the post-game screen explains both of them.

   Two gestures rather than one because a keyboard shortcut alone would put the
   feature out of reach on a phone, which is where most games get played. */

const toast = $('toast');
let toastTimer = null;

function flash(text) {
    toast.textContent = text;
    toast.hidden = false;
    // Restart the CSS animation rather than letting a second toast inherit the
    // tail of the first one's fade.
    toast.style.animation = 'none';
    void toast.offsetWidth;
    toast.style.animation = '';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { toast.hidden = true; }, 1600);
}

function revealEV() {
    evToggle.checked = !evToggle.checked;
    flash(evToggle.checked ? 'Expected values on' : 'Expected values off');
    evToggle.onchange();
}

addEventListener('keydown', e => {
    // No text inputs on the page, so a bare letter is safe. Modifiers are
    // excluded so browser and OS shortcuts keep working.
    if (e.key === 'e' && !e.ctrlKey && !e.metaKey && !e.altKey) revealEV();
});

/* Long-press the score sheet's header cell. A long press rather than a tap so
   it is not discovered by accident; the whole cell rather than just the game's
   name because one small word is not a reliable touch target.

   A press that starts on the link home is left alone, so going back to the home
   page still works and still gets the browser's own long-press menu. */
const brand = $('brand');
if (brand) {
    const onLink = e => !!(e.target && e.target.closest && e.target.closest('a'));
    let held = null;
    const stop = () => { clearTimeout(held); held = null; };

    brand.addEventListener('pointerdown', e => {
        if (onLink(e)) return;
        held = setTimeout(() => { held = null; revealEV(); }, 550);
    });
    for (const done of ['pointerup', 'pointerleave', 'pointercancel'])
        brand.addEventListener(done, stop);
    // Otherwise the long press pops a context menu over the game.
    brand.addEventListener('contextmenu', e => { if (!onLink(e)) e.preventDefault(); });
}

bestBtn.onclick = () => {
    if (ev && G.rolls > 0) { setHold(bestHold(ev)); render(); }
};

(async () => { await newGame(); playTurns(); })();
