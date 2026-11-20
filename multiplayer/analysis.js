'use strict';

const PLAYER_COLORS = [
    '#1a73e8', // Blue
    '#d93025', // Red
    '#1e8e3e', // Green
    '#e37400', // Orange
    '#9334e6', // Purple
];

const DEFAULT_PAR = {
    maxi: 496.633260,
    yatzy: 248.439989,
    yahtzee: 254.587729
};

const CHART = { w: 700, h: 210, l: 52, r: 14, t: 12, b: 28 };
const evCache = new Map();
const posKey = p => `${p.mask}|${p.bonus}|${p.rolls}|${p.id}|${p.joker}`;
const popcount = m => { let n = 0; while (m) { m &= m - 1; n++; } return n; };
const signed = v => (v > 0 ? '+' : v < 0 ? '−' : '') + Math.abs(v).toFixed(1);
const glyph = v => String.fromCharCode(9855 + Number(v));

function escapeHtml(str) {
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

async function fetchEV(variant, pos) {
    const key = `${variant}|${posKey(pos)}`;
    if (evCache.has(key)) return evCache.get(key);
    const solverHost = typeof SOLVER_HOST !== 'undefined' ? SOLVER_HOST : location.origin;
    const joker = pos.joker ? '&joker=1' : '';
    const url = `${solverHost}/${variant}/?table=${pos.mask}&bonus=${pos.bonus}&rolls=${pos.rolls}&id=${pos.id}${joker}`;
    try {
        const res = await fetch(url);
        if (!res.ok) throw new Error(`Solver returned ${res.status}`);
        const buf = await res.arrayBuffer();
        const data = [...new Float64Array(buf)];
        evCache.set(key, data);
        return data;
    } catch (err) {
        console.warn('EV lookup failed:', pos, err);
        return null;
    }
}

async function fetchPar(variant) {
    const solverHost = typeof SOLVER_HOST !== 'undefined' ? SOLVER_HOST : location.origin;
    try {
        const res = await fetch(`${solverHost}/${variant}/new`);
        if (res.ok) {
            const data = await res.json();
            if (typeof data.ev === 'number') return data.ev;
        }
    } catch { /* ignore */ }
    return DEFAULT_PAR[variant] || 250;
}

function bestValue(e, C, HOLDS) {
    let best = -Infinity;
    for (let i = 0; i < C; i++) {
        if (!(e.pos.mask >> i & 1)) best = Math.max(best, e.ev[i]);
    }
    if (e.pos.rolls > 0) {
        for (let m = 0; m < HOLDS; m++) best = Math.max(best, e.ev[C + m]);
    }
    return best + e.score;
}

function bestOption(e, C, HOLDS) {
    let best = -1, top = -Infinity;
    for (let i = 0; i < C; i++) {
        if (!(e.pos.mask >> i & 1) && e.ev[i] > top) { top = e.ev[i]; best = i; }
    }
    if (e.pos.rolls > 0) {
        for (let m = 0; m < HOLDS; m++) {
            if (e.ev[C + m] > top) { top = e.ev[C + m]; best = C + m; }
        }
    }
    return best;
}

function describe(e, opt, r) {
    if (opt < r.nCells) return r.cells[opt].label;
    const mask = opt - r.nCells;
    if (!mask) return `reroll all ${r.dice}`;
    const kept = [...e.dice].sort((a, b) => a - b).filter((_, i) => mask >> i & 1);
    return (kept.length === r.dice ? 'keep all' : 'keep') + ' ' + kept.map(glyph).join('');
}

function pricePlayerDecisions(who, log, finalScore, C, HOLDS) {
    const nodes = log.filter(e => e.who === who && e.ev);
    const turnOf = e => popcount(e.pos.mask);
    const perTurn = new Map(), placed = new Map();
    for (const e of nodes) perTurn.set(turnOf(e), (perTurn.get(turnOf(e)) || 0) + 1);

    return nodes.map((e, k) => {
        const turn = turnOf(e);
        const nth = placed.get(turn) || 0;
        placed.set(turn, nth + 1);
        const best = bestValue(e, C, HOLDS);
        const took = e.ev[e.choice] + e.score;
        const next = k + 1 < nodes.length ? bestValue(nodes[k + 1], C, HOLDS) : finalScore;
        return {
            e, turn, best, took,
            cost: Math.max(0, best - took),
            luck: next - took,
            x: turn + nth / (perTurn.get(turn) || 1),
        };
    });
}

function lineChart(series, yFmt = v => v.toFixed(0), maxTurns = 20) {
    const { w, h, l, r, t, b } = CHART;
    const all = series.flatMap(s => s.points);
    if (!all.length) return '';
    const xs = all.map(p => p[0]), ys = all.map(p => p[1]);
    const [x0, x1] = [0, Math.max(maxTurns, ...xs)];
    let [y0, y1] = [Math.min(...ys), Math.max(...ys)];
    const span = y1 - y0 || 2;
    y0 -= span * 0.08; y1 += span * 0.08;
    const px = x => l + (x - x0) / (x1 - x0 || 1) * (w - l - r);
    const py = y => h - b - (y - y0) / (y1 - y0 || 1) * (h - t - b);

    const gridY = [0, 0.25, 0.5, 0.75, 1].map(f => y0 + f * (y1 - y0));
    const grid = gridY.map(v => `<line class="grid" x1="${l}" x2="${w - r}"
        y1="${py(v).toFixed(1)}" y2="${py(v).toFixed(1)}"/>
        <text class="tick" x="${l - 6}" y="${(py(v) + 3.5).toFixed(1)}"
        text-anchor="end">${yFmt(v)}</text>`).join('');

    const step = 5;
    const xTicks = [];
    for (let v = 0; v <= maxTurns; v += step) {
        xTicks.push(`<text class="tick" x="${px(v).toFixed(1)}" y="${h - 8}" text-anchor="middle">${v}</text>`);
    }

    const lines = series.map(s => {
        const d = s.points.map((p, i) => `${i ? 'L' : 'M'}${px(p[0]).toFixed(1)},${py(p[1]).toFixed(1)}`).join('');
        return `<path d="${d}" fill="none" stroke="${s.colour}" stroke-width="2"
            stroke-linejoin="round" ${s.dash ? 'stroke-dasharray="5 4" opacity=".65"' : ''}/>`;
    }).join('');

    return `<svg viewBox="0 0 ${w} ${h}" class="chart">${grid}${xTicks.join('')}${lines}</svg>`;
}

const legend = items => `<div class="legend">` + items.map(i =>
    `<span><i style="background:${i.colour}${i.dash ? ';opacity:.55' : ''}"></i>${escapeHtml(i.label)}</span>`
).join('') + `</div>`;

function summaryCard(p, priced, par, color) {
    const final = p.score + p.bonus;
    const opening = priced.length ? priced[0].best - par : 0;
    const luck = opening + priced.reduce((t, d) => t + d.luck, 0);
    const cost = priced.reduce((t, d) => t + d.cost, 0);
    return `
        <div class="card" style="--who: ${color}">
            <h3>${escapeHtml(p.name)}</h3>
            <p class="final">${final}</p>
            <dl>
                <dt>Par</dt><dd>${par.toFixed(1)}</dd>
                <dt>Luck</dt><dd>${signed(luck)}</dd>
                <dt>Lost to decisions</dt><dd>${cost < 0.05 ? '0.0' : '−' + cost.toFixed(1)}</dd>
                <dt>Decisions priced</dt><dd>${priced.length}</dd>
            </dl>
            <p class="identity">${par.toFixed(1)} ${signed(luck)} ${cost < 0.05 ? '' : '− ' + cost.toFixed(1)} = ${final}</p>
        </div>
    `;
}

function renderBlunders(who, priced, r, players) {
    const p = priced[who] || [];
    const name = players[who] ? players[who].name : `Player ${who + 1}`;
    const worst = p.filter(d => d.cost > 0.05).sort((a, b) => b.cost - a.cost).slice(0, 5);
    if (!worst.length) return `<p class="clean">${escapeHtml(name)} made no decision costing more than 0.05 points.</p>`;
    return `<table class="blunders">
        <thead><tr><th>Turn</th><th>Chose</th><th>Best was</th><th>Cost</th></tr></thead>
        <tbody>` + worst.map(d => `
            <tr>
                <td>${d.turn + 1}</td>
                <td>${describe(d.e, d.e.choice, r)}</td>
                <td>${describe(d.e, bestOption(d.e, r.nCells, 1 << r.dice), r)}</td>
                <td class="cost">−${d.cost.toFixed(1)}</td>
            </tr>
        `).join('') + `</tbody></table>`;
}

async function showAnalysis(state, replay) {
    const screen = document.getElementById('analysis');
    if (!screen) return;
    screen.hidden = false;
    screen.innerHTML = `
        <div class="sheet">
            <div id="analysis-content"><p class="loading">Pricing decisions with solver…</p></div>
            <div class="actions">
                <button id="close-analysis" type="button">Back to score sheet</button>
                ${state.you === 0 ? '<button id="analysis-replay" type="button" disabled>Play again</button>' : ''}
                <a id="analysis-new-game" href="/multiplayer/">New room</a>
            </div>
        </div>
    `;
    const content = document.getElementById('analysis-content');
    document.getElementById('close-analysis').onclick = () => { screen.hidden = true; };
    const replayBtn = document.getElementById('analysis-replay');
    if (replayBtn) replayBtn.onclick = replay;

    const r = buildRules(state.variant);
    const C = r.nCells, HOLDS = 1 << r.dice;
    const log = state.log || [];

    await Promise.all(log.map(async e => {
        e.ev = await fetchEV(state.variant, e.pos);
    }));

    const par = await fetchPar(state.variant);
    if (!screen.contains(content)) return;
    const gaps = log.filter(e => !e.ev).length;

    const priced = state.players.map((p, i) => {
        const final = p.score + p.bonus;
        return pricePlayerDecisions(i, log, final, C, HOLDS);
    });

    let selectedBlunderPlayer = state.you != null && state.you >= 0 ? state.you : 0;

    function renderScreen() {
        const valueSeries = state.players.map((p, i) => ({
            colour: PLAYER_COLORS[i % PLAYER_COLORS.length],
            label: p.name,
            points: priced[i].map(d => [d.x, d.best]),
        }));

        const perfectSeries = state.players.map((p, i) => {
            let spent = 0;
            const points = priced[i].map(d => {
                const pt = [d.x, d.best + spent];
                spent += d.cost;
                return pt;
            });
            return {
                colour: PLAYER_COLORS[i % PLAYER_COLORS.length],
                dash: true,
                points,
                label: `${p.name} (no mistakes)`,
            };
        });

        const luckSeries = state.players.map((p, i) => {
            let sum = 0;
            return {
                colour: PLAYER_COLORS[i % PLAYER_COLORS.length],
                label: `${p.name} luck`,
                points: priced[i].map(d => [d.x, sum += d.luck]),
            };
        });

        const costSeries = state.players.map((p, i) => {
            let sum = 0;
            return {
                colour: PLAYER_COLORS[i % PLAYER_COLORS.length],
                dash: true,
                label: `${p.name} decision cost`,
                points: priced[i].map(d => [d.x, sum -= d.cost]),
            };
        });

        const bankSeries = r.banksRolls ? state.players.map((p, i) => ({
            colour: PLAYER_COLORS[i % PLAYER_COLORS.length],
            label: p.name,
            points: priced[i].map(d => [d.x, d.e.pos.rolls]),
        })) : null;

        const rollsChart = bankSeries ? `
            <h3>Rolls in hand</h3>
            <p class="hint">Rolls remaining at each decision, showing how unused rolls were banked.</p>
            ${lineChart(bankSeries, v => v.toFixed(0), C)}
            ${legend(bankSeries)}
        ` : '';

        const tabs = state.players.length > 1 ? `
            <div class="blunder-tabs">
                ${state.players.map((p, i) => `
                    <button type="button" class="blunder-tab ${i === selectedBlunderPlayer ? 'active' : ''}" data-idx="${i}">
                        ${escapeHtml(p.name)}
                    </button>
                `).join('')}
            </div>
        ` : '';

        content.innerHTML = `
                <h2>Game breakdown</h2>
                ${gaps ? `<p class="warn">${gaps} decision${gaps > 1 ? 's' : ''} could not be priced by the solver.</p>` : ''}
                <div class="cards">
                    ${state.players.map((p, i) => summaryCard(p, priced[i], par, PLAYER_COLORS[i % PLAYER_COLORS.length])).join('')}
                </div>

                <h3>Projected final score</h3>
                <p class="hint">Where each player was heading, decision by decision. Solid line is actual trajectory; dashed line is with no mistakes.</p>
                ${lineChart([...valueSeries, ...perfectSeries], v => v.toFixed(0), C)}
                ${legend([...valueSeries, ...perfectSeries])}

                <h3>Luck and decisions, accumulated</h3>
                <p class="hint">Cumulative luck and decision cost added together equal the difference between par and the final score.</p>
                ${lineChart([...luckSeries, ...costSeries], v => signed(v), C)}
                ${legend([...luckSeries, ...costSeries])}
                ${rollsChart}

                <h3>Costliest decisions</h3>
                ${tabs}
                <div id="blunder-container">
                    ${renderBlunders(selectedBlunderPlayer, priced, r, state.players)}
                </div>

        `;

        screen.querySelectorAll('.blunder-tab').forEach(tab => {
            tab.onclick = () => {
                selectedBlunderPlayer = Number(tab.dataset.idx);
                renderScreen();
            };
        });
    }

    renderScreen();
}

window.showAnalysis = showAnalysis;
