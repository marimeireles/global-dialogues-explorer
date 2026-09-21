// Deep-consensus page: one claim as a PDG (S stance, R reason theme, G group), drawn from the
// JSON that tools/pdg/build_claim_pdg.py precomputed. No DuckDB here; everything is in the JSON.
import { isDark } from './colors.js';
import { $, bindTheme, el, fmt, pct, status } from './shared.js';

const CLAIM = 'gd3_q14';
const STANCE_FILL = { agree: '#1baf7a', disagree: '#eb6834' };
const GROUP_FILLS = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#4a3aa7', '#e34948', '#008300'];
const RAMP = { light: ['#dbe7f7', '#0d366b'], dark: ['#2a3542', '#9ec5f4'] };
const NS = 'http://www.w3.org/2000/svg';

const state = { dim: 'none', pinned: null };
let D; // the JSON

function svg(tag, attrs = {}, ...kids) {
  const n = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') n.setAttribute('class', v);
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else n.setAttribute(k, v);
  }
  n.append(...kids.flat().filter((k) => k != null));
  return n;
}
const text = (x, y, s, attrs = {}) => svg('text', { x, y, ...attrs }, s);
const hex = (c) => [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16));
const lerp = (a, b, t) => `#${hex(a).map((v, i) => Math.round(v + (hex(b)[i] - v) * t).toString(16).padStart(2, '0')).join('')}`;
const ramp = (t) => lerp(...RAMP[isDark() ? 'dark' : 'light'], Math.max(0, Math.min(1, t)));
const bits = (x, d = 1) => (x == null ? '–' : x.toFixed(d));
const groupFill = (dim, g) => {
  const gs = D.dims[dim].groups;
  const i = gs.indexOf(g);
  return g.startsWith('other') || g === '(none)' ? '#9a988f' : GROUP_FILLS[i % GROUP_FILLS.length];
};

/** Which group an answer belongs to under a dimension (mirrors group_of in the builder). */
function groupOf(a, dim) {
  if (dim === 'none') return 'everyone';
  const gs = D.dims[dim].groups;
  const v = (dim === 'country' ? a.country : a.ai_feeling) ?? '(none)';
  return gs.includes(v) ? v : gs.at(-1);
}

// ------------------------------------------------------------------------- bootstrap

async function start() {
  try {
    const p = new URLSearchParams(location.hash.slice(1));
    const res = await fetch(new URL(`data/pdg_${CLAIM}.json`, document.baseURI));
    if (!res.ok) throw new Error(`${res.status} loading pdg_${CLAIM}.json`);
    D = await res.json();
    if (D.dims[p.get('dim')]) state.dim = p.get('dim');
    $('#dims').append(...Object.entries(D.dims).map(([k, d]) =>
      el('button', { type: 'button', role: 'radio', textContent: d.label, ariaChecked: String(k === state.dim), onclick: () => setDim(k) })));
    $('#unpin').onclick = () => { state.pinned = null; render(); };
    bindTheme(render);
    $('#q-meta').textContent = `${D.claim.round} · agree / disagree poll + “Please explain whether you agree or disagree and why” · ${fmt(D.answers.length)} people with a vote and a written reason`;
    $('#q-text').textContent = `“${D.claim.claim}”`;
    status(null);
    $('.layout').hidden = false;
    render();
  } catch (e) {
    console.error(e);
    status(`Could not load: ${e.message}\nRun \`.venv/bin/python tools/pdg/build_claim_pdg.py\` first.`, true);
  }
}

function setDim(k) {
  state.dim = k;
  state.pinned = null;
  history.replaceState(null, '', `#dim=${k}`);
  for (const b of $('#dims').children) b.ariaChecked = String(b.textContent === D.dims[k].label);
  render();
}

function render() {
  renderGraph();
  renderReadout();
  renderInspector(state.pinned ?? { kind: 'intro' });
}

// ------------------------------------------------------------------------ inspector

/** Hover shows `item` unless something is pinned; click pins / unpins. */
function hook(node, item) {
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  node.addEventListener('pointerenter', () => { if (!state.pinned) renderInspector(item); });
  node.addEventListener('pointerleave', () => { if (!state.pinned) renderInspector({ kind: 'intro' }); });
  node.addEventListener('click', (e) => {
    e.stopPropagation();
    state.pinned = state.pinned && same(state.pinned, item) ? null : item;
    render();
  });
}

function renderInspector(item) {
  const box = $('#inspector');
  $('#unpin').hidden = !state.pinned;
  $('#inspector-title').textContent = state.pinned ? 'Inspector · pinned' : 'Inspector';
  const dim = D.dims[state.dim];
  const body = {
    intro: () => [el('p', { className: 'note', style: 'margin:0', textContent: 'Hover an arrow, a value, a theme or a number in the readout. Click to keep it here.' }),
      el('h4', { textContent: 'Method' }),
      el('div', { className: 'kv' },
        el('div', { textContent: 'smoothing' }), el('div', { textContent: `${D.method.smoothing} pseudo-count per cell` }),
        el('div', { textContent: 'themes' }), el('div', { textContent: `${D.themes.length}; fewer than ${D.method.min_theme_n} people → “other”; “${D.method.dropped_theme}” dropped from R` }),
        el('div', { textContent: 'β' }), el('div', { textContent: D.method.beta }),
        el('div', { textContent: 'null' }), el('div', { textContent: `${D.method.n_perm} permutations of the group labels` }),
        el('div', { textContent: 'solver' }), el('div', { textContent: D.method.solver }))],
    claim: () => [el('h3', { textContent: 'Claim (label node)' }), el('p', { textContent: D.claim.claim }),
      el('p', { className: 'note', textContent: 'Not a variable: it stands for the unit source of the unconditional arcs (∅ → G, ∅ → S).' }),
      el('div', { className: 'kv' }, el('div', { textContent: 'poll' }), el('div', { textContent: D.claim.poll_qid }), el('div', { textContent: 'reason' }), el('div', { textContent: D.claim.reason_qid }))],
    arcS: ({ g }) => arcSView(dim, g),
    arcR: ({ g }) => arcRView(dim, g),
    arcG: () => [el('h3', { textContent: `∅ → G · P(${dim.label})` }), el('p', { className: 'note', textContent: 'The group split itself; it takes part in no comparison, so it carries no inconsistency.' }),
      tableOf(['group', 'n', 'p'], dim.groups.map((g) => [g, fmt(dim.n[g]), pct(dim.n[g] / D.answers.length, 1)]))],
    group: ({ g }) => groupView(dim, g),
    stance: ({ s }) => stanceView(s),
    theme: ({ t }) => themeView(t),
    cell: ({ pair, s }) => cellView(dim, pair, s),
    vote: ({ pair }) => voteView(dim, pair),
    joint: () => jointView(dim),
  }[item.kind](item);
  box.replaceChildren(...body);
}

function tableOf(head, rows, opts = {}) {
  return el('table', {}, el('thead', {}, el('tr', {}, head.map((h) => el('th', { textContent: h })))),
    el('tbody', {}, rows.map((r, i) => el('tr', { className: opts.rowClass?.(i) ?? '' }, r.map((c) => el('td', {}, c))))));
}

function arcSView(dim, g) {
  const t = dim.tables[g];
  const share = dim.joint.arcs[`S${g}`];
  return [el('h3', { textContent: `${state.dim === 'none' ? '∅' : g} → S · P(stance${state.dim === 'none' ? '' : ` | ${g}`})` }),
    el('div', { className: 'kv' }, el('div', { textContent: 'β' }), el('div', { textContent: `${fmt(t.nS)} people` }),
      el('div', { textContent: 'inconsistency' }), el('div', { textContent: `${bits(share, 2)} bits at the optimum (${dim.joint.bits ? pct(share / dim.joint.bits) : '0%'} of ${bits(dim.joint.bits)})` })),
    tableOf(['stance', 'count', 'P (smoothed)'], D.stances.map((s, i) => [s, fmt(t.cS[i]), pct(t.pS[i], 1)]))];
}

function arcRView(dim, g) {
  const t = dim.tables[g];
  const share = dim.joint.arcs[`R${g}`];
  return [el('h3', { textContent: `S → R${state.dim === 'none' ? '' : ` · ${g}`} · P(reason | stance)` }),
    el('div', { className: 'kv' }, el('div', { textContent: 'β' }), el('div', { textContent: `${fmt(t.nR)} people with a codeable reason` }),
      el('div', { textContent: 'inconsistency' }), el('div', { textContent: `${bits(share, 2)} bits at the optimum (${dim.joint.bits ? pct(share / dim.joint.bits) : '0%'} of ${bits(dim.joint.bits)})` })),
    tableOf(['theme', 'agree', 'disagree'], D.themes.map((th, j) => [th, ...D.stances.map((s, i) => `${fmt(t.cR[i][j])} · ${pct(t.pR[i][j])}`)])),
    el('p', { className: 'note', textContent: 'Each column is one row of the conditional table: count, then the smoothed probability of the theme given that stance.' })];
}

function groupView(dim, g) {
  const t = dim.tables[g];
  return [el('h3', { textContent: `${dim.label}: ${g}` }),
    el('div', { className: 'kv' }, el('div', { textContent: 'people' }), el('div', { textContent: `${fmt(t.nS)} (${fmt(t.nR)} with a codeable reason)` }),
      el('div', { textContent: 'stance' }), el('div', { textContent: D.stances.map((s, i) => `${s} ${pct(t.cS[i] / t.nS)}`).join(' · ') })),
    el('h4', { textContent: 'Reasons given, by stance' }),
    compare(D.themes, D.stances.map((s, i) => ({ label: s, p: t.pR[i], n: t.cR[i].reduce((a, b) => a + b, 0), fill: STANCE_FILL[s] })))];
}

function stanceView(s) {
  const i = D.stances.indexOf(s);
  const t = D.dims.none.tables.everyone;
  return [el('h3', { textContent: `S = ${s}` }),
    el('div', { className: 'kv' }, el('div', { textContent: 'people' }), el('div', { textContent: `${fmt(t.cS[i])} of ${fmt(t.nS)} (${pct(t.cS[i] / t.nS, 1)})` })),
    el('h4', { textContent: `P(reason | ${s})` }),
    compare(D.themes, [{ label: s, p: t.pR[i], n: t.cR[i].reduce((a, b) => a + b, 0), fill: STANCE_FILL[s] }])];
}

function themeView(t) {
  const list = D.answers.filter((a) => a.theme === t);
  const c = D.theme_counts[t];
  const LIMIT = 40;
  const show = (n) => {
    $('#theme-list').replaceChildren(...list.slice(0, n).map((a) => el('article', { className: 'answer' },
      el('p', {}, el('span', { className: `badge ${a.stance}`, textContent: a.stance }), a.text),
      el('div', { className: 'meta', textContent: [a.country, a.age, a.ai_feeling, t === 'other' ? a.theme_raw : null].filter(Boolean).join(' · ') }))),
    list.length > n ? el('button', { type: 'button', className: 'ghost link list-more', textContent: `Show all ${list.length}`, onclick: () => show(list.length) }) : null);
  };
  const box = el('div', { id: 'theme-list' });
  queueMicrotask(() => show(LIMIT));
  return [el('h3', { textContent: t }),
    el('div', { className: 'kv' }, el('div', { textContent: 'people' }), el('div', { textContent: `${fmt(list.length)}: ${fmt(c.agree)} agree · ${fmt(c.disagree)} disagree` }),
      t === 'other' ? [el('div', { textContent: 'merges' }), el('div', { textContent: D.theme_raw_members[t].join(', ') })] : null),
    el('p', { className: 'note', textContent: 'Theme = Remesh’s Tag 1 for the written reason (auto-coded, per-question codebook). Every reason under it:' }),
    box];
}

/** Side-by-side bars of one or two distributions over the themes. */
function compare(labels, series) {
  const max = Math.max(...series.flatMap((s) => s.p));
  const bar = (p, fill) => el('div', { className: 'b' }, Object.assign(el('i'), { style: `width:${100 * p / max}%;background:${fill}` }));
  return el('div', { className: 'cmp', style: series.length === 1 ? 'grid-template-columns: minmax(0,1.4fr) 1fr' : '' },
    el('div'), series.map((s) => el('div', { className: 'h', textContent: `${s.label} · n ${fmt(s.n)}` })),
    labels.flatMap((l, j) => [el('div', { className: 'nm', textContent: l, title: l }), series.map((s) => el('div', { title: pct(s.p[j], 1) }, bar(s.p[j], s.fill)))]));
}

function nullBand(obs, nul, max) {
  const top = Math.max(max, obs, nul.p95) * 1.15;
  return el('div', { className: 'nullband' }, '0',
    el('div', { className: 'band', title: `null: mean ${bits(nul.mean)}, sd ${bits(nul.sd)}, 95th percentile ${bits(nul.p95)} (${nul.n} permutations)` },
      Object.assign(el('em'), { style: `left:0;width:${100 * nul.p95 / top}%` }),
      Object.assign(el('i', { title: `observed ${bits(obs)} bits` }), { style: `left:${100 * obs / top}%` })),
    `${bits(top, 0)} bits`);
}

function cellView(dim, pair, s) {
  const [a, b] = pair.split('|');
  const pr = dim.pairs[pair];
  const c = pr.cells[s];
  const i = D.stances.indexOf(s);
  const ta = dim.tables[a], tb = dim.tables[b];
  const verdict = {
    deep: 'Deep consensus at the tag level: the two groups’ reasons for this stance are indistinguishable, and the sample was large enough to have seen a difference of the size found elsewhere.',
    shallow: 'Shallow consensus: same vote, different reasons. The inconsistency exceeds what permuting the group labels produces.',
    underpowered: 'Underpowered: no detectable difference, but a difference of the size seen elsewhere would not have been detectable at this n either. No claim.',
    'no data': 'One of the groups has nobody with this stance and a codeable reason.',
  }[c.label];
  return [el('h3', { textContent: `Reasons for “${s}”: ${a} vs ${b}` }),
    el('div', { className: 'verdict' }, el('span', { className: `lab ${c.label}`, textContent: c.label }), el('b', { textContent: `${bits(c.bits)} bits × people · ${c.bits_per_person == null ? '' : `${(c.bits_per_person).toFixed(3)} bits per person`}` }), verdict),
    c.null ? nullBand(c.bits ?? 0, c.null, c.power.threshold_bits ?? 0) : null,
    el('div', { className: 'kv' },
      el('div', { textContent: 'n' }), el('div', { textContent: `${fmt(c.n[0])} (${a}) and ${fmt(c.n[1])} (${b}) people with this stance and a codeable reason; β = these counts` }),
      el('div', { textContent: 'null' }), el('div', { textContent: c.null ? `mean ${bits(c.null.mean)} · sd ${bits(c.null.sd)} · 95th percentile ${bits(c.null.p95)} bits` : '–' }),
      el('div', { textContent: 'power' }), el('div', { textContent: c.power.median_effect_bits_per_person == null ? '–' : `a difference of the median size seen in the other cells (${c.power.median_effect_bits_per_person.toFixed(3)} bits/person) would give ${bits(c.power.threshold_bits)} bits at this n, which ${c.power.passes ? 'exceeds' : 'does not exceed'} the null 95th percentile` })),
    el('h4', { textContent: `P(reason | ${s}) in each group` }),
    compare(D.themes, [{ label: a, p: ta.pR[i], n: c.n[0], fill: groupFill(state.dim, a) }, { label: b, p: tb.pR[i], n: c.n[1], fill: groupFill(state.dim, b) }])];
}

function voteView(dim, pair) {
  const [a, b] = pair.split('|');
  const pr = dim.pairs[pair];
  const v = pr.vote_cell;
  const ta = dim.tables[a], tb = dim.tables[b];
  return [el('h3', { textContent: `Vote: ${a} vs ${b}` }),
    el('div', { className: 'verdict' }, el('span', { className: `lab ${v.above_null ? 'above' : 'within'}`, textContent: v.above_null ? 'groups vote differently' : 'within the null band' }),
      el('b', { textContent: `${bits(v.bits)} bits × people` }), 'Inconsistency of the two groups’ P(stance) tables on one S node, β = each group’s size.'),
    nullBand(v.bits, v.null, 0),
    el('div', { className: 'kv' }, el('div', { textContent: 'null' }), el('div', { textContent: `mean ${bits(v.null.mean)} · 95th percentile ${bits(v.null.p95)} bits` }),
      el('div', { textContent: 'combined' }), el('div', { textContent: `⟨⟨M_${a} + M_${b}⟩⟩ − ⟨⟨M_${a}⟩⟩ − ⟨⟨M_${b}⟩⟩ = ${bits(pr.combined)} bits (null 95th ${bits(pr.null.combined.p95)}); per arc: ${Object.entries(pr.combined_arcs).map(([k, x]) => `${k} ${bits(x)}`).join(', ')}` })),
    tableOf(['stance', a, b], D.stances.map((s, i) => [s, `${fmt(ta.cS[i])} · ${pct(ta.pS[i], 1)}`, `${fmt(tb.cS[i])} · ${pct(tb.pS[i], 1)}`]))];
}

function jointView(dim) {
  const j = dim.joint;
  return [el('h3', { textContent: `All ${dim.label.toLowerCase()} groups on one model` }),
    el('div', { className: 'verdict' }, el('b', { textContent: `${bits(j.bits)} bits × people` }), 'One S node and one R node; every group contributes its ∅ → S and S → R tables with β = its size. This is what the arrow colours show.'),
    j.null ? nullBand(j.bits, j.null, 0) : null,
    j.null ? el('div', { className: 'kv' }, el('div', { textContent: 'null' }), el('div', { textContent: `mean ${bits(j.null.mean)} · 95th percentile ${bits(j.null.p95)} bits` })) : null,
    el('h4', { textContent: 'Per arc' }),
    tableOf(['arc', 'bits', 'share'], Object.entries(j.arcs).sort((x, y) => y[1] - x[1]).map(([k, x]) => [`${k[0] === 'S' ? '∅ → S' : 'S → R'} · ${k.slice(1)}`, bits(x, 2), j.bits ? pct(x / j.bits) : '–']))];
}

// ---------------------------------------------------------------------------- graph

function renderGraph() {
  const dim = D.dims[state.dim];
  const grouped = state.dim !== 'none';
  const groups = dim.groups;
  const themes = D.themes;
  const maxTheme = Math.max(...themes.map((t) => D.theme_counts[t].agree + D.theme_counts[t].disagree));
  const maxBeta = Math.max(...groups.map((g) => dim.tables[g].nS));
  const width = (beta) => 1.5 + 7 * Math.sqrt(beta / maxBeta);
  const maxArc = Math.max(1e-9, ...Object.values(dim.joint.arcs));
  const share = (k) => (dim.joint.bits ? (dim.joint.arcs[k] ?? 0) / maxArc : 0);
  const pinnedIs = (item) => state.pinned && JSON.stringify(state.pinned) === JSON.stringify(item);

  // layout
  const X = { claim: 20, g: 20, s: 370, r: 640 };
  const yTop = 150;
  const rowH = 27;
  const H = Math.max(yTop + 90 + themes.length * rowH, grouped ? yTop + 90 + groups.length * 30 : 0) + 20;
  const root = svg('svg', { width: 920, height: H, viewBox: `0 0 920 ${H}` },
    svg('defs', {}, svg('marker', { id: 'ah', viewBox: '0 0 10 10', refX: 9, refY: 5, markerWidth: 5, markerHeight: 5, orient: 'auto-start-reverse' },
      svg('path', { d: 'M1 1 L9 5 L1 9', fill: 'none', stroke: 'context-stroke', 'stroke-width': 1.6, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }))));

  const node = (x, y, w, h, cls, lines, item, sub = false) => {
    const g = svg('g', { class: `${sub ? 'sub' : 'node'} ${cls}${item ? ' hoverable' : ''}${item && pinnedIs(item) ? ' pinned' : ''}`, transform: `translate(${x},${y})` },
      svg('rect', { width: w, height: h, rx: sub ? 5 : 8 }),
      lines.map((l, i) => text(10, 17 + i * 15, l.t, { class: l.cls ?? '' })));
    if (item) hook(g, item);
    root.append(g);
    return { x, y, w, h, cx: x + w / 2, cy: y + h / 2 };
  };
  const wrap = (s, n) => s.split(' ').reduce((acc, w) => { const last = acc.at(-1); if (last && (last + ' ' + w).length <= n) acc[acc.length - 1] = last + ' ' + w; else acc.push(w); return acc; }, []);

  const claimLines = wrap(D.claim.claim, 42);
  const claim = node(X.claim, 20, 250, 24 + claimLines.length * 15, 'claim', [{ t: 'Claim', cls: 'varlabel' }, ...claimLines.map((t) => ({ t }))], { kind: 'claim' });
  const S = node(X.s, yTop, 130, 42, 's', [{ t: 'S · stance', cls: 'varlabel' }, { t: 'agree / disagree' }]);
  const R = node(X.r, yTop, 130, 42, 'r', [{ t: 'R · reason', cls: 'varlabel' }, { t: `${themes.length} themes` }]);
  let G = null;
  const gsub = {};
  if (grouped) {
    G = node(X.g, yTop, 250, 42, 'g', [{ t: `G · ${dim.label.toLowerCase()}`, cls: 'varlabel' }, { t: `${groups.length} groups` }], { kind: 'arcG' });
    groups.forEach((g, i) => {
      const y = yTop + 62 + i * 30;
      gsub[g] = node(X.g + 20, y, 230, 24, '', [{ t: `${g}  ·  n ${fmt(dim.n[g])}` }], { kind: 'group', g });
      root.append(svg('path', { class: 'fan', d: `M${X.g + 30} ${yTop + 42} V${y}` }));
      root.append(svg('circle', { cx: X.g + 10, cy: y + 12, r: 4, fill: groupFill(state.dim, g) }));
    });
  }
  // stance sub-nodes
  const all = D.dims.none.tables.everyone;
  const ssub = {};
  D.stances.forEach((s, i) => {
    const y = yTop + 62 + i * 30;
    ssub[s] = node(X.s + 20, y, 150, 24, '', [{ t: `${s}  ·  ${fmt(all.cS[i])}` }], { kind: 'stance', s });
    root.append(svg('path', { class: 'fan', d: `M${X.s + 30} ${yTop + 42} V${y}` }));
    root.append(svg('circle', { cx: X.s + 10, cy: y + 12, r: 4, fill: STANCE_FILL[s] }));
  });
  // theme sub-nodes with two-colour bars
  themes.forEach((t, i) => {
    const y = yTop + 62 + i * rowH;
    const c = D.theme_counts[t];
    const g = svg('g', { class: `sub hoverable themebar${pinnedIs({ kind: 'theme', t }) ? ' pinned' : ''}`, transform: `translate(${X.r + 20},${y})` },
      svg('rect', { width: 260, height: 22, rx: 5 }),
      text(8, 15, t.length > 27 ? `${t.slice(0, 26)}…` : t, {}),
      svg('rect', { x: 178, y: 6, width: 76 * c.agree / maxTheme, height: 10, style: `fill:${STANCE_FILL.agree};stroke:none` }),
      svg('rect', { x: 178 + 76 * c.agree / maxTheme + (c.agree && c.disagree ? 1 : 0), y: 6, width: 76 * c.disagree / maxTheme, height: 10, style: `fill:${STANCE_FILL.disagree};stroke:none` }),
      svg('title', {}, `${t}: ${c.agree} agree, ${c.disagree} disagree`));
    hook(g, { kind: 'theme', t });
    root.append(svg('path', { class: 'fan', d: `M${X.r + 30} ${yTop + 42} V${y}` }), g);
  });

  // arcs
  const arc = (x1, y1, x2, y2, bend, beta, sh, item, label) => {
    const dx = x2 - x1;
    const d = `M${x1} ${y1} C${x1 + dx * 0.45} ${y1 + bend}, ${x2 - dx * 0.45} ${y2 + bend}, ${x2} ${y2}`;
    const hit = svg('path', { class: 'hit', d });
    const path = svg('path', { class: 'arc', d, stroke: ramp(sh), 'stroke-width': width(beta).toFixed(1), 'marker-end': 'url(#ah)' });
    hook(hit, item);
    root.append(hit, path);
    if (label) root.append(text((x1 + x2) / 2, (y1 + y2) / 2 + bend * 0.75 + (bend ? -5 : -7), label, { class: 'arc-label', 'text-anchor': 'middle' }));
  };
  const varc = (x1, y1, x2, y2, beta, item, label) => {
    const d = `M${x1} ${y1} L${x2} ${y2}`;
    const hit = svg('path', { class: 'hit', d });
    hook(hit, item);
    root.append(hit, svg('path', { class: 'arc', d, stroke: ramp(0), 'stroke-width': width(beta).toFixed(1), 'marker-end': 'url(#ah)' }),
      text(x1 + 8, (y1 + y2) / 2 + 4, label, { class: 'arc-label' }));
  };
  if (!grouped) {
    arc(claim.x + claim.w, claim.cy, S.x, S.cy, 0, all.nS, share('Severyone'), { kind: 'arcS', g: 'everyone' }, '∅ → S');
    arc(S.x + S.w, S.cy, R.x, R.cy, 0, all.nR, share('Reveryone'), { kind: 'arcR', g: 'everyone' }, 'S → R');
  } else {
    varc(claim.cx, claim.y + claim.h, G.cx, G.y, D.answers.length, { kind: 'arcG' }, '∅ → G');
    // one S -> R arc per group, fanned; and each group's own P(S) into S
    groups.forEach((g, i) => {
      const t = dim.tables[g];
      const sub = gsub[g];
      arc(sub.x + sub.w, sub.cy, S.x, S.cy + (i - (groups.length - 1) / 2) * 5, 0, t.nS, share(`S${g}`), { kind: 'arcS', g });
      const bend = -70 + i * (140 / Math.max(groups.length - 1, 1));
      arc(S.x + S.w, S.cy, R.x, R.cy, bend, t.nR, share(`R${g}`), { kind: 'arcR', g }, g);
    });
    // junction dot on the fan-in side of S: the (G, S) -> R hyperarc is drawn as its per-group rows
    root.append(svg('circle', { class: 'junction', cx: S.x - 12, cy: S.cy, r: 3.5 }), svg('title', {}, 'junction: G → S rows'));
  }
  $('#graph').replaceChildren(root);

  $('#graph-legend').replaceChildren(
    el('span', { className: 'key' }, sw(STANCE_FILL.agree), 'agree'),
    el('span', { className: 'key' }, sw(STANCE_FILL.disagree), 'disagree'),
    el('span', { className: 'key' }, sw(ramp(0)), sw(ramp(0.5)), sw(ramp(1)), `arc’s share of the between-group inconsistency: darkest = the largest arc (${bits(maxArc)} of ${bits(dim.joint.bits)} bits)`),
    grouped ? el('span', { className: 'key', textContent: 'one S → R arc per group = the (G, S) → R hyperarc, row by row' }) : null);
}

const sw = (fill) => Object.assign(el('i', { className: 'swatch' }), { style: `background:${fill}` });

// -------------------------------------------------------------------------- readout

function renderReadout() {
  const dim = D.dims[state.dim];
  const pinnedIs = (item) => state.pinned && JSON.stringify(state.pinned) === JSON.stringify(item);
  $('#readout-title').textContent = state.dim === 'none' ? 'Consensus readout' : `Consensus readout · by ${dim.label.toLowerCase()}`;
  if (state.dim === 'none') {
    $('#readout-sub').textContent = 'Pick a group dimension above. With no groups every table comes from one sample, so the PDG is consistent by construction (0 bits).';
    $('#readout').replaceChildren();
    $('#readout-legend').replaceChildren();
    return;
  }
  $('#readout-sub').textContent = 'Per pair of groups: do they vote alike (vote-level bits), and among those who voted the same way, do they give the same reasons (reason-level bits, per stance)? Bits above the null 95th percentile mean a real difference. Hover a number for the tables behind it.';
  const cellTd = (pair, s) => {
    const c = dim.pairs[pair].cells[s];
    const item = { kind: 'cell', pair, s };
    const td = el('td', { className: `cell ${c.label}${pinnedIs(item) ? ' pinned' : ''}` },
      c.bits == null ? '–' : [`${bits(c.bits)} `, el('span', { className: `lab ${c.label}`, textContent: c.label }),
        el('span', { className: 'small', textContent: `null95 ${bits(c.null?.p95)} · n ${fmt(c.n[0])} / ${fmt(c.n[1])}` })]);
    hook(td, item);
    return td;
  };
  const voteTd = (pair) => {
    const v = dim.pairs[pair].vote_cell;
    const item = { kind: 'vote', pair };
    const td = el('td', { className: `cell${pinnedIs(item) ? ' pinned' : ''}` }, `${bits(v.bits)} `,
      el('span', { className: `lab ${v.above_null ? 'above' : 'within'}`, textContent: v.above_null ? 'differ' : 'alike' }),
      el('span', { className: 'small', textContent: `null95 ${bits(v.null.p95)} · n ${fmt(v.n[0])} / ${fmt(v.n[1])}` }));
    hook(td, item);
    return td;
  };
  const jointItem = { kind: 'joint' };
  const jointTd = el('td', { className: `cell${pinnedIs(jointItem) ? ' pinned' : ''}`, colSpan: 3 }, `${bits(dim.joint.bits)} bits`, el('span', { className: 'small', textContent: dim.joint.null ? `null95 ${bits(dim.joint.null.p95)}` : '' }));
  hook(jointTd, jointItem);
  $('#readout').replaceChildren(el('div', { className: 'readout' }, el('table', {},
    el('thead', {},
      el('tr', {}, el('th'), el('th', { textContent: 'Vote level' }), el('th', { textContent: 'Reason level', colSpan: 2 })),
      el('tr', {}, el('th', { textContent: 'group pair' }), el('th', { textContent: 'P(stance) · bits' }), D.stances.map((s) => el('th', { textContent: `among “${s}” · bits` })))),
    el('tbody', {},
      Object.keys(dim.pairs).map((pair) => el('tr', {}, el('td', {}, ...pair.split('|').flatMap((g, i) => [i ? ' vs ' : '', sw(groupFill(state.dim, g)), ` ${g}`])), voteTd(pair), D.stances.map((s) => cellTd(pair, s)))),
      el('tr', { className: 'joint' }, el('td', { textContent: 'all groups on one model' }), jointTd)))));
  $('#readout-legend').replaceChildren(
    el('span', { className: 'key' }, el('span', { className: 'lab deep', textContent: 'deep' }), 'within the null band and the power check passes'),
    el('span', { className: 'key' }, el('span', { className: 'lab underpowered', textContent: 'underpowered' }), 'within the null band, but a difference of the usual size could not have been seen at this n'),
    el('span', { className: 'key' }, el('span', { className: 'lab shallow', textContent: 'shallow' }), 'above the null band: same vote, different reasons'));
}

document.addEventListener('click', (e) => { if (state.pinned && !e.target.closest('#inspector, .hoverable, .hit, td.cell')) { state.pinned = null; render(); } });
start();
