// Pieces every page uses: DOM helpers, the demographic dimensions, the cross-filter panels,
// filter chips, the tooltip, the searchable menu and the theme toggle.
import { makeClient } from '@uwdata/mosaic-core';
import { column, isIn, literal } from '@uwdata/mosaic-sql';
import { andFilter, sql } from './coordinator.js';
import { isDark } from './colors.js';

export const $ = (sel) => document.querySelector(sel);
export const el = (tag, props = {}, ...kids) => {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...kids.flat(2).filter((k) => k != null && k !== false));
  return node;
};
export const fmt = (n) => Number(n).toLocaleString('en-US');
export const pct = (x, digits = 0) => `${(100 * x).toFixed(digits)}%`;
export const swatch = (fill) => Object.assign(el('span', { className: 'swatch' }), { style: `background:${fill}` });

export const DIMS = [
  { key: 'region', label: 'Region' },
  { key: 'subregion', label: 'Sub-region', top: 8 },
  { key: 'country', label: 'Country', top: 10 },
  { key: 'age', label: 'Age', order: ['Less than 18', '18-25', '26-35', '36-45', '46-55', '56-65', '65+'] },
  { key: 'gender', label: 'Gender' },
  { key: 'environment', label: 'Where they live', order: ['Rural', 'Suburban', 'Urban'] },
  { key: 'ai_feeling', label: 'Feeling about AI', order: ['More excited than concerned', 'Equally concerned and excited', 'More concerned than excited'] },
  { key: 'religion', label: 'Religion' },
  { key: 'language', label: 'Survey language' },
];
export const DIM = Object.fromEntries(DIMS.map((d) => [d.key, d]));

/**
 * Context for a branched follow-up ("Branch A - Please explain…"): the poll that routed people
 * into it and the answers that lead there. Null for ordinary questions.
 */
export function branchContext(q) {
  if (!q?.parent_question_text) return null;
  return el('p', { className: 'q-context' },
    el('b', { textContent: 'Follow-up to: ' }), `“${q.parent_question_text}”`,
    q.branch_answers ? [el('br'), el('b', { textContent: 'Asked only of people who answered: ' }), q.branch_answers] : null);
}

export function rowsOf(table) {
  return table.toArray().map((r) => {
    const o = {};
    for (const [k, v] of Object.entries(r)) o[k] = typeof v === 'bigint' ? Number(v) : v;
    return o;
  });
}

export function status(msg, error = false) {
  $('#status').hidden = !msg;
  $('#status').textContent = msg ?? '';
  $('#status').classList.toggle('error', error);
}

/** True when a hex fill is light enough to need dark text on top. */
export function onLight(fill) {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(fill.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.32;
}

// --------------------------------------------------------------------------- tooltip

/** Show `content()` (nodes) in the floating tooltip while `node` is hovered or focused. */
export function tooltip(node, content) {
  const show = (e) => {
    const tip = $('#tip');
    tip.replaceChildren(...[content()].flat());
    tip.hidden = false;
    const { width, height } = tip.getBoundingClientRect();
    const r = node.getBoundingClientRect();
    const x = e.clientX ?? r.left + r.width / 2;
    const y = e.clientY ?? r.top;
    tip.style.left = `${Math.max(8, Math.min(innerWidth - width - 8, x + 14))}px`;
    tip.style.top = `${y - height - 12 < 8 ? y + 18 : y - height - 12}px`;
  };
  node.addEventListener('pointermove', show);
  node.addEventListener('focus', show);
  for (const ev of ['pointerleave', 'blur']) node.addEventListener(ev, () => { $('#tip').hidden = true; });
}

// ---------------------------------------------------------------------- filter panels

/**
 * The demographic cross-filter column. Each panel is a Mosaic client on `selection`
 * (a crossfilter), counts participants inside `scope()` and publishes an IN-clause that
 * filters every other client but not itself.
 *
 * @param {object} o
 * @param {import('@uwdata/mosaic-core').Selection} o.selection
 * @param {() => string} o.scope SQL condition on `participants` (e.g. the current round)
 * @param {Record<string, string[]>} o.filters live filter state, mutated in place
 * @param {() => void} o.onChange called after any filter change
 */
export function createPanels({ selection, scope, filters, onChange }) {
  const panels = new Map();

  function publish(panel) {
    const values = filters[panel.dim.key] ?? [];
    selection.update({
      source: panel,
      clients: new Set([panel.client]),
      value: values.length ? values : null,
      predicate: values.length ? isIn(column(panel.dim.key), values.map((v) => literal(v))) : null,
    });
  }

  function set(key, values) {
    if (values.length) filters[key] = values; else delete filters[key];
    const panel = panels.get(key);
    publish(panel);
    render(panel);
    onChange();
  }

  function render(panel) {
    const d = panel.dim;
    const selected = filters[d.key] ?? [];
    const max = Math.max(1, ...d.totals.values());
    let levels = d.levels;
    if (d.top && !panel.expanded && levels.length > d.top) levels = levels.filter((v, i) => i < d.top || selected.includes(v));
    panel.el.classList.toggle('has-selection', selected.length > 0);
    panel.el.replaceChildren(
      el('div', { className: 'panel-head' },
        el('h3', { textContent: d.label }),
        selected.length ? el('button', { type: 'button', className: 'ghost', textContent: 'clear', onclick: () => set(d.key, []) }) : null),
      ...levels.map((v) => {
        const now = panel.data.get(v) ?? 0;
        const row = el('button', { type: 'button', className: `prow${selected.includes(v) ? ' selected' : ''}`, ariaPressed: String(selected.includes(v)), title: `${v}: ${fmt(now)} of ${fmt(d.totals.get(v))} participants` },
          el('span', { className: 'name', textContent: v ?? '(none)' }),
          el('span', { className: 'pbar' },
            Object.assign(el('i', { className: 'total' }), { style: `width:${100 * d.totals.get(v) / max}%` }),
            Object.assign(el('i', { className: 'now' }), { style: `width:${100 * now / max}%` })),
          el('span', { className: 'num', textContent: fmt(now) }));
        row.onclick = () => set(d.key, selected.includes(v) ? selected.filter((x) => x !== v) : [...selected, v]);
        return row;
      }),
      d.top && d.levels.length > d.top
        ? el('button', { type: 'button', className: 'ghost more', textContent: panel.expanded ? 'Show fewer' : `Show all ${d.levels.length}`, onclick: () => { panel.expanded = !panel.expanded; render(panel); } })
        : '');
  }

  /** (Re)compute the unfiltered totals and the fixed level order for the current scope. */
  async function load() {
    for (const d of DIMS) {
      const rows = await sql(`SELECT ${d.key} AS v, count(*) AS n FROM participants WHERE ${scope()} GROUP BY 1`);
      d.totals = new Map(rows.map((r) => [r.v, r.n]));
      // Declared order for ordinal dimensions, else by size. Fixed under filtering, so a
      // level keeps its position.
      d.levels = d.order ? d.order.filter((v) => d.totals.has(v)) : rows.sort((a, b) => b.n - a.n).map((r) => r.v);
    }
  }

  function mount(container) {
    container.replaceChildren();
    for (const d of DIMS) {
      const panel = { dim: d, data: new Map(), expanded: false, el: el('section', { className: 'panel' }) };
      panel.client = makeClient({
        selection,
        filterStable: false,
        query: (filter) => `SELECT ${d.key} AS v, count(*) AS n FROM participants WHERE ${scope()}${andFilter(filter)} GROUP BY 1`,
        queryResult: (table) => { panel.data = new Map(rowsOf(table).map((r) => [r.v, r.n])); render(panel); },
      });
      panels.set(d.key, panel);
      container.append(panel.el);
      if (filters[d.key]?.length) publish(panel);
    }
  }

  /** After the scope changed: recount; filters are dropped unless `keepFilters`. */
  async function rescope({ keepFilters = false } = {}) {
    if (!keepFilters) for (const k of Object.keys(filters)) delete filters[k];
    await load();
    for (const p of panels.values()) { publish(p); p.client.requestQuery(); }
  }

  const clearAll = () => Object.keys(filters).forEach((k) => set(k, []));

  /** Chips for the active filters, plus the Clear-all button state. */
  function renderChips() {
    const entries = Object.entries(filters);
    $('#clear').hidden = !entries.length;
    $('#active-filters').replaceChildren(...entries.map(([k, vals]) =>
      el('span', { className: 'chip' }, el('b', { textContent: `${DIM[k].label}:` }), ` ${vals.join(', ')}`,
        el('button', { type: 'button', textContent: '✕', ariaLabel: `Remove ${DIM[k].label} filter`, onclick: () => set(k, []) }))));
  }

  return { load, mount, rescope, set, clearAll, renderChips };
}

/** Read / write the `f.<dim>=a|b` filter part of the URL hash. */
export function readFilters(params, filters) {
  for (const d of DIMS) if (params.get(`f.${d.key}`)) filters[d.key] = params.get(`f.${d.key}`).split('|');
}
export function writeFilters(params, filters) {
  for (const [k, v] of Object.entries(filters)) if (v.length) params.set(`f.${k}`, v.join('|'));
}

// ------------------------------------------------------------------- searchable menu

/**
 * Button + popover with a search box and a grouped list.
 * `items()` returns [{ id, label, group, tag?, search? }]; `current()` the selected id.
 */
export function createCombo(root, { items, current, onPick, placeholder = 'Search…' }) {
  const button = el('button', { type: 'button', className: 'combo-button', ariaHasPopup: 'listbox' });
  const search = el('input', { type: 'search', placeholder, autocomplete: 'off', ariaLabel: placeholder });
  const list = el('ul', { role: 'listbox' });
  const pop = el('div', { className: 'combo-pop', hidden: true }, search, list);
  root.classList.add('combo');
  root.replaceChildren(button, pop);
  let cursor = -1;

  function render() {
    const words = search.value.toLowerCase().split(/\s+/).filter(Boolean);
    const hits = items().filter((it) => words.every((w) => `${it.label} ${it.group ?? ''} ${it.search ?? ''}`.toLowerCase().includes(w)));
    const nodes = [];
    let group;
    for (const it of hits) {
      if (it.group !== group) nodes.push(el('li', { className: 'group', role: 'presentation', textContent: (group = it.group) || 'Other' }));
      nodes.push(el('li', { className: 'opt', role: 'option', ariaSelected: String(it.id === current()), onclick: () => { close(); onPick(it.id); } },
        el('span', { textContent: it.label }), el('span', { className: 'tag', textContent: it.tag ?? '' })));
    }
    list.replaceChildren(...(nodes.length ? nodes : [el('li', { className: 'group', textContent: 'Nothing matches' })]));
  }
  function open() {
    pop.hidden = false; search.value = ''; cursor = -1; render(); search.focus();
    list.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'center' });
  }
  function close() { pop.hidden = true; }

  button.onclick = () => (pop.hidden ? open() : close());
  search.oninput = () => { cursor = -1; render(); };
  search.onkeydown = (e) => {
    const opts = [...list.querySelectorAll('.opt')];
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      cursor = (cursor + (e.key === 'ArrowDown' ? 1 : -1) + opts.length) % opts.length;
      opts.forEach((li, i) => li.classList.toggle('cursor', i === cursor));
      opts[cursor]?.scrollIntoView({ block: 'nearest' });
    } else if (e.key === 'Enter') {
      opts[Math.max(cursor, 0)]?.click();
    }
  };
  document.addEventListener('pointerdown', (e) => { if (!root.contains(e.target)) close(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });

  return { setLabel: (text) => { button.textContent = text; }, close };
}

// ----------------------------------------------------------------------------- theme

/** Wire the theme button; `rerender` runs when colours computed in JS must be redone. */
export function bindTheme(rerender) {
  const saved = localStorage.getItem('gd-theme');
  if (saved) document.documentElement.dataset.theme = saved;
  $('#theme').onclick = () => {
    const next = isDark() ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    localStorage.setItem('gd-theme', next);
    rerender();
  };
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', rerender);
}
