// Answers page: read the open-ended answers in full, filtered by the same demographic
// cross-filter as the other pages, and drill down: answer -> author -> everything that
// person said and voted; answer -> the votes it received, by segment.
//
// Vote figures are raw counts from binary.csv. Remesh's imputed agreement rate is shown
// apart from them and labelled as an estimate.
import { Selection, makeClient } from '@uwdata/mosaic-core';
import { andFilter, initData, lit, sql } from './coordinator.js';
import { $, DIM, DIMS, bindTheme, createCombo, createPanels, el, fmt, pct, readFilters, rowsOf, status, writeFilters } from './shared.js';

const PAGE = 40;
const ANY = '';
const SORTS = {
  votes: { label: 'Most votes', sql: 'n_agree + n_disagree + n_neutral DESC, length(text_en) DESC' },
  agree: { label: 'Highest raw agreement (≥ 5 votes)', sql: '(n_agree + n_disagree >= 5) DESC, agree_rate_raw DESC NULLS LAST, n_agree DESC' },
  disagree: { label: 'Lowest raw agreement (≥ 5 votes)', sql: '(n_agree + n_disagree >= 5) DESC, agree_rate_raw ASC NULLS LAST, n_disagree DESC' },
  long: { label: 'Longest', sql: 'length(text_en) DESC' },
  short: { label: 'Shortest', sql: 'length(text_en) ASC' },
};

const state = { round: null, q: ANY, search: '', tag: ANY, sent: ANY, sort: 'votes', limit: PAGE, filters: {}, person: null, thought: null, vsplit: 'region' };

function readUrl() {
  const p = new URLSearchParams(location.hash.slice(1));
  for (const k of ['round', 'q', 'search', 'tag', 'sent', 'person', 'thought']) if (p.get(k)) state[k] = p.get(k);
  if (SORTS[p.get('sort')]) state.sort = p.get('sort');
  if (DIM[p.get('vsplit')]) state.vsplit = p.get('vsplit');
  readFilters(p, state.filters);
}

function writeUrl() {
  const p = new URLSearchParams({ round: state.round });
  for (const k of ['q', 'search', 'tag', 'sent', 'person', 'thought']) if (state[k]) p.set(k, state[k]);
  if (state.sort !== 'votes') p.set('sort', state.sort);
  if (state.thought && state.vsplit !== 'region') p.set('vsplit', state.vsplit);
  writeFilters(p, state.filters);
  history.replaceState(null, '', `#${p}`);
}

const $cross = Selection.crossfilter();
const ALL_ROUNDS = 'all';
const roundSql = (col = 'round') => (state.round === ALL_ROUNDS ? 'TRUE' : `${col} = ${lit(state.round)}`);
const panels = createPanels({
  selection: $cross,
  scope: () => roundSql(),
  filters: state.filters,
  onChange: () => { panels.renderChips(); writeUrl(); },
});
let questions = [];
let listClient;
let countClient;
let combo;
let rows = [];
let total = 0;

async function start() {
  try {
    await initData(status);
    readUrl();
    const rounds = await sql('SELECT round FROM participants GROUP BY round, round_order ORDER BY round_order');
    if (state.round !== ALL_ROUNDS && !rounds.some((r) => r.round === state.round)) state.round = rounds.at(-1).round;
    $('#round').append(...rounds.map((r) => el('option', { value: r.round, textContent: r.round })), el('option', { value: ALL_ROUNDS, textContent: 'All rounds' }));
    $('#sort').append(...Object.entries(SORTS).map(([k, s]) => el('option', { value: k, textContent: s.label })));
    bindControls();
    await loadRound();
    await panels.load();
    panels.mount($('#panels'));
    listClient = makeClient({
      selection: $cross, filterStable: false, query: listQuery,
      queryResult: (t) => { rows = rowsOf(t); renderList(); status(null); },
      queryError: (e) => status(String(e), true),
    });
    countClient = makeClient({
      selection: $cross, filterStable: false,
      query: (filter) => `SELECT count(*) AS n, count(DISTINCT participant_id) AS people FROM statements_x s WHERE ${where()}${andFilter(filter)}`,
      queryResult: (t) => { [{ n: total, people: state.people }] = rowsOf(t); renderHead(); },
    });
    $('.layout').hidden = false;
    if (state.person) openPerson(...state.person.split('/'));
    else if (state.thought) openVotes(...state.thought.split('/'));
  } catch (e) {
    console.error(e);
    status(`Could not start: ${e.message ?? e}\nHas the data been built? Run \`make explorer-data\`.`, true);
  }
}

async function loadRound() {
  questions = await sql(`
    SELECT q.round, q.round_order, q.question_id, q.question_text, q.question_type, q.section, q.order_in_survey, count(*) AS n
    FROM questions q JOIN statements s USING (round, question_id)
    WHERE ${roundSql('q.round')} GROUP BY ALL ORDER BY q.round_order DESC, q.order_in_survey`);
  if (state.q && !questions.some((q) => q.question_id === state.q)) state.q = ANY;
  await loadQuestion();
}

async function loadQuestion() {
  const scope = `${roundSql()}${state.q ? ` AND question_id = ${lit(state.q)}` : ''}`;
  // Tag codebooks are per question, so the menu only makes sense once a question is chosen.
  const tags = state.q
    ? await sql(`SELECT tag, count(*) AS n FROM (SELECT unnest([tag_1, tag_2, tag_3]) AS tag FROM statements WHERE ${scope}) WHERE tag IS NOT NULL GROUP BY 1 ORDER BY n DESC`)
    : [];
  if (!tags.some((t) => t.tag === state.tag)) state.tag = ANY;
  $('#tag').replaceChildren(el('option', { value: ANY, textContent: state.q ? 'Any tag' : 'Pick a question first' }), ...tags.map((t) => el('option', { value: t.tag, textContent: `${t.tag} (${fmt(t.n)})` })));
  $('#tag').disabled = !state.q;
  const sents = await sql(`SELECT sentiment, count(*) AS n FROM statements WHERE ${scope} AND sentiment IS NOT NULL GROUP BY 1 ORDER BY n DESC`);
  if (!sents.some((s) => s.sentiment === state.sent)) state.sent = ANY;
  $('#sentiment').replaceChildren(el('option', { value: ANY, textContent: 'Any' }), ...sents.map((s) => el('option', { value: s.sentiment, textContent: `${s.sentiment} (${fmt(s.n)})` })));
  syncControls();
}

const question = () => questions.find((q) => q.question_id === state.q);
const likeEscape = (s) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

function where() {
  const parts = [roundSql('s.round')];
  if (state.q) parts.push(`s.question_id = ${lit(state.q)}`);
  if (state.search.trim()) {
    const pat = lit(`%${likeEscape(state.search.trim())}%`);
    parts.push(`(s.text_en ILIKE ${pat} ESCAPE '\\' OR s.text_orig ILIKE ${pat} ESCAPE '\\')`);
  }
  if (state.tag) parts.push(`${lit(state.tag)} IN (s.tag_1, s.tag_2, s.tag_3)`);
  if (state.sent) parts.push(`s.sentiment = ${lit(state.sent)}`);
  return parts.join(' AND ');
}

function listQuery(filter) {
  return `
    SELECT s.round, s.question_id, s.thought_id, s.participant_id, s.text_en, s.text_orig, s.text_language, s.sentiment,
           s.tag_1, s.tag_2, s.tag_3, s.n_agree, s.n_disagree, s.n_neutral, s.agree_rate_raw, s.agree_rate_imputed_all,
           s.country, s.age, s.gender, s.religion
    FROM statements_x s WHERE ${where()}${andFilter(filter)}
    ORDER BY ${SORTS[state.sort].sql}, s.round_order DESC, s.participant_id LIMIT ${state.limit}`;
}

// ------------------------------------------------------------------------------ list

function renderHead() {
  const q = question();
  $('#q-meta').textContent = q
    ? [q.round, q.section, q.question_type === 'Ask Opinion' ? 'Ask Opinion · peers voted on these answers' : 'Ask Experience · no peer voting'].filter(Boolean).join(' · ')
    : `${state.round === ALL_ROUNDS ? 'All rounds' : state.round} · all open-ended questions`;
  $('#q-text').textContent = q ? q.question_text : 'All open-ended answers';
  panels.renderChips();
  $('#chart-note').textContent = `${fmt(total)} answers from ${fmt(state.people ?? 0)} participants match. Vote bars count the votes actually cast (about five voters per statement on average); “Remesh estimate” is Remesh’s model-imputed agreement for the whole sample, not a count.`;
  $('#groups').replaceChildren(...(rows.length < total
    ? [el('button', { type: 'button', className: 'ghost link', textContent: `Show ${Math.min(PAGE, total - rows.length)} more · ${fmt(rows.length)} of ${fmt(total)} shown`, onclick: () => { state.limit += PAGE; listClient.requestQuery(); } })]
    : []));
}

/** Text with the search phrase marked. */
function highlighted(text) {
  const needle = state.search.trim().toLowerCase();
  if (!needle) return [text];
  const out = [];
  let i = 0;
  const lower = text.toLowerCase();
  for (let j = lower.indexOf(needle); j >= 0; j = lower.indexOf(needle, i)) {
    out.push(text.slice(i, j), el('mark', { textContent: text.slice(j, j + needle.length) }));
    i = j + needle.length;
  }
  out.push(text.slice(i));
  return out;
}

function voteBar(r) {
  const n = r.n_agree + r.n_disagree + r.n_neutral;
  if (!n) return el('span', { textContent: 'no votes cast' });
  const seg = (cls, k) => (k ? Object.assign(el('i', { className: cls }), { style: `flex:${k} 1 0` }) : null);
  return el('span', { title: 'Raw counts of votes cast on this statement' },
    el('span', { className: 'votebar' }, seg('v-agree', r.n_agree), seg('v-disagree', r.n_disagree), seg('v-neutral', r.n_neutral)),
    ` ${r.n_agree} agree · ${r.n_disagree} disagree${r.n_neutral ? ` · ${r.n_neutral} neutral` : ''}`);
}

function answerCard(r, { context = !state.q, actions = true } = {}) {
  const hasOrig = r.text_orig && r.text_orig.trim() !== r.text_en.trim();
  const orig = hasOrig ? el('p', { className: 'orig', hidden: true, dir: 'auto' }, highlighted(r.text_orig)) : null;
  const q = context ? questions.find((x) => x.question_id === r.question_id && x.round === r.round) : null;
  return el('article', { className: 'answer' },
    context ? el('div', { className: 'ctx', textContent: `${r.round} · ${q?.question_text ?? r.question_text ?? ''}` }) : null,
    el('p', {}, highlighted(r.text_en)), orig,
    el('div', { className: 'meta' },
      [r.country, r.age, r.gender, r.religion, r.sentiment].filter(Boolean).map((t) => el('span', { textContent: t })),
      hasOrig ? el('button', { type: 'button', className: 'ghost', textContent: `Original (${r.text_language})`, onclick: () => { orig.hidden = !orig.hidden; } }) : null),
    r.tag_1 ? el('div', { className: 'tags' }, [r.tag_1, r.tag_2, r.tag_3].filter(Boolean).map((t) =>
      el('button', { type: 'button', textContent: t, title: 'Filter by this tag', onclick: () => pickTag(r, t) }))) : null,
    el('div', { className: 'foot' },
      r.thought_id ? voteBar(r) : el('span', { textContent: 'Ask Experience · not voted on' }),
      r.agree_rate_imputed_all != null ? el('span', { className: 'estimate', title: 'Imputed by Remesh from the sampled votes; an estimate with unknown error, not a count', textContent: `Remesh estimate ${pct(r.agree_rate_imputed_all)}` }) : null,
      el('span', { className: 'spacer' }),
      actions && r.thought_id && r.n_agree + r.n_disagree + r.n_neutral ? el('button', { type: 'button', className: 'ghost', textContent: 'Votes by group', onclick: () => openVotes(r.round, r.thought_id) }) : null,
      actions ? el('button', { type: 'button', className: 'ghost', textContent: 'Participant', onclick: () => openPerson(r.round, r.participant_id) }) : null));
}

async function pickTag(r, tag) {
  if (state.q !== r.question_id || state.round !== r.round) {
    if (state.round !== ALL_ROUNDS) state.round = r.round;
    state.q = r.question_id;
  }
  state.tag = tag;
  await loadQuestion();
  state.tag = tag;
  syncControls();
  requery();
}

function renderList() {
  $('#list').replaceChildren(...(rows.length ? rows.map((r) => answerCard(r)) : [el('p', { className: 'note', textContent: 'No answers match.' })]));
  renderHead();
}

// --------------------------------------------------------------------------- drawers

function openDrawer(title, sub, body) {
  $('#drawer-title').textContent = title;
  $('#drawer-sub').textContent = sub;
  $('#drawer-body').replaceChildren(...body);
  $('#drawer-body').scrollTop = 0;
  $('#drawer').hidden = false;
}

function closeDrawer() {
  $('#drawer').hidden = true;
  state.person = state.thought = null;
  writeUrl();
}

/** Everything one participant said and voted in their round. */
async function openPerson(round, pid) {
  state.person = `${round}/${pid}`; state.thought = null; writeUrl();
  const me = `round = ${lit(round)} AND participant_id = ${lit(pid)}`;
  const [who] = await sql(`SELECT ${DIMS.map((d) => d.key).join(', ')}, pri_score FROM participants WHERE ${me}`);
  if (!who) return;
  const texts = await sql(`
    SELECT s.*, q.question_text FROM statements_x s JOIN questions q USING (round, question_id)
    WHERE s.${me.replaceAll(' AND ', ' AND s.')} ORDER BY q.order_in_survey`);
  const polls = await sql(`
    SELECT q.question_text, string_agg(a.option, ' · ' ORDER BY a.option_order) AS answer
    FROM poll_answers a JOIN questions q USING (round, question_id)
    WHERE a.${me.replaceAll(' AND ', ' AND a.')} AND q.demographic IS NULL
    GROUP BY q.question_id, q.question_text, q.order_in_survey ORDER BY q.order_in_survey`);
  const votes = await sql(`
    SELECT v.vote, s.text_en, s.thought_id, q.question_text FROM votes v
    JOIN statements s ON s.round = v.round AND s.thought_id = v.thought_id
    JOIN questions q ON q.round = v.round AND q.question_id = v.question_id
    WHERE v.round = ${lit(round)} AND v.voter_id = ${lit(pid)} ORDER BY q.order_in_survey, v.ts`);
  const tally = Object.entries(Object.groupBy(votes, (v) => v.vote)).map(([k, v]) => `${v.length} ${k.toLowerCase()}`).join(' · ');
  openDrawer(`Participant in ${round}`, 'Pseudonymous. Everything this person answered in this round, and how they voted on other people’s statements.', [
    el('div', { className: 'chips' }, DIMS.filter((d) => who[d.key] && d.key !== 'subregion').map((d) => el('span', { className: 'chip', style: 'padding-right:10px' }, el('b', { textContent: `${d.label}:` }), ` ${who[d.key]}`)),
      who.pri_score != null ? el('span', { className: 'chip', style: 'padding-right:10px', title: 'Participant Reliability Index from the existing pipeline (0–1, higher = more reliable)' }, el('b', { textContent: 'PRI:' }), ` ${who.pri_score.toFixed(2)}`) : null),
    el('h3', { textContent: `Open-ended answers (${texts.length})` }),
    ...texts.map((t) => answerCard(t, { context: true, actions: false })),
    el('h3', { textContent: `Poll answers (${polls.length})` }),
    el('div', { className: 'kv' }, polls.flatMap((p) => [el('div', { textContent: p.question_text }), el('div', { textContent: p.answer })])),
    el('h3', { textContent: `Votes on other people’s statements (${votes.length}${tally ? `: ${tally}` : ''})` }),
    ...votes.map((v) => el('article', { className: 'answer' },
      el('div', { className: 'ctx', textContent: v.question_text }),
      el('p', {}, el('span', { className: `badge ${v.vote}`, textContent: v.vote }), v.text_en))),
  ]);
}

/** Who voted on one statement, by segment, as raw counts. */
async function openVotes(round, thoughtId) {
  state.thought = `${round}/${thoughtId}`; state.person = null; writeUrl();
  const [s] = await sql(`SELECT s.*, q.question_text FROM statements_x s JOIN questions q USING (round, question_id) WHERE s.round = ${lit(round)} AND s.thought_id = ${lit(thoughtId)}`);
  if (!s) return;
  const d = DIM[state.vsplit];
  const data = await sql(`SELECT ${d.key} AS seg, vote, count(*) AS n FROM votes_x WHERE round = ${lit(round)} AND thought_id = ${lit(thoughtId)} GROUP BY ALL`);
  const bySeg = Map.groupBy(data, (r) => r.seg);
  const segs = [...bySeg.keys()].sort((a, b) => bySeg.get(b).reduce((t, r) => t + r.n, 0) - bySeg.get(a).reduce((t, r) => t + r.n, 0));
  const select = el('select', { onchange: (e) => { state.vsplit = e.target.value; openVotes(round, thoughtId); } }, DIMS.map((x) => el('option', { value: x.key, textContent: x.label, selected: x.key === state.vsplit })));
  const line = (label, rs) => {
    const k = (v) => rs.find((r) => r.vote === v)?.n ?? 0;
    const n = k('Agree') + k('Disagree') + k('Neutral');
    const few = n < 5;
    const seg = (cls, c) => (c ? Object.assign(el('div', { className: `part ${cls}`, textContent: c }), { style: `flex:${c} 1 0` }) : null);
    return [
      el('div', { className: `${few ? 'small ' : ''}seg-label`, textContent: label ?? '(none)', title: label }),
      el('div', { className: few ? 'small' : '' }, el('div', { className: 'bar' }, seg('v-agree', k('Agree')), seg('v-disagree', k('Disagree')), seg('v-neutral', k('Neutral')))),
      el('div', { className: `${few ? 'small ' : ''}seg-n` }, `n = ${n}`, few ? el('span', { className: 'warn', textContent: ' · n < 5' }) : null)];
  };
  openDrawer('Votes on this statement', `${round} · ${s.question_text}`, [
    answerCard(s, { context: false, actions: false }),
    el('label', { className: 'field' }, el('span', { textContent: 'Voters split by' }), select),
    el('div', { className: 'legend' },
      el('span', { className: 'key' }, el('i', { className: 'swatch v-agree' }), 'Agree'),
      el('span', { className: 'key' }, el('i', { className: 'swatch v-disagree' }), 'Disagree'),
      el('span', { className: 'key' }, el('i', { className: 'swatch v-neutral' }), 'Neutral')),
    el('div', { className: 'rows' }, line('All voters', data.reduce((acc, r) => { const hit = acc.find((a) => a.vote === r.vote); if (hit) hit.n += r.n; else acc.push({ vote: r.vote, n: r.n }); return acc; }, [])), el('div', { className: 'divider' }), segs.flatMap((g) => line(g, bySeg.get(g)))),
    el('p', { className: 'note', textContent: 'Numbers inside the bars are vote counts. Each voter saw about five randomly chosen statements per question, so groups with fewer than five voters (greyed) say very little.' }),
  ]);
}

// -------------------------------------------------------------------------- controls

function syncControls() {
  $('#round').value = state.round;
  $('#search').value = state.search;
  $('#tag').value = state.tag;
  $('#sentiment').value = state.sent;
  $('#sort').value = state.sort;
  combo?.setLabel(question()?.question_text ?? 'All open-ended questions');
  writeUrl();
}

function requery() {
  state.limit = PAGE;
  writeUrl();
  listClient.requestQuery();
  countClient.requestQuery();
}

function bindControls() {
  $('#round').onchange = async (e) => {
    state.round = e.target.value;
    state.q = ANY;
    await loadRound();
    await panels.rescope({ keepFilters: true });
    requery();
  };
  let timer;
  $('#search').oninput = (e) => { clearTimeout(timer); timer = setTimeout(() => { state.search = e.target.value; requery(); }, 250); };
  $('#tag').onchange = (e) => { state.tag = e.target.value; requery(); };
  $('#sentiment').onchange = (e) => { state.sent = e.target.value; requery(); };
  $('#sort').onchange = (e) => { state.sort = e.target.value; requery(); };
  $('#clear').onclick = panels.clearAll;
  $('#drawer-close').onclick = closeDrawer;
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('#drawer').hidden) closeDrawer(); });
  bindTheme(() => {});
  combo = createCombo($('#question-combo'), {
    placeholder: 'Search open-ended questions…',
    current: () => state.q,
    items: () => [{ id: ANY, label: 'All open-ended questions', group: 'Everything' },
      ...questions.map((q) => ({ id: q.question_id, label: q.question_text, group: state.round === ALL_ROUNDS ? q.round : q.section, tag: `${q.question_type === 'Ask Opinion' ? 'voted · ' : ''}${fmt(q.n)}` }))],
    onPick: async (id) => { state.q = id; state.tag = ANY; await loadQuestion(); requery(); },
  });
}

// The crossfilter reruns the list on every panel click; keep paging sane when that happens.
$cross.addEventListener('value', () => { state.limit = PAGE; });

start();
