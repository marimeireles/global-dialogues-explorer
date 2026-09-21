// Trends page: one recurring Indicator poll across rounds, one small panel per group.
//
// Participants are different people every round, so each point is an independent
// cross-section: a share with its Wilson 95 % interval and its n, never a panel trajectory.
// The interval is computed in SQL so it follows the cross-filter.
import * as Plot from '@observablehq/plot';
import { Selection, makeClient } from '@uwdata/mosaic-core';
import { andFilter, initData, lit, sql } from './coordinator.js';
import { isDark, optionColors, scaleType } from './colors.js';
import { $, DIM, DIMS, bindTheme, createCombo, createPanels, el, fmt, onLight, pct, readFilters, rowsOf, status, swatch, tooltip, writeFilters } from './shared.js';

const ALL = 'All';
const TOP = 11; // group panels shown before "Show all"
const UK = 'GD6UK'; // same instrument as GD6, 95 % UK sample: shown as a marker, never on the line
const NOT_ASKED = /^(do\s?n[o']?t know|unsure|not sure|i'?m not sure|prefer not)/i;

const state = { ind: null, split: 'region', head: null, minn: 30, uk: false, more: false, sel: ALL, filters: {} };

function readUrl() {
  const p = new URLSearchParams(location.hash.slice(1));
  if (p.get('ind')) state.ind = p.get('ind');
  if (p.has('split') && (DIM[p.get('split')] || p.get('split') === '')) state.split = p.get('split');
  if (p.get('head')) state.head = p.get('head').split('|');
  if (p.has('minn')) state.minn = Math.max(0, Math.min(200, +p.get('minn') || 0));
  state.uk = p.get('uk') === '1';
  state.more = p.get('more') === '1';
  if (p.get('sel')) state.sel = p.get('sel');
  readFilters(p, state.filters);
}

function writeUrl() {
  const p = new URLSearchParams({ ind: state.ind, split: state.split, head: state.head.join('|'), minn: state.minn });
  if (state.uk) p.set('uk', 1);
  if (state.more) p.set('more', 1);
  if (state.sel !== ALL) p.set('sel', state.sel);
  writeFilters(p, state.filters);
  history.replaceState(null, '', `#${p}`);
}

const $cross = Selection.crossfilter();
let indicators = []; // [{ code, category, text, rounds }]
let wording = []; // per-round question rows of the current indicator
let options = []; // [{ key, label }] union across rounds, survey order
let trendData = [];
let distData = [];
let trendClient;
let distClient;
let combo;

// Panels count participants of the rounds in which this Indicator was asked (GD6UK only when shown).
const roundsSql = () => `round IN (${wording.filter((w) => state.uk || w.round !== UK).map((w) => lit(w.round)).join(', ') || "''"})`;
const panels = createPanels({
  selection: $cross,
  scope: roundsSql,
  filters: state.filters,
  onChange: () => { panels.renderChips(); writeUrl(); },
});

async function start() {
  try {
    await initData(status);
    readUrl();
    indicators = await sql(`
      SELECT indicator_code AS code, any_value(indicator_category) AS category,
             arg_max(question_text, round_order) AS text, count(DISTINCT round) AS rounds
      FROM questions WHERE indicator_code IS NOT NULL AND question_type LIKE 'Poll%'
      GROUP BY 1 HAVING count(DISTINCT round) > 1 ORDER BY category, min(order_in_survey)`);
    if (!indicators.some((i) => i.code === state.ind)) {
      state.ind = (indicators.find((i) => i.code === 'trust_personal_ai_chatbot') ?? indicators[0]).code;
      state.head = null;
    }
    $('#split').append(el('option', { value: '', textContent: 'None (everyone)' }), ...DIMS.map((d) => el('option', { value: d.key, textContent: d.label })));
    bindControls();
    await loadIndicator();
    await panels.load();
    panels.mount($('#panels'));
    trendClient = makeClient({
      selection: $cross, filterStable: false, query: trendQuery,
      queryResult: (t) => { trendData = rowsOf(t); renderTrends(); status(null); },
      queryError: (e) => status(String(e), true),
    });
    distClient = makeClient({
      selection: $cross, filterStable: false, query: distQuery,
      queryResult: (t) => { distData = rowsOf(t); renderDist(); },
    });
    $('.layout').hidden = false;
  } catch (e) {
    console.error(e);
    status(`Could not start: ${e.message ?? e}\nHas the data been built? Run \`make explorer-data\`.`, true);
  }
}

async function loadIndicator() {
  wording = await sql(`
    SELECT round, round_order, question_id, question_text, n_options FROM questions
    WHERE indicator_code = ${lit(state.ind)} AND question_type LIKE 'Poll%' ORDER BY round_order`);
  // Option labels drift in case between rounds; match on lower-case, show the latest wording.
  const rows = await sql(`
    SELECT lower(o.option) AS key, arg_max(o.option, o.round_order) AS label, min(o.option_order) AS ord
    FROM poll_options o JOIN questions q USING (round, question_id)
    WHERE q.indicator_code = ${lit(state.ind)} AND q.question_type LIKE 'Poll%' GROUP BY 1 ORDER BY ord, label`);
  options = rows;
  const keys = new Set(options.map((o) => o.key));
  if (!state.head?.length || !state.head.every((k) => keys.has(k))) state.head = defaultHeadline();
  syncControls();
}

/** Top-2 box on the positive arm of a bipolar scale, otherwise the first option. */
function defaultHeadline() {
  const scale = options.filter((o) => !NOT_ASKED.test(o.label));
  if (scaleType(options.map((o) => o.label)) === 'diverging') return scale.slice(-Math.floor(scale.length / 2)).map((o) => o.key);
  return scale.slice(0, 1).map((o) => o.key);
}

const indicator = () => indicators.find((i) => i.code === state.ind);
const headlineLabel = () => options.filter((o) => state.head.includes(o.key)).map((o) => o.label).join(' + ') || 'nothing selected';

// --------------------------------------------------------------------------- queries

function trendQuery(filter) {
  const seg = state.split || lit(ALL);
  const sets = state.split ? '((round, round_order, seg), (round, round_order))' : '((round, round_order))';
  const hits = state.head.map(lit).join(', ') || "''";
  // Wilson score interval, z = 1.96: z² = 3.8416, z²/2 = 1.9208, z²/4 = 0.9604.
  return `
    WITH answers AS (
      SELECT a.round, a.round_order, ${seg} AS seg, a.participant_id,
             max(CASE WHEN lower(a.option) IN (${hits}) THEN 1 ELSE 0 END) AS hit
      FROM poll_answers_x a JOIN questions q USING (round, question_id)
      WHERE q.indicator_code = ${lit(state.ind)} AND q.question_type LIKE 'Poll%'${andFilter(filter)}
      GROUP BY ALL),
    counts AS (
      SELECT round, round_order, seg, GROUPING(seg) AS all_segs, count(*)::DOUBLE AS n, sum(hit)::DOUBLE AS k
      FROM answers GROUP BY GROUPING SETS ${sets})
    SELECT round, round_order, seg, ${state.split ? 'all_segs' : '1 AS all_segs'}, n, k, k / n AS p,
           (k / n + 1.9208 / n - 1.96 * sqrt(k / n * (1 - k / n) / n + 0.9604 / (n * n))) / (1 + 3.8416 / n) AS lo,
           (k / n + 1.9208 / n + 1.96 * sqrt(k / n * (1 - k / n) / n + 0.9604 / (n * n))) / (1 + 3.8416 / n) AS hi
    FROM counts ORDER BY round_order`;
}

function distQuery(filter) {
  const seg = state.split && state.sel !== ALL ? ` AND a.${state.split} = ${lit(state.sel)}` : '';
  return `
    SELECT a.round, a.round_order, lower(a.option) AS key, count(*) AS n, count(DISTINCT a.participant_id) AS people,
           GROUPING(lower(a.option)) AS all_opts
    FROM poll_answers_x a JOIN questions q USING (round, question_id)
    WHERE q.indicator_code = ${lit(state.ind)} AND q.question_type LIKE 'Poll%'${seg}${andFilter(filter)}
    GROUP BY GROUPING SETS ((a.round, a.round_order, lower(a.option)), (a.round, a.round_order)) ORDER BY a.round_order`;
}

// ---------------------------------------------------------------------------- trends

function renderTrends() {
  const ind = indicator();
  $('#q-meta').textContent = [`Indicator: ${ind.code}`, ind.category, `${wording.filter((w) => w.round !== UK).length} rounds`].join(' · ');
  $('#q-text').textContent = ind.text;
  panels.renderChips();
  renderHeadline();

  const css = getComputedStyle(document.documentElement);
  const c = Object.fromEntries(['--series-1', '--surface', '--muted', '--ink-2', '--grid', '--ghost-bar'].map((v) => [v, css.getPropertyValue(v).trim()]));
  const rounds = wording.map((w) => w.round).filter((r) => state.uk || r !== UK);
  const bySeg = Map.groupBy(trendData, (r) => (r.all_segs ? ALL : r.seg));
  const order = state.split ? [ALL, ...DIM[state.split].levels.filter((v) => bySeg.has(v))] : [ALL];
  const shown = state.more ? order : order.slice(0, TOP + 1);
  if (!order.includes(state.sel)) state.sel = ALL;

  // One y-domain for every panel, so heights compare across groups.
  const visible = shown.flatMap((s) => bySeg.get(s) ?? []).filter((r) => (state.uk || r.round !== UK) && r.n >= Math.max(state.minn, 1));
  const lo = Math.max(0, Math.floor(Math.min(...visible.map((r) => r.lo), 1) * 10) / 10);
  const hi = Math.min(1, Math.ceil(Math.max(...visible.map((r) => r.hi), 0) * 10) / 10);
  const domain = lo < hi ? [lo, hi] : [0, 1];
  const textOf = new Map(wording.map((w) => [w.round, w.question_text]));

  $('#panels-grid').replaceChildren(...shown.map((seg) => {
    const rows = (bySeg.get(seg) ?? []).map((r) => ({ ...r, ok: r.n >= state.minn }));
    const line = rows.filter((r) => r.round !== UK);
    const uk = state.uk ? rows.filter((r) => r.round === UK) : [];
    const last = line.at(-1);
    const small = !line.some((r) => r.ok);
    const title = (r) => `${r.round} · ${pct(r.p, 1)}  (95% CI ${pct(r.lo, 1)}–${pct(r.hi, 1)})\n${fmt(r.k)} of ${fmt(r.n)} respondents${r.ok ? '' : ` · below minimum n (${state.minn})`}\n\n“${textOf.get(r.round)}”`;
    const tip = { fill: c['--surface'], stroke: c['--muted'], fontSize: 12, lineHeight: 1.25, lineWidth: 24, textPadding: 9 };
    const common = { width: 330, marginLeft: 34, marginRight: 12, style: { background: c['--surface'], color: c['--ink-2'], fontSize: '10.5px' }, x: { type: 'point', domain: rounds, padding: 0.5, label: null, tickSize: 0 } };
    const chart = Plot.plot({
      ...common, height: 150, marginTop: 8, marginBottom: 20,
      y: { domain, ticks: 4, tickFormat: (d) => `${Math.round(100 * d)}%`, grid: true, label: null, tickSize: 0 },
      marks: [
        Plot.areaY(line, { x: 'round', y1: 'lo', y2: 'hi', fill: c['--series-1'], fillOpacity: 0.18, clip: true }),
        Plot.lineY(line, { x: 'round', y: 'p', stroke: c['--series-1'], strokeWidth: 2, clip: true }),
        Plot.ruleX(uk, { x: 'round', y1: 'lo', y2: 'hi', stroke: '#eb6834', strokeWidth: 1.5 }),
        Plot.dot(uk, { x: 'round', y: 'p', symbol: 'diamond', r: 5, fill: c['--surface'], stroke: '#eb6834', strokeWidth: 1.5, title, tip, clip: true }),
        Plot.dot(line, { x: 'round', y: 'p', r: 4, fill: (r) => (r.ok ? c['--series-1'] : c['--surface']), stroke: (r) => (r.ok ? c['--surface'] : c['--muted']), strokeWidth: 1.5, title, tip, clip: true }),
      ],
    });
    // n per round as its own strip under the chart (a second chart, not a second axis).
    const strip = Plot.plot({
      ...common, height: 36, marginTop: 12, marginBottom: 2, x: { ...common.x, axis: null },
      y: { domain: [0, Math.max(...(bySeg.get(ALL) ?? []).map((r) => r.n), 1)], axis: null },
      marks: [
        Plot.ruleX(rows.filter((r) => rounds.includes(r.round)), { x: 'round', y1: 0, y2: 'n', stroke: c['--muted'], strokeOpacity: 0.3, strokeWidth: 14 }),
        Plot.text(rows.filter((r) => rounds.includes(r.round)), { x: 'round', y: 'n', text: (r) => fmt(r.n), dy: -6, fill: (r) => (r.ok ? c['--ink-2'] : c['--muted']), fontSize: 9.5 }),
      ],
    });
    const card = el('div', { className: `trend${seg === state.sel ? ' selected' : ''}${small ? ' small' : ''}`, role: 'button', tabIndex: 0, title: 'Click to show the full distribution below' },
      el('div', { className: 'trend-head' },
        el('b', { textContent: seg ?? '(none)' }),
        el('span', { textContent: last ? `${last.round}: ${pct(last.p)} · n ${fmt(last.n)}` : 'no respondents' })),
      chart, strip);
    const pick = () => { state.sel = seg; writeUrl(); renderTrends(); distClient.requestQuery(); };
    card.onclick = pick;
    card.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(); } };
    return card;
  }));

  $('#groups').replaceChildren(...(order.length > TOP + 1
    ? [el('button', { type: 'button', className: 'ghost link', textContent: state.more ? `Show top ${TOP} only` : `Show all ${order.length - 1} groups · ${order.length - 1 - TOP} more`, onclick: () => { state.more = !state.more; writeUrl(); renderTrends(); } })]
    : []));
  $('#chart-note').replaceChildren(
    el('span', { className: 'legend' },
      el('span', { className: 'key' }, el('i', { className: 'mark' }), `share choosing “${headlineLabel()}”`),
      el('span', { className: 'key' }, el('i', { className: 'band' }), 'Wilson 95% interval'),
      el('span', { className: 'key' }, el('i', { className: 'hollow' }), `fewer than ${state.minn} respondents`),
      el('span', { className: 'key' }, el('i', { className: 'nbar' }), 'respondents per round (n)'),
      state.uk ? el('span', { className: 'key' }, el('i', { className: 'diamond' }), 'GD6UK (UK-only sample, off the line)') : null),
    `Each round surveys different people, so a line joins independent samples, not the same respondents over time. Shares are of respondents to the question in that round and group. The y-axis is shared by all panels${domain[0] > 0 ? ' and does not start at zero' : ''}.`);
}

function renderHeadline() {
  $('#headline').replaceChildren(...options.map((o) => {
    const on = state.head.includes(o.key);
    return el('button', { type: 'button', className: `toggle${on ? ' on' : ''}`, ariaPressed: String(on), textContent: o.label, onclick: () => {
      state.head = on ? state.head.filter((k) => k !== o.key) : [...state.head, o.key];
      writeUrl();
      trendClient.requestQuery();
    } });
  }));
}

// ---------------------------------------------------------------------- distribution

function renderDist() {
  const labels = options.map((o) => o.label);
  const pal = optionColors(labels, { dark: isDark() });
  $('#dist-title').textContent = `Full distribution per round · ${state.split && state.sel !== ALL ? `${DIM[state.split].label}: ${state.sel}` : 'everyone'}`;
  $('#legend').replaceChildren(...options.map((o) => el('span', { className: 'key' }, swatch(pal.fills.get(o.label)), o.label)));
  const byRound = Map.groupBy(distData, (r) => r.round);
  const rounds = wording.map((w) => w.round).filter((r) => (state.uk || r !== UK) && byRound.has(r));
  $('#dist').replaceChildren(el('div', { className: 'rows' }, rounds.flatMap((round) => {
    const rows = byRound.get(round);
    const n = rows.find((r) => r.all_opts)?.people ?? 0;
    const small = n < state.minn;
    const cls = small ? 'small ' : '';
    const bar = el('div', { className: 'bar' }, options.map((o) => {
      const k = rows.find((r) => !r.all_opts && r.key === o.key)?.n ?? 0;
      if (!k) return null;
      const fill = pal.fills.get(o.label);
      const part = el('div', { className: `part${onLight(fill) ? ' on-light' : ''}`, textContent: k / n >= 0.065 ? Math.round(100 * k / n) : '', tabIndex: 0 });
      part.style.cssText = `flex:${k} 1 0;background:${fill}`;
      tooltip(part, () => [
        el('div', { className: 't-head' }, swatch(fill), el('span', { textContent: o.label })),
        el('div', { className: 't-row' }, el('b', { textContent: pct(k / n, 1) }), ` · ${fmt(k)} of ${fmt(n)} respondents`),
        el('div', { className: 't-row', textContent: `${round}${small ? ` · below minimum n (${state.minn})` : ''}` })]);
      return part;
    }));
    return [
      el('div', { className: `${cls}seg-label`, textContent: round }),
      el('div', { className: cls.trim() }, bar),
      el('div', { className: `${cls}seg-n`, textContent: `n = ${fmt(n)}${small ? ' · below min' : ''}` })];
  }), el('div', { className: 'axis' }, ['0%', '25%', '50%', '75%', '100%'].map((t) => el('span', { textContent: t })))));

  $('#wording').replaceChildren(el('table', {},
    el('thead', {}, el('tr', {}, el('th', { textContent: 'Round' }), el('th', { textContent: 'Question as asked' }), el('th', { textContent: 'Options' }))),
    el('tbody', {}, wording.map((w) => el('tr', {}, el('td', { textContent: w.round }), el('td', { textContent: w.question_text }), el('td', { textContent: w.n_options }))))));
}

// -------------------------------------------------------------------------- controls

function syncControls() {
  $('#split').value = state.split;
  $('#minn').value = state.minn;
  $('#minn-out').textContent = state.minn;
  $('#uk').checked = state.uk;
  combo?.setLabel(indicator()?.text ?? '');
  writeUrl();
}

function requery() { trendClient.requestQuery(); distClient.requestQuery(); }

function bindControls() {
  $('#split').onchange = (e) => { state.split = e.target.value; state.sel = ALL; state.more = false; syncControls(); requery(); };
  $('#minn').oninput = (e) => { state.minn = +e.target.value; syncControls(); renderTrends(); renderDist(); };
  $('#uk').onchange = async (e) => { state.uk = e.target.checked; syncControls(); await panels.rescope({ keepFilters: true }); renderTrends(); renderDist(); };
  $('#clear').onclick = panels.clearAll;
  bindTheme(() => { renderTrends(); renderDist(); });
  combo = createCombo($('#indicator-combo'), {
    placeholder: 'Search indicators…',
    current: () => state.ind,
    items: () => indicators.map((i) => ({ id: i.code, label: i.text, group: i.category.replaceAll('_', ' '), tag: `${i.rounds} rounds`, search: i.code })),
    onPick: async (code) => {
      state.ind = code; state.head = null; state.sel = ALL;
      await loadIndicator();
      await panels.rescope({ keepFilters: true });
      requery();
    },
  });
}

start();
