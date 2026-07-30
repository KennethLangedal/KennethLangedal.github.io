/* Post-game analysis.

   At every decision the value of a position is

       V = points already banked + solver EV of the rest of the game

   which under optimal play is a martingale: rolling the dice does not change it
   in expectation. That splits a game into two parts, exactly:

       decision cost = V(best option) - V(option taken)      >= 0, your fault
       luck          = V(next decision) - V(option taken)    the dice's fault

   and they telescope, so summed over a game

       final score - V(first decision) = total luck - total decision cost

   with nothing left over. No counterfactual replay is needed: every choice is
   priced against the best alternative from the position actually reached, so
   the dice are held fixed by construction. What this does NOT measure is
   playing the scoreboard -- the solver maximises points, not win chance, so
   correctly taking variance when behind is charged here as a mistake. */

/* Chart series colours come from the stylesheet rather than living here, so the
   charts follow the light/dark scheme along with everything else. The fallbacks
   are the light-mode values, for the case where the variables are missing. */
const cssVar = (name, fallback) =>
    getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;

const PLAYER_COLOUR = {
    human: cssVar('--chart-human', '#1a73e8'),
    robot: cssVar('--chart-robot', '#d93025'),
};
const CHART = { w: 700, h: 210, l: 52, r: 14, t: 12, b: 28 };

const popcount = m => { let n = 0; while (m) { m &= m - 1; n++; } return n; };
const signed = v => (v > 0 ? '+' : v < 0 ? '−' : '') + Math.abs(v).toFixed(1);

/* Best value available at a node, over legal options only: open categories
   always, holds only while a reroll remains. This re-derives legality from the
   position rather than trusting the solver's own -Infinity padding, so it stays
   correct if the service ever changes how it marks unplayable cells. */
function bestValue(e) {
    let best = -Infinity;
    for (let i = 0; i < C; i++)
        if (!(e.pos.mask >> i & 1)) best = Math.max(best, e.ev[i]);
    if (e.pos.rolls > 0)
        for (let m = 0; m < HOLDS; m++) best = Math.max(best, e.ev[holdAt(m)]);
    return best + e.score;
}

function bestOption(e) {
    let best = -1, top = -Infinity;
    for (let i = 0; i < C; i++)
        if (!(e.pos.mask >> i & 1) && e.ev[i] > top) { top = e.ev[i]; best = i; }
    if (e.pos.rolls > 0)
        for (let m = 0; m < HOLDS; m++)
            if (e.ev[holdAt(m)] > top) { top = e.ev[holdAt(m)]; best = holdAt(m); }
    return best;
}

const describe = (e, opt) => {
    if (opt < C) return R.cells[opt].label;
    const mask = opt - C;
    if (!mask) return `reroll all ${N}`;
    const kept = [...e.dice].sort((a, b) => a - b).filter((_, i) => mask >> i & 1);
    return (kept.length === N ? 'keep all' : 'keep') + ' ' + kept.map(glyph).join('');
};

// Walks one player's decisions in order and prices each one.
function priceDecisions(who) {
    const nodes = log.filter(e => e.who === who && e.ev);
    const final = G[who].score + G[who].bonus;
    const turnOf = e => popcount(e.pos.mask);

    // A turn holds as many decisions as it took rolls. Spreading them across
    // the turn puts both players on the same axis even though they take
    // different numbers of rolls.
    const perTurn = new Map(), placed = new Map();
    for (const e of nodes) perTurn.set(turnOf(e), (perTurn.get(turnOf(e)) || 0) + 1);

    return nodes.map((e, k) => {
        const turn = turnOf(e);
        const nth = placed.get(turn) || 0;
        placed.set(turn, nth + 1);
        const best = bestValue(e);
        const took = e.ev[e.choice] + e.score;
        const next = k + 1 < nodes.length ? bestValue(nodes[k + 1]) : final;
        return {
            e, turn, best, took, cost: best - took, luck: next - took,
            x: turn + nth / perTurn.get(turn),
        };
    });
}

// --- charts -----------------------------------------------------------------

// One <svg> per chart, built from series of [x, y] points. No dependencies, and
// the viewBox lets it scale with the page.
function lineChart(series, yFmt = v => v.toFixed(0)) {
    const { w, h, l, r, t, b } = CHART;
    const all = series.flatMap(s => s.points);
    if (!all.length) return '';
    const xs = all.map(p => p[0]), ys = all.map(p => p[1]);
    const [x0, x1] = [Math.min(...xs), Math.max(...xs)];
    let [y0, y1] = [Math.min(...ys), Math.max(...ys)];
    const span = y1 - y0 || 2;
    y0 -= span * .08; y1 += span * .08;
    const px = x => l + (x - x0) / (x1 - x0 || 1) * (w - l - r);
    const py = y => h - b - (y - y0) / (y1 - y0) * (h - t - b);

    const gridY = [0, .25, .5, .75, 1].map(f => y0 + f * (y1 - y0));
    const grid = gridY.map(v => `<line class="grid" x1="${l}" x2="${w - r}"
        y1="${py(v).toFixed(1)}" y2="${py(v).toFixed(1)}"/>
        <text class="tick" x="${l - 6}" y="${(py(v) + 3.5).toFixed(1)}"
        text-anchor="end">${yFmt(v)}</text>`).join('');

    // A tick every five turns, whatever the variant's category count.
    const step = 5;
    const xTicks = [];
    for (let v = 0; v <= C; v += step)
        if (v >= x0 && v <= x1)
            xTicks.push(`<text class="tick" x="${px(v).toFixed(1)}" y="${h - 8}"
                text-anchor="middle">${v}</text>`);

    const lines = series.map(s => {
        const d = s.points.map((p, i) =>
            `${i ? 'L' : 'M'}${px(p[0]).toFixed(1)},${py(p[1]).toFixed(1)}`).join('');
        return `<path d="${d}" fill="none" stroke="${s.colour}" stroke-width="2"
            stroke-linejoin="round" ${s.dash ? 'stroke-dasharray="5 4"' : ''}
            ${s.dash ? 'opacity=".65"' : ''}/>`;
    }).join('');

    return `<svg viewBox="0 0 ${w} ${h}" class="chart">${grid}${xTicks.join('')}${lines}</svg>`;
}

const legend = items => `<div class="legend">` + items.map(i =>
    `<span><i style="background:${i.colour}${i.dash ? ';opacity:.55' : ''}"></i>${i.label}</span>`
).join('') + `</div>`;

// --- screen -----------------------------------------------------------------

function summaryCard(who, priced) {
    const side = G[who];
    const final = side.score + side.bonus;
    // Par is the value of the game before any dice are thrown, which the server
    // hands over with the game id. Falling back to the first priced decision
    // keeps the old behaviour when tracking is unavailable -- but then the very
    // first roll's luck sits inside par instead of being counted.
    const par = G.startEV != null ? G.startEV : (priced.length ? priced[0].best : final);
    const opening = (G.startEV != null && priced.length) ? priced[0].best - G.startEV : 0;
    const luck = opening + priced.reduce((t, d) => t + d.luck, 0);
    const cost = priced.reduce((t, d) => t + d.cost, 0);
    return `<div class="card" style="--who:${PLAYER_COLOUR[who]}">
        <h3>${who === 'human' ? 'You' : 'Robot'}</h3>
        <p class="final">${final}</p>
        <dl>
            <dt>Par</dt><dd>${par.toFixed(1)}</dd>
            <dt>Luck</dt><dd>${signed(luck)}</dd>
            <dt>Lost to decisions</dt><dd>${cost < .05 ? '0.0' : '−' + cost.toFixed(1)}</dd>
            <dt>Decisions priced</dt><dd>${priced.length}</dd>
        </dl>
        <p class="identity">${par.toFixed(1)} ${signed(luck)}
            ${cost < .05 ? '' : '− ' + cost.toFixed(1)} = ${final}</p>
    </div>`;
}

function blunderTable(priced) {
    const worst = priced.filter(d => d.cost > .05).sort((a, b) => b.cost - a.cost).slice(0, 5);
    if (!worst.length) return `<p class="clean">No decision cost more than 0.05 points.</p>`;
    return `<table class="blunders"><thead><tr><th>Turn</th><th>You chose</th>
        <th>Best was</th><th>Cost</th></tr></thead><tbody>` + worst.map(d =>
        `<tr><td>${d.turn + 1}</td><td>${describe(d.e, d.e.choice)}</td>
         <td>${describe(d.e, bestOption(d.e))}</td>
         <td class="cost">−${d.cost.toFixed(1)}</td></tr>`).join('') + `</tbody></table>`;
}

async function showAnalysis() {
    const screen = $('analysis');
    screen.hidden = false;
    screen.innerHTML = `<p class="loading">Pricing ${log.length} decisions…</p>`;

    for (const e of log) e.ev = await askSolver(e.pos);
    const gaps = log.filter(e => !e.ev).length;

    const priced = { human: priceDecisions('human'), robot: priceDecisions('robot') };
    const value = who => ({
        colour: PLAYER_COLOUR[who], label: who === 'human' ? 'You' : 'Robot',
        points: priced[who].map(d => [d.x, d.best]),
    });
    // The same luck with none of the mistakes: at each decision, add back
    // everything given up before it.
    const perfect = who => {
        let spent = 0;
        const points = priced[who].map(d => {
            const point = [d.x, d.best + spent];
            spent += d.cost;
            return point;
        });
        return {
            colour: PLAYER_COLOUR[who], dash: true, points,
            label: `${who === 'human' ? 'You' : 'Robot'}, no mistakes`,
        };
    };
    const cumulative = (who, key) => {
        let sum = 0;
        return {
            colour: PLAYER_COLOUR[who], dash: key === 'cost',
            label: `${who === 'human' ? 'You' : 'Robot'} ${key === 'luck' ? 'luck' : 'decision cost'}`,
            points: priced[who].map(d => [d.x, sum += key === 'luck' ? d.luck : -d.cost]),
        };
    };
    const bank = who => ({
        colour: PLAYER_COLOUR[who], label: who === 'human' ? 'You' : 'Robot',
        points: priced[who].map(d => [d.x, d.e.pos.rolls]),
    });

    const sides = ['human', 'robot'];

    // Only Maxi Yatzy carries rolls between turns, so the banked-rolls chart is
    // a flat line saying nothing in the other variants.
    const rollsChart = R.banksRolls ? `
            <h3>Rolls in hand</h3>
            <p class="hint">Rolls remaining at each decision, so banked rolls show up as peaks.</p>
            ${lineChart(sides.map(bank))}
            ${legend(sides.map(bank))}` : '';

    screen.innerHTML = `
        <div class="sheet">
            <h2>${headline()}</h2>
            ${gaps ? `<p class="warn">${gaps} decision${gaps > 1 ? 's' : ''} could not be
                priced — the solver was unreachable at the time.</p>` : ''}
            <div class="cards">${sides.map(w => summaryCard(w, priced[w])).join('')}</div>

            <h3>Projected final score</h3>
            <p class="hint">Where each game was heading, decision by decision. It ends at the
               real score. The dashed line is the same dice with no mistakes — a projection,
               not a replay: playing differently would have meant different dice.</p>
            ${lineChart([...sides.map(value), ...sides.map(perfect)])}
            ${legend([...sides.map(value), ...sides.map(perfect)])}

            <h3>Luck and decisions, accumulated</h3>
            <p class="hint">These two add up to the gap between par and the final score.</p>
            ${lineChart([...sides.map(w => cumulative(w, 'luck')),
                         ...sides.map(w => cumulative(w, 'cost'))], v => signed(v))}
            ${legend([...sides.map(w => cumulative(w, 'luck')),
                      ...sides.map(w => cumulative(w, 'cost'))])}
            ${rollsChart}

            <h3>Your five costliest decisions</h3>
            ${blunderTable(priced.human)}

            <p class="reveal">Want to see the solver's answers while you play?
                Press <kbd>E</kbd> during a game — or on a touchscreen, press and
                hold the top-left corner of the score sheet. Every category and
                every hold is then labelled with the score you can expect to
                finish on.</p>

            <button id="again">Play again</button>
        </div>`;
    $('again').onclick = () => location.reload();
}

function headline() {
    const h = G.human.score + G.human.bonus, r = G.robot.score + G.robot.bonus;
    return h > r ? `You win, ${h} to ${r}` : h < r ? `Robot wins, ${r} to ${h}`
        : `A tie at ${h}`;
}
