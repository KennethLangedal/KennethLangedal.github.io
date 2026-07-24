/* Maxi yatzy: 6 dice, 20 categories, 100 bonus points once the upper section
   reaches 84. Both the score rows and the dice are generated from the tables
   below. Lookup tables live in data.js; expected values come from the solver
   service in fetchEV(). */

const $ = id => document.getElementById(id);
const CATEGORIES = 20;
const FULL = (1 << CATEGORIES) - 1;
const ROLL_MS = 700;               // must match the .cube transition in styles.css

// [name, the dice that make up the category] in sheet order.
const CATS = [
    ['Ones', '111111'], ['Twos', '222222'], ['Threes', '333333'],
    ['Fours', '444444'], ['Fives', '555555'], ['Sixes', '666666'],
    ['One Pair', '66'], ['Two Pair', '5566'], ['Three Pairs', '445566'],
    ['Three of a Kind', '666'], ['Four of a Kind', '6666'], ['Five of a Kind', '66666'],
    ['Small Straight', '12345'], ['Large Straight', '23456'], ['Full Straight', '123456'],
    ['Full House', '55666'], ['Castle', '555666'], ['Tower', '556666'],
    ['Chance', '666666'], ['Yatzy', '666666'],
];

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

// --- build the page ---------------------------------------------------------

const totalRow = (name, key, rule) => `<tr class="tally${rule ? ' rule' : ''}">
    <td>${name}</td><td id="human-${key}"></td><td id="robot-${key}"></td></tr>`;

$('rows').innerHTML = CATS.map(([name, dice], i) =>
    // The upper section is closed off after Sixes.
    (i === 6 ? totalRow('Sum', 'upper', 1) + totalRow('Bonus', 'bonus') : '') +
    `<tr class="${i === 6 ? 'rule' : ''}">
        <td class="cat"><div><span>${name}</span><b>${pips(dice)}</b></div></td>
        <td class="pick" data-i="${i}"></td><td class="bot"></td></tr>`
).join('') + totalRow('Sum', 'total', 1);

const faces = [1, 2, 3, 4, 5, 6].map(v =>
    `<div class="face f${v}">${PIPS[v].map(p => `<i class="p${p}"></i>`).join('')}</div>`).join('') +
    '<div class="core"></div><div class="core x"></div><div class="core y"></div>';

$('dice').innerHTML = `<div class="die"><div class="cube">${faces}</div>
    <span class="tag keep-tag">Keep</span><span class="tag best-tag">Best</span></div>`.repeat(6);

const dieEls = [...document.querySelectorAll('.die')];
const cubes = dieEls.map(d => d.firstElementChild);
const picks = [...document.querySelectorAll('td.pick')];
const bots = [...document.querySelectorAll('td.bot')];
const evToggle = $('ev-toggle'), rollBtn = $('roll'), bestBtn = $('best-btn'), panel = $('ev-panel');

// --- state ------------------------------------------------------------------

const newSide = () => ({
    score: 0, upper: 0, diff: 0, bonus: 0,
    target: 84,                    // points still needed for the bonus
    mask: 0,                       // which categories are filled in
    cells: Array(CATEGORIES).fill(0),
    extra: 0,                      // rolls carried into the next turn
    last: -1,
});

const G = {
    turn: 'human', rolls: 3, rolled: false, scored: false, dice: [1, 1, 1, 1, 1, 1],
    human: newSide(), robot: newSide(),
};

let ev = null;                     // 84 expected values for the human's position
let evBusy = false;
let token = 0;                     // invalidates EV requests that are now stale

// --- solver -----------------------------------------------------------------

function encodeRoll(dice) {
    return [...dice].sort((a, b) => a - b).reduce((key, d, i) => key | (d - 1) << (3 * i), 0);
}

// Returns 84 floats: 0..19 the EV of scoring each category, 20..83 the EV of
// each hold, indexed by a bitmask over the dice sorted by value.
async function fetchEV(side, rolls) {
    const id = rollIdMap.get(encodeRoll(G.dice));
    const url = `https://89.167.37.171?table=${side.mask}&bonus=${84 - side.target}&rolls=${rolls}&id=${id}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`solver returned ${res.status}`);
    return [...new Float32Array(await res.arrayBuffer())];
}

async function loadEV() {
    if (G.turn !== 'human' || !G.rolled) { ev = null; return render(); }
    const mine = token;
    evBusy = true;
    render();
    try {
        const data = await fetchEV(G.human, G.rolls);
        // The solver scores the rest of the game, so add what is already banked.
        if (mine === token) ev = data.map(v => v + G.human.score);
    } catch (err) {
        console.error('EV unavailable:', err);
    }
    if (mine === token) { evBusy = false; render(); }
}

// Dice positions sorted by value: the order the solver's hold masks refer to.
const order = () => [0, 1, 2, 3, 4, 5].sort((a, b) => G.dice[a] - G.dice[b]);
const holdMask = () => order().reduce(
    (m, d, i) => dieEls[d].classList.contains('keep') ? m | 1 << i : m, 0);
const setHold = mask => order().forEach((d, i) => dieEls[d].classList.toggle('keep', !!(mask >> i & 1)));
const bestHold = data => {
    let best = 20;
    for (let i = 21; i < 84; i++) if (data[i] > data[best]) best = i;
    return best - 20;
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

const spins = [0, 1].map(() => Array(6).fill(0));   // whole turns so far, per axis

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
    const rolling = [0, 1, 2, 3, 4, 5].filter(i => !dieEls[i].classList.contains('keep'));
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
    const points = rollIdScoreMap.get(encodeRoll(G.dice))[i];
    side.mask |= 1 << i;
    side.cells[i] = points;
    side.score += points;
    side.last = i;
    if (i < 6) {
        side.upper += points;
        side.diff += points - (i + 1) * 4;
        side.target = Math.max(0, side.target - points);
        if (!side.target) side.bonus = 100;
    }
    side.extra = G.rolls;          // unused rolls carry over to the next turn
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
    !mask ? '(reroll all)' : mask === 63 ? '(keep all)' :
        order().filter((_, i) => mask >> i & 1).map(d => glyph(G.dice[d])).join(' ');

function render() {
    for (const who of ['human', 'robot']) {
        const side = G[who];
        $(`${who}-upper`).textContent = `${side.upper} (${side.diff > 0 ? '+' : ''}${side.diff})`;
        $(`${who}-bonus`).textContent = side.bonus;
        $(`${who}-total`).textContent = side.score + side.bonus;
        $(`th-${who}`).classList.toggle('turn', G.turn === who);
        // Whoever is mid-turn shows what is left of it. Everyone else shows the
        // bank they will add 3 to next turn, including a player who has just
        // scored and is still on screen while the result is read.
        const inPlay = G.turn === who && !G.scored;
        chips($(`${who}-chips`), inPlay ? G.rolls : side.extra);
    }

    const human = G.human, robot = G.robot;
    const points = G.rolled ? rollIdScoreMap.get(encodeRoll(G.dice)) : null;
    // Fall back to plain previews if the solver never answered.
    const useEV = evToggle.checked && G.turn === 'human' && G.rolled && (ev || evBusy);
    const topEV = useEV && ev
        ? Math.max(...ev.slice(0, CATEGORIES).filter((_, i) => !(human.mask >> i & 1)))
        : NaN;

    picks.forEach((cell, i) => {
        const used = human.mask >> i & 1;
        cell.className = 'pick';
        cell.textContent =
            used ? human.cells[i] :
                !points || G.turn !== 'human' ? '' :
                    useEV ? (evBusy ? '…' : ev[i].toFixed(2)) :
                        points[i] || '';
        if (!used && cell.textContent) cell.classList.add('preview');
        if (!used && useEV && !evBusy && ev[i] === topEV) cell.classList.add('best');

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
        $('cur-ev').textContent = advising ? ev[20 + holdMask()].toFixed(2) : spent;
        $('best-ev').textContent = advising ? ev[20 + best].toFixed(2) : spent;
        $('best-dice').textContent = advising ? holdText(best) : '';
        bestBtn.disabled = !advising;
    }

    rollBtn.disabled = !(G.turn === 'human' && G.rolls > 0);
}

// --- turns ------------------------------------------------------------------

async function playTurns() {
    while (G.human.mask !== FULL || G.robot.mask !== FULL) {
        resetDice();
        G.dice = [1, 1, 1, 1, 1, 1];
        G.rolled = false;
        G.scored = false;
        G.rolls = Math.min(3 + G[G.turn].extra, 32);
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

        const data = await fetchEV(G.robot, G.rolls).catch(err => {
            console.error('EV unavailable:', err);
            return null;
        });

        // With no rolls left only the 20 categories are a legal choice, so the
        // robot can never hold its way out of ever filling one in.
        const options = G.rolls > 0 ? 84 : CATEGORIES;
        let choice;
        if (data) {
            choice = 0;
            for (let i = 1; i < options; i++) if (data[i] >= data[choice]) choice = i;
        } else {
            choice = greedy(G.robot);     // solver down: keep the game playable
        }
        // Refilling a used category would stall the game, so never take one.
        if (choice < CATEGORIES && (G.robot.mask >> choice & 1)) choice = greedy(G.robot);

        // Leave the scoring dice on screen; the next turn resets them.
        if (choice >= 20) setHold(choice - 20);
        else { score(G.robot, choice); setHold(0); }
    }
    render();
    await sleep(1500);
}

// Highest points available right now, ignoring everything about the future.
function greedy(side) {
    const points = rollIdScoreMap.get(encodeRoll(G.dice));
    let best = -1;
    for (let i = 0; i < CATEGORIES; i++)
        if (!(side.mask >> i & 1) && (best < 0 || points[i] > points[best])) best = i;
    return best;
}

function gameOver() {
    const [h, r] = [G.human.score + G.human.bonus, G.robot.score + G.robot.bonus];
    rollBtn.disabled = true;
    setTimeout(() => alert(`Game over, ${h} - ${r}. ` +
        (h > r ? 'You win!' : h < r ? 'Robot wins!' : "It's a tie!")), 100);
}

// --- input ------------------------------------------------------------------

rollBtn.onclick = async () => {
    if (G.turn !== 'human' || !G.rolls) return;
    token++;
    ev = null;
    await rollDice();
    render();
    if (evToggle.checked) loadEV();   // don't trouble the solver unless it's shown
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
    if (G.human.mask >> i & 1) return;    // already filled in
    score(G.human, i);
    token++;
    ev = null;
    G.turn = 'robot';
    playTurns();
};

evToggle.onchange = () => {
    if (evToggle.checked && G.turn === 'human' && G.rolled && !ev && !evBusy) loadEV();
    else render();
};

bestBtn.onclick = () => {
    if (ev && G.rolls > 0) { setHold(bestHold(ev)); render(); }
};

playTurns();
