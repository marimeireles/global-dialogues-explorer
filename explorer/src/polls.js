// Polls page: one poll, split by a demographic dimension, cross-filtered by the others.
//
// Every view is a Mosaic client on one crossfilter Selection. The views are rendered by
// hand (HTML bars) rather than with vgplot marks because they need per-row n labels,
// below-minimum-n greying, per-group show/hide and click-through to answers.
import { Selection, makeClient } from '@uwdata/mosaic-core';
import { andFilter, initData, lit, sql } from './coordinator.js';
import { isDark, optionColors } from './colors.js';
import { $, DIM, DIMS, bindTheme, createCombo, createPanels, el, fmt, onLight, pct, readFilters, rowsOf, status, swatch, tooltip, writeFilters } from './shared.js';

const ALL = '\u0000all';
const TOP = 10; // groups shown before "Show all"; longer lists start collapsed

// ---------------------------------------------------------------------------- state

const state = { round: null, q: null, split: 'region', minn: 30, more: false, hidden: {}, filters: {} };

function readUrl() {
  const p = new URLSearchParams(location.hash.slice(1));
  if (p.get('round')) state.round = p.get('round');
  if (p.get('q')) state.q = p.get('q');
  if (DIM[p.get('split')]) state.split = p.get('split');
  if (p.has('minn')) state.minn = Math.max(0, Math.min(200, +p.get('minn') || 0));
  state.more = p.get('more') === '1';
  readFilters(p, state.filters);
  for (const d of DIMS) if (p.get(`h.${d.key}`)) state.hidden[d.key] = p.get(`h.${d.key}`).split('|');
}

function writeUrl() {
  const p = new URLSearchParams({ round: state.round, q: state.q, split: state.split, minn: state.minn });
  if (state.more) p.set('more', 1);
  writeFilters(p, state.filters);
  for (const [k, v] of Object.entries(state.hidden)) if (v.length) p.set(`h.${k}`, v.join('|'));
  history.replaceState(null, '', `#${p}`);
}

// ------------------------------------------------------------------------- bootstrap

const $cross = Selection.crossfilter();
const panels = createPanels({
  selection: $cross,
  scope: () => `round = ${lit(state.round)}`,
  filters: state.filters,
  onChange: () => { panels.renderChips(); writeUrl(); },
});
let combo;
let questions = []; // polls of the current round
let options = []; // option labels of the current question, survey order
let mainData = null; // last result of the main query
let mainFilterSql = ''; // crossfilter predicate the main view was last queried with
let mainClient;

// Called at the end of the module, once every binding below exists.
async function start() {
  try {
    await initData(status);
    readUrl();
    const rounds = await sql('SELECT round FROM participants GROUP BY round, round_order ORDER BY round_order');
    if (!rounds.some((r) => r.round === state.round)) state.round = rounds.at(-1).round;
    $('#round').append(...rounds.map((r) => el('option', { value: r.round, textContent: r.round })));
    $('#split').append(...DIMS.map((d) => el('option', { value: d.key, textContent: d.label })));
    bindControls();
    await loadRound();
    panels.mount($('#panels'));
    mainClient = makeClient({
      selection: $cross,
      filterStable: false,
      query: mainQuery,
      queryResult: (table) => { mainData = rowsOf(table); renderMain(); status(null); },
      queryError: (e) => status(String(e), true),
    });
    $('.layout').hidden = false;
  } catch (e) {
    console.error(e);
    status(`Could not start: ${e.message ?? e}\nHas the data been built? Run \`make explorer-data\`.`, true);
  }
}

async function loadRound() {
  questions = await sql(`
    SELECT question_id, question_text, question_type, section, order_in_survey, indicator_code, is_onboarding, demographic
    FROM questions WHERE round = ${lit(state.round)} AND question_type LIKE 'Poll%' ORDER BY order_in_survey`);
  pickQuestion();
  await panels.load();
  await loadQuestion();
}

async function loadQuestion() {
  const rows = await sql(`SELECT option FROM poll_options WHERE round = ${lit(state.round)} AND question_id = ${lit(state.q)} ORDER BY option_order`);
  options = rows.map((r) => r.option);
  syncControls();
}

const question = () => questions.find((q) => q.question_id === state.q);

// The demographic polls are the split-by dimensions and filter panels already, so they stay
// out of the question menu.
const selectable = () => questions.filter((q) => !q.demographic);

function pickQuestion() {
  if (!selectable().some((q) => q.question_id === state.q)) {
    state.q = (selectable().find((q) => !q.is_onboarding) ?? selectable()[0]).question_id;
  }
}

// ------------------------------------------------------------------------- main view

function mainQuery(filter) {
  mainFilterSql = andFilter(filter);
  const d = state.split;
  // One pass: cells, per-segment respondents, per-option totals and the grand total.
  return `
    SELECT ${d} AS seg, option, count(*) AS n, count(DISTINCT participant_id) AS people,
           GROUPING(${d}) AS all_segs, GROUPING(option) AS all_opts
    FROM poll_answers_x
    WHERE round = ${lit(state.round)} AND question_id = ${lit(state.q)}${mainFilterSql}
    GROUP BY GROUPING SETS ((${d}, option), (${d}), (option), ())`;
}

/** Shape the query result into rows to draw: All first, then the groups switched on. */
function shape() {
  const d = DIM[state.split];
  const cell = new Map(); // seg -> option -> n
  const people = new Map(); // seg -> respondents
  for (const r of mainData) {
    const seg = r.all_segs ? ALL : r.seg;
    if (r.all_opts) people.set(seg, r.people);
    else (cell.get(seg) ?? cell.set(seg, new Map()).get(seg)).set(r.option, r.n);
  }
  const mk = (key, label, values) => ({ key, label, values, n: people.get(key) ?? 0, counts: cell.get(key) ?? new Map(), small: (people.get(key) ?? 0) < state.minn });
  const off = state.hidden[d.key] ?? [];
  const segs = d.levels.filter((v) => people.has(v)).map((v) => mk(v, v ?? '(none)', [v]));
  const on = segs.filter((s) => !off.includes(s.key));
  // Long lists start with the TOP largest groups; "Show all" reveals the rest in place.
  const collapsible = on.length > TOP + 2;
  const rows = collapsible && !state.more ? on.slice(0, TOP) : on;
  return { all: { ...mk(ALL, 'All', null), small: false }, rows, segs, more: collapsible ? on.length - TOP : 0, off: segs.filter((s) => off.includes(s.key)) };
}

function setHidden(key, hide) {
  const d = state.split;
  const cur = (state.hidden[d] ?? []).filter((k) => k !== key);
  if (hide) cur.push(key);
  if (cur.length) state.hidden[d] = cur; else delete state.hidden[d];
  writeUrl();
  renderMain();
}

/** Show-more link and the switched-off groups, under the chart (and group toggles above a multi-select). */
function renderGroups({ rows, segs, more, off }, multi) {
  const chip = (s, pressed) => el('button', { type: 'button', className: `toggle${pressed ? ' on' : ''}`, ariaPressed: String(pressed), textContent: `${s.label} · ${fmt(s.n)}`, title: pressed ? 'Hide this group' : 'Show this group', onclick: () => setHidden(s.key, pressed) });
  // A multi-select repeats every group in every block, so its toggles live once, above the blocks.
  $('#groups-top').replaceChildren(...(multi ? [el('span', { className: 'groups-label', textContent: `${DIM[state.split].label}:` }), ...rows.map((s) => chip(s, true))] : []));
  const bottom = [];
  if (more) {
    bottom.push(el('button', { type: 'button', className: 'ghost link', textContent: state.more ? `Show top ${TOP} only` : `Show all ${rows.length + more} · ${more} more`, onclick: () => { state.more = !state.more; writeUrl(); renderMain(); } }));
  }
  if (off.length) {
    bottom.push(el('span', { className: 'groups-label', textContent: 'Hidden:' }), ...off.map((s) => chip(s, false)),
      el('button', { type: 'button', className: 'ghost link', textContent: 'Show all hidden', onclick: () => { delete state.hidden[state.split]; writeUrl(); renderMain(); } }));
  }
  $('#groups').replaceChildren(...bottom);
}

function renderMain() {
  if (!mainData) return;
  const q = question();
  const multi = q.question_type === 'Poll Multi Select';
  const shaped = shape();
  const { all, rows } = shaped;
  const priority = [...options].sort((a, b) => (all.counts.get(b) ?? 0) - (all.counts.get(a) ?? 0));
  const pal = optionColors(options, { dark: isDark(), priority });

  // Display options: nominal lists longer than the palette merge their tail into one segment.
  const shown = options.filter((o) => !pal.folded.includes(o)).map((o) => ({ label: o, members: [o], fill: pal.fills.get(o) }));
  if (pal.folded.length) shown.push({ label: `Other options (${pal.folded.length})`, members: pal.folded, fill: pal.neutral });
  const count = (row, opt) => opt.members.reduce((s, o) => s + (row.counts.get(o) ?? 0), 0);

  const total = DIM[state.split].totals;
  $('#q-meta').textContent = [state.round, q.section, multi ? 'Multi-select poll' : 'Single-select poll', q.indicator_code ? `Indicator: ${q.indicator_code}` : null].filter(Boolean).join(' · ');
  $('#q-text').textContent = q.question_text;
  panels.renderChips();

  const chart = $('#chart');
  chart.replaceChildren();
  $('#legend').replaceChildren();
  renderGroups(shaped, multi);
  if (!all.n) {
    chart.append(el('p', { className: 'note', textContent: 'No respondents match the current filters.' }));
    $('#table').replaceChildren();
    $('#chart-note').textContent = '';
    return;
  }

  if (multi) {
    const opts = options.map((o) => ({ label: o, members: [o], fill: pal.single }));
    chart.append(el('div', { className: 'blocks' }, opts.map((opt) =>
      el('div', { className: 'block' },
        el('h3', { textContent: opt.label }),
        el('div', { className: 'rows' }, [all, ...rows].flatMap((row) => {
          const n = count(row, opt);
          const share = row.n ? n / row.n : 0;
          const cls = `${row.small ? 'small ' : ''}${row === all ? 'all ' : ''}`;
          const fill = el('button', { type: 'button', className: 'fill', ariaLabel: `${row.label}, ${opt.label}: ${pct(share)} of ${row.n}` });
          fill.style.cssText = `width:${100 * share}%;background:${opt.fill}`;
          hook(fill, row, opt, n);
          return [
            el('div', { className: `${cls}seg-label`, textContent: row.label, title: row.label }),
            el('div', { className: `${cls}track` }, fill),
            el('div', { className: `${cls}val`, textContent: pct(share) }),
          ];
        })),
      ))));
    $('#chart-note').textContent = `Bars show the share of each group's respondents who selected the option (shares add to more than 100 %). Respondents: ${[all, ...rows].map((r) => `${r.label} n=${fmt(r.n)}`).join(' · ')}.`;
  } else {
    $('#legend').append(...shown.map((o) => el('span', { className: 'key' }, swatch(o.fill), o.label)));
    const line = (row) => {
      const cls = `${row.small ? 'small ' : ''}${row === all ? 'all ' : ''}`;
      const bar = el('div', { className: 'bar' }, shown.map((opt) => {
        const n = count(row, opt);
        if (!n) return null;
        const share = n / row.n;
        const part = el('button', { type: 'button', className: `part${onLight(opt.fill) ? ' on-light' : ''}`, textContent: share >= 0.065 ? Math.round(100 * share) : '', ariaLabel: `${row.label}, ${opt.label}: ${pct(share)} of ${row.n}` });
        part.style.cssText = `flex:${n} 1 0;background:${opt.fill}`;
        hook(part, row, opt, n);
        return part;
      }));
      const of = row.values ? total.get(row.values[0]) : null;
      return [
        row === all
          ? el('div', { className: `${cls}seg-label`, textContent: row.label })
          : el('label', { className: `${cls}seg-label`, title: `${row.label}: untick to hide this group` },
            el('span', { textContent: row.label }),
            el('input', { type: 'checkbox', checked: true, ariaLabel: `Show ${row.label}`, onchange: () => setHidden(row.key, true) })),
        el('div', { className: cls.trim() }, bar),
        el('div', { className: `${cls}seg-n`, textContent: `n = ${fmt(row.n)}${row.small ? ' · below min' : ''}`, title: of ? `${fmt(row.n)} respondents of ${fmt(of)} participants in this group` : '' }),
      ];
    };
    chart.append(el('div', { className: 'rows' },
      line(all), el('div', { className: 'divider' }), rows.flatMap(line),
      el('div', { className: 'axis' }, ['0%', '25%', '50%', '75%', '100%'].map((t) => el('span', { textContent: t })))));
    const small = rows.filter((r) => r.small).length;
    $('#chart-note').textContent = `Percentages are of respondents to this question in each group (n at the row end), not of all participants.${small ? ` Greyed rows have fewer than ${state.minn} respondents.` : ''} Click a segment to read those participants' open-ended answers.`;
  }
  renderTable([all, ...rows], multi ? options.map((o) => ({ label: o, members: [o] })) : shown, count);
}

function renderTable(rows, opts, count) {
  $('#table').replaceChildren(el('table', {},
    el('thead', {}, el('tr', {}, el('th', { textContent: DIM[state.split].label }), el('th', { textContent: 'n' }), opts.map((o) => el('th', { textContent: o.label })))),
    el('tbody', {}, rows.map((r) => el('tr', { className: r.small ? 'small' : '' },
      el('td', { textContent: r.label }), el('td', { textContent: fmt(r.n) }),
      opts.map((o) => el('td', { textContent: r.n ? `${pct(count(r, o) / r.n, 1)} (${count(r, o)})` : '–' })))))));
}

/** Tooltip + click-through for one mark. */
function hook(node, row, opt, n) {
  tooltip(node, () => [
    el('div', { className: 't-head' }, swatch(opt.fill), el('span', { textContent: opt.label })),
    el('div', { className: 't-row' }, el('b', { textContent: pct(row.n ? n / row.n : 0, 1) }), ` · ${fmt(n)} of ${fmt(row.n)} respondents`),
    el('div', { className: 't-row', textContent: `${DIM[state.split].label}: ${row.label}${row.small ? ` · below minimum n (${state.minn})` : ''}` }),
  ]);
  node.addEventListener('click', () => openDrawer(row, opt));
}

// ------------------------------------------------------------------------- controls

function syncControls() {
  $('#round').value = state.round;
  $('#split').value = state.split;
  $('#minn').value = state.minn;
  $('#minn-out').textContent = state.minn;
  combo?.setLabel(question()?.question_text ?? '');
  writeUrl();
}

function bindControls() {
  $('#round').onchange = async (e) => {
    state.round = e.target.value;
    await panels.rescope();
    await loadRound();
    mainClient.requestQuery();
  };
  $('#split').onchange = async (e) => {
    state.split = e.target.value;
    state.more = false;
    pickQuestion();
    await loadQuestion();
    mainClient.requestQuery();
  };
  $('#minn').oninput = (e) => { state.minn = +e.target.value; syncControls(); renderMain(); };
  $('#clear').onclick = panels.clearAll;
  bindTheme(renderMain);
  $('#drawer-close').onclick = closeDrawer;
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeDrawer(); });
  combo = createCombo($('#question-combo'), {
    placeholder: 'Search question text or section…',
    current: () => state.q,
    items: () => selectable().map((q) => ({ id: q.question_id, label: q.question_text, group: q.section, tag: q.question_type === 'Poll Multi Select' ? 'multi-select' : '', search: q.indicator_code ?? '' })),
    onPick: async (id) => { state.q = id; await loadQuestion(); mainClient.requestQuery(); },
  });
}

// --------------------------------------------------------------------------- drawer

let drawerPeople = '';

async function openDrawer(row, opt) {
  const d = state.split;
  const segCond = row.values
    ? `AND (${[row.values.some((v) => v == null) ? `${d} IS NULL` : null, `${d} IN (${row.values.filter((v) => v != null).map(lit).join(', ') || 'NULL'})`].filter(Boolean).join(' OR ')})`
    : '';
  drawerPeople = `
    SELECT DISTINCT participant_id FROM poll_answers_x
    WHERE round = ${lit(state.round)} AND question_id = ${lit(state.q)}
      AND option IN (${opt.members.map(lit).join(', ')}) ${segCond}${mainFilterSql}`;
  const qs = await sql(`
    SELECT s.question_id, any_value(q.question_text) AS question_text, count(*) AS n
    FROM statements s JOIN questions q USING (round, question_id)
    WHERE s.round = ${lit(state.round)} AND s.participant_id IN (${drawerPeople})
    GROUP BY s.question_id ORDER BY any_value(q.order_in_survey)`);
  $('#drawer-title').textContent = `“${opt.label}”`;
  $('#drawer-sub').textContent = `${DIM[d].label}: ${row.label} · ${question().question_text}`;
  const select = $('#drawer-question');
  select.replaceChildren(...qs.map((q) => el('option', { value: q.question_id, textContent: `${q.question_text} (${q.n})` })));
  select.onchange = () => loadAnswers(select.value);
  $('#drawer').hidden = false;
  $('#tip').hidden = true;
  if (qs.length) await loadAnswers(qs[0].question_id);
  else $('#drawer-list').replaceChildren(el('p', { className: 'note', textContent: 'These participants wrote no open-ended answers.' }));
}

function closeDrawer() { $('#drawer').hidden = true; }

async function loadAnswers(questionId) {
  const LIMIT = 200;
  const rows = await sql(`
    SELECT text_en, text_orig, text_language, sentiment, thought_id, n_agree, n_disagree, n_neutral, country, age, gender
    FROM statements_x
    WHERE round = ${lit(state.round)} AND question_id = ${lit(questionId)} AND participant_id IN (${drawerPeople})
    ORDER BY n_agree + n_disagree DESC, length(text_en) DESC LIMIT ${LIMIT + 1}`);
  const list = $('#drawer-list');
  list.replaceChildren(...rows.slice(0, LIMIT).map((r) => {
    const hasOrig = r.text_orig && r.text_orig.trim() !== r.text_en.trim();
    const orig = hasOrig ? el('p', { className: 'orig', lang: '', hidden: true, textContent: r.text_orig, dir: 'auto' }) : null;
    const votes = r.n_agree + r.n_disagree + r.n_neutral;
    return el('article', { className: 'answer' },
      el('p', { textContent: r.text_en }), orig,
      el('div', { className: 'meta' },
        [r.country, r.age, r.gender, r.sentiment].filter(Boolean).map((t) => el('span', { textContent: t })),
        hasOrig ? el('button', { type: 'button', className: 'ghost', textContent: `Original (${r.text_language})`, onclick: () => { orig.hidden = !orig.hidden; } }) : null,
        r.thought_id ? el('span', { className: 'votes', textContent: votes ? `raw votes: ${r.n_agree} agree · ${r.n_disagree} disagree${r.n_neutral ? ` · ${r.n_neutral} neutral` : ''}` : 'no votes', title: 'Counts of votes actually cast (binary.csv), not Remesh estimates' }) : null));
  }));
  const p = new URLSearchParams({ round: state.round, q: questionId });
  writeFilters(p, state.filters);
  list.append(el('p', { className: 'note' }, rows.length > LIMIT ? `Showing the first ${LIMIT}. ` : '',
    el('a', { href: `answers.html#${p}`, textContent: 'Open this question on the Answers page →' }), ' (same demographic filters; search, tags, votes and participant drill-down).'));
  list.scrollTop = 0;
}

start();
