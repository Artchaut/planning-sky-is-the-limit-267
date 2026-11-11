'use strict';

/* ============================================================
   Storage keys, defaults
   ============================================================ */
const LS_DATA = 'calendar-data-v1';
const LS_UI = 'calendar-ui-v1';
const LS_DIRTY = 'calendar-dirty-v1';

// Every category has a kind. A "cours" automatically gets a "devoir" and a "travail" child.
const KINDS = [['cours', 'Cours'], ['devoir', 'Devoir'], ['travail', 'Travail'], ['perso', 'Perso']];

function courseSet(id, name, color) {
  return [
    { id, name, color, kind: 'cours' },
    { id: id + '-d', name: name + ' – Devoir', color, kind: 'devoir', parent: id },
    { id: id + '-t', name: name + ' – Travail', color, kind: 'travail', parent: id }
  ];
}

const DEFAULT_DATA = () => ({
  version: 1,
  settings: { rangeStart: '2026-09-01', rangeEnd: '2027-06-30' },
  types: [
    ...courseSet('coursm', 'Maths', '#2563eb'),
    ...courseSet('coursp', 'Physique', '#2563eb'),
    ...courseSet('coursi', 'Info', '#2563eb'),
    ...courseSet('coursf', 'Français', '#2563eb'),
    ...courseSet('coursa', 'Anglais', '#2563eb'),
    ...courseSet('courss', 'Sport', '#2563eb'),
    ...courseSet('courst', 'TIPE', '#2563eb'),
    { id: 'ds', name: 'DS', color: '#dc2626', kind: 'devoir' },
    { id: 'kholle', name: 'Khôlles', color: '#059669', kind: 'devoir' },
    { id: 'perso', name: 'Trucs Perso', color: '#7c3aed', kind: 'perso' }
  ],

  events: []
});

const HOUR_START = 7, HOUR_END = 22, PX = 48;

/* ============================================================
   Date helpers (all dates are local "YYYY-MM-DD" strings)
   ============================================================ */
const pad = n => String(n).padStart(2, '0');
const iso = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const parse = s => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
const addDays = (s, n) => { const d = parse(s); d.setDate(d.getDate() + n); return iso(d); };
const wd = s => (parse(s).getDay() + 6) % 7; // Monday = 0
const mondayOf = s => addDays(s, -wd(s));
const diffDays = (a, b) => Math.round((parse(b) - parse(a)) / 864e5);
const todayISO = () => iso(new Date());
const toMin = t => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };
const fromMin = m => `${pad(Math.floor(m / 60) % 24)}:${pad(m % 60)}`;

const LOCALE = 'fr-FR';
const WD = ['Lun', 'Mar', 'Mer', 'Jeu', 'Ven', 'Sam', 'Dim'];
const fmtMonth = new Intl.DateTimeFormat(LOCALE, { month: 'long', year: 'numeric' });
const fmtShort = new Intl.DateTimeFormat(LOCALE, { day: 'numeric', month: 'short' });
const fmtDay = new Intl.DateTimeFormat(LOCALE, { weekday: 'short', day: 'numeric', month: 'short' });
const fmtLong = new Intl.DateTimeFormat(LOCALE, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

function h(tag, props = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style') el.style.cssText = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, v);
  }
  for (const c of kids.flat()) {
    if (c == null || c === false) continue;
    el.append(c.nodeType ? c : document.createTextNode(c));
  }
  return el;
}

/* ============================================================
   State + persistence
   ============================================================ */
const state = {
  data: null,
  view: 'month',
  cursor: todayISO(),
  hidden: new Set(),
  sort: 'date' // 'date' | 'matiere' (applies to the list view and the open-tasks list)
};

function newId() {
  return (crypto.randomUUID ? crypto.randomUUID() : 'e' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8));
}

function normalize(raw) {
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.events)) throw new Error('This file has no "events" list.');
  const base = DEFAULT_DATA();
  const rawTypes = Array.isArray(raw.types) && raw.types.length ? raw.types : base.types;
  const validKind = k => KINDS.some(x => x[0] === k);
  const migrating = rawTypes.some(t => !validKind(t.kind));
  const oldTodo = new Set(); // old format: "checklist" was a property of the category
  let types = rawTypes.map(t => {
    const { todo, ...rest } = t;
    if (todo) oldTodo.add(t.id);
    const guess = String(t.id).startsWith('cours') ? 'cours'
      : (todo || ['devoir', 'ds', 'kholle'].includes(t.id)) ? 'devoir' : 'perso';
    return { ...rest, kind: validKind(t.kind) ? t.kind : guess };
  });
  if (migrating) { // old data: give every course its devoir/travail categories
    for (const c of types.filter(t => t.kind === 'cours')) {
      const have = new Set(types.filter(t => t.parent === c.id).map(t => t.kind));
      for (const [kind, label] of [['devoir', 'Devoir'], ['travail', 'Travail']]) {
        if (!have.has(kind)) types.push({ id: `${c.id}-${kind[0]}`, name: `${c.name} – ${label}`, color: c.color, kind, parent: c.id });
      }
    }
  }
  const data = {
    version: 1,
    settings: { ...base.settings, ...(raw.settings || {}) },
    types,
    events: []
  };
  for (const e of raw.events) {
    if (!e || typeof e.title !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(e.date || '')) continue;
    const type = e.type || data.types[0].id;
    data.events.push({ ...e, id: e.id || newId(), type, todo: e.todo != null ? !!e.todo : oldTodo.has(type) });
  }

  return data;
}

function persist() {
  try {
    localStorage.setItem(LS_DATA, JSON.stringify(state.data));
    localStorage.setItem(LS_DIRTY, '1');
  } catch (err) { toast('Could not save in this browser: ' + err.message); }
  updateStatus();
}

function saveUI() {
  try { localStorage.setItem(LS_UI, JSON.stringify({ view: state.view, hidden: [...state.hidden], sort: state.sort })); } catch {}
}

function updateStatus() {
  const dirty = localStorage.getItem(LS_DIRTY) === '1';
  const el = $('#status');
  el.textContent = dirty
    ? 'Tout ce que tu fais ne sera pas sauvegardé à moins de me demander gentiment 🚨'
    : 'Pas de changement jcrois';
  el.classList.toggle('dirty', dirty);
}

async function fetchDataFile() {
  const res = await fetch('data.json', { cache: 'no-store' });
  if (!res.ok) throw new Error('data.json pas trouvé (HTTP ' + res.status + ')');
  return normalize(await res.json());
}

async function load() {
  try {
    const ui = JSON.parse(localStorage.getItem(LS_UI) || '{}');
    if (['month', 'week', 'agenda'].includes(ui.view)) state.view = ui.view;
    if (Array.isArray(ui.hidden)) state.hidden = new Set(ui.hidden);
    if (['date', 'matiere'].includes(ui.sort)) state.sort = ui.sort;
  } catch {}
  try {
    const stored = localStorage.getItem(LS_DATA);
    if (stored) { state.data = normalize(JSON.parse(stored)); return; }
  } catch {}
  try {
    state.data = await fetchDataFile();
    localStorage.setItem(LS_DATA, JSON.stringify(state.data));
    localStorage.removeItem(LS_DIRTY);
  } catch {
    state.data = DEFAULT_DATA();
  }
}

/* ============================================================
   Event expansion (recurrence + per-occurrence exceptions)
   ============================================================ */
const typeOf = id => state.data.types.find(t => t.id === id) || { id, name: id, color: '#64748b', kind: 'perso' };
const colorOf = o => o.color || typeOf(o.type).color;
const isTodo = o => !!(o && o.todo);                 // "à faire" is now a per-event flag
const isCours = id => typeOf(id).kind === 'cours';
// Lists (month grid, agenda, sidebar) never show courses: they only live in the week view.
const listOccurrences = (from, to) => occurrences(from, to).filter(o => !isCours(o.type));

// A "subject" is the parent course of a devoir/travail category, or the category itself (DS, perso...).
function subjectOf(typeId) {
  const t = typeOf(typeId);
  const s = t.parent ? typeOf(t.parent) : t;
  return { key: s.id, name: s.name, color: s.color };
}
// Groups a (date-sorted) list by subject, subjects in the order of the category manager.
function groupBySubject(list) {
  const m = new Map();
  for (const o of list) {
    const s = subjectOf(o.type);
    if (!m.has(s.key)) m.set(s.key, { ...s, items: [] });
    m.get(s.key).items.push(o);
  }
  const idx = key => { const i = state.data.types.findIndex(t => t.id === key); return i < 0 ? 1e9 : i; };
  return [...m.values()].sort((a, b) => idx(a.key) - idx(b.key));
}

function makeOcc(ev, date, over) {
  const o = { ...ev, ...(over || {}), evId: ev.id, date, origDate: date, recurring: !!ev.recur };
  delete o.exceptions; delete o.recur; delete o.deleted;
  if (o.endDate && o.endDate > o.date && !ev.recur) o.allDay = true;
  return o;
}

function occurrences(from, to, includeHidden = false) {
  const out = [];
  for (const ev of state.data.events) {
    if (!includeHidden && state.hidden.has(ev.type)) continue;
    if (!ev.recur) {
      const end = ev.endDate && ev.endDate > ev.date ? ev.endDate : ev.date;
      if (end < from || ev.date > to) continue;
      for (let d = ev.date < from ? from : ev.date; d <= end && d <= to; d = addDays(d, 1)) {
        const o = makeOcc(ev, d);
        o.origDate = ev.date; // editing always refers to the real event date
        o.multi = end !== ev.date;
        out.push(o);
      }
    } else {
      const r = ev.recur;
      const last = r.until && r.until < to ? r.until : to;
      const interval = r.interval || 1;
      const base = mondayOf(ev.date);
      for (let d = ev.date < from ? from : ev.date; d <= last; d = addDays(d, 1)) {
        if (!r.days.includes(wd(d))) continue;
        if (Math.round(diffDays(base, mondayOf(d)) / 7) % interval) continue;
        const ex = ev.exceptions && ev.exceptions[d];
        if (ex && ex.deleted) continue;
        out.push(makeOcc(ev, d, ex));
      }
    }
  }
  out.sort((a, b) =>
    a.date.localeCompare(b.date) ||
    (b.allDay ? 1 : 0) - (a.allDay ? 1 : 0) ||
    (a.start || '').localeCompare(b.start || '') ||
    a.title.localeCompare(b.title));
  return out;
}

const groupByDate = list => list.reduce((m, o) => ((m[o.date] ||= []).push(o), m), {});

function toggleDone(o) {
  const ev = state.data.events.find(e => e.id === o.evId);
  if (!ev) return;
  if (ev.recur) {
    ev.exceptions ||= {};
    ev.exceptions[o.date] = { ...(ev.exceptions[o.date] || {}), done: !o.done };
  } else ev.done = !ev.done;
  persist(); render();
}

/* ============================================================
   Rendering
   ============================================================ */
function timeLabel(o) {
  if (o.allDay || !o.start) return '';
  return o.end ? `${o.start}–${o.end}` : o.start;
}

function chip(o) {
  const t = typeOf(o.type);
  return h('button', {
    class: 'chip' + (o.done ? ' done' : ''),
    style: `--c:${t.color}`,
    title: `${o.title}${timeLabel(o) ? '\n' + timeLabel(o) : ''}${o.location ? '\n' + o.location : ''}`,
    onclick: e => { e.stopPropagation(); openEditor(o); }
  },
    isTodo(o) ? (o.done ? '☑ ' : '☐ ') : null,
    (!o.allDay && o.start) ? h('span', { class: 't' }, o.start) : null,
    o.title);
}

function render() {
  const c = state.cursor;
  let label;
  if (state.view === 'month') label = fmtMonth.format(parse(c));
  else if (state.view === 'week') {
    const m = mondayOf(c);
    label = `${fmtShort.format(parse(m))} – ${fmtShort.format(parse(addDays(m, 6)))} ${parse(addDays(m, 6)).getFullYear()}`;
  } else label = `A partir du ${fmtShort.format(parse(c))}`;
  $('#label').textContent = label;
  $('#sort').textContent = state.sort === 'date' ? 'Tri : date' : 'Tri : matière';
  $$('[data-view]').forEach(b => b.classList.toggle('active', b.dataset.view === state.view));

  const prevScroll = $('.week-body') ? $('.week-body').scrollTop : null;
  const view = $('#view');
  view.replaceChildren(state.view === 'month' ? renderMonth() : state.view === 'week' ? renderWeek() : renderAgenda());
  const wb = $('.week-body');
  if (wb) wb.scrollTop = prevScroll != null ? prevScroll : PX;

  renderSidebar();
  updateStatus();
}

function renderMonth() {
  const cur = parse(state.cursor);
  const first = iso(new Date(cur.getFullYear(), cur.getMonth(), 1));
  const start = mondayOf(first);
  const end = addDays(start, 41);
  const by = groupByDate(listOccurrences(start, end));
  const today = todayISO();

  const grid = h('div', { class: 'grid7 month-grid' });
  for (let i = 0; i < 42; i++) {
    const d = addDays(start, i);
    const list = by[d] || [];
    const MAX = 3;
    grid.append(h('div', {
      class: 'cell' + (parse(d).getMonth() !== cur.getMonth() ? ' other' : '') + (d === today ? ' today' : ''),
      onclick: () => openNew(d)
    },
      h('span', { class: 'num' }, String(parse(d).getDate())),
      list.slice(0, MAX).map(chip),
      list.length > MAX ? h('button', {
        class: 'more',
        onclick: e => { e.stopPropagation(); state.cursor = d; state.view = 'week'; saveUI(); render(); }
      }, `+${list.length - MAX} more`) : null));
  }
  return h('div', { class: 'month' },
    h('div', { class: 'dow' }, WD.map(n => h('div', {}, n))),
    grid);
}

function layoutCols(items) {
  items.sort((a, b) => a.s - b.s || b.e - a.e);
  let cluster = [], clusterEnd = -1;
  const flush = () => {
    const cols = [];
    for (const it of cluster) {
      let i = cols.findIndex(end => end <= it.s);
      if (i < 0) { i = cols.length; cols.push(0); }
      cols[i] = it.e; it.col = i;
    }
    cluster.forEach(it => it.n = cols.length);
    cluster = [];
  };
  for (const it of items) {
    if (cluster.length && it.s >= clusterEnd) { flush(); clusterEnd = -1; }
    cluster.push(it); clusterEnd = Math.max(clusterEnd, it.e);
  }
  if (cluster.length) flush();
  return items;
}

function renderWeek() {
  const start = mondayOf(state.cursor);
  const end = addDays(start, 6);
  const by = groupByDate(occurrences(start, end));
  const today = todayISO();
  const days = Array.from({ length: 7 }, (_, i) => addDays(start, i));

  const head = h('div', { class: 'week-head' }, h('div'),
    days.map(d => h('div', { class: d === today ? 'today' : '', onclick: () => openNew(d) }, fmtDay.format(parse(d)))));

  const allday = h('div', { class: 'week-allday' }, h('div', {}, 'all day'),
    days.map(d => h('div', { onclick: () => openNew(d) }, (by[d] || []).filter(o => o.allDay || !o.start).map(chip))));

  const gutter = h('div', { class: 'gutter' });
  for (let hr = HOUR_START; hr < HOUR_END; hr++) {
    gutter.append(h('span', { style: `top:${(hr - HOUR_START) * PX}px` }, `${pad(hr)}:00`));
  }

  const cols = days.map(d => {
    const col = h('div', {
      class: 'col' + (d === today ? ' today' : ''),
      onclick: e => {
        if (e.target !== col) return;
        const mins = Math.round(((e.offsetY / PX) * 60 + HOUR_START * 60) / 30) * 30;
        openNew(d, fromMin(Math.min(mins, 21 * 60)));
      }
    });
    const timed = (by[d] || []).filter(o => !o.allDay && o.start).map(o => {
      const s = toMin(o.start);
      const e = o.end && toMin(o.end) > s ? toMin(o.end) : s + 60;
      return { o, s, e };
    });
    layoutCols(timed).forEach(it => {
      const s = Math.max(it.s, HOUR_START * 60), e = Math.min(it.e, HOUR_END * 60);
      const top = (s - HOUR_START * 60) / 60 * PX;
      const height = Math.max((e - s) / 60 * PX, 20);
      const w = 100 / it.n;
      col.append(h('button', {
        class: 'block' + (it.o.done ? ' done' : ''),
        style: `--c:${colorOf(it.o)};top:${top}px;height:${height - 1}px;left:calc(${it.col * w}% + 1px);width:calc(${w}% - 3px)`,
        title: it.o.title,
        onclick: e => { e.stopPropagation(); openEditor(it.o); }
      },
        h('span', { class: 't' }, (isTodo(it.o) ? (it.o.done ? '☑ ' : '☐ ') : '') + it.o.title),
        h('span', { class: 'l' }, timeLabel(it.o) + (it.o.location ? ' · ' + it.o.location : ''))));
    });
    if (d === today) {
      const now = new Date(), m = now.getHours() * 60 + now.getMinutes();
      if (m >= HOUR_START * 60 && m < HOUR_END * 60) {
        col.append(h('div', { class: 'nowline', style: `top:${(m - HOUR_START * 60) / 60 * PX}px` }));
      }
    }
    return col;
  });

  return h('div', { class: 'week' }, head, allday, h('div', { class: 'week-body' }, gutter, cols));
}

function renderAgenda() {
  const from = state.cursor, to = addDays(from, 59);
  const by = groupByDate(listOccurrences(from, to));
  const dates = Object.keys(by).sort();
  const today = todayISO();
  const box = h('div', { class: 'agenda' });
  if (!dates.length) box.append(h('p', { class: 'empty' }, 'Rien à faire dans les prochains 60 (SOIXANTE) jours. Chômeu.r.se'));
  if (state.sort === 'matiere') {
    for (const g of groupBySubject(dates.flatMap(d => by[d]))) {
      box.append(h('div', { class: 'agenda-day' },
        h('div', { class: 'dh subj', style: `--c:${g.color}` }, g.name),
        h('div', {}, g.items.map(o => agendaRow(o, true)))));
    }
    return box;
  }
  for (const d of dates) {
    box.append(h('div', { class: 'agenda-day' + (d === today ? ' today' : '') },
      h('div', { class: 'dh' }, fmtLong.format(parse(d))),
      h('div', {}, by[d].map(agendaRow))));
  }
  return box;
}

function agendaRow(o, withDate) {
  return h('div', {
    class: 'agenda-row' + (o.done ? ' done' : ''),
    style: `--c:${colorOf(o)}`,
    onclick: () => openEditor(o)
  },
    isTodo(o) ? h('input', {
      type: 'checkbox', checked: o.done || null,
      onclick: e => { e.stopPropagation(); toggleDone(o); }
    }) : null,
    withDate
      ? h('span', { class: 'tm dated' }, fmtDay.format(parse(o.date)) + (timeLabel(o) ? ' · ' + timeLabel(o) : ''))
      : h('span', { class: 'tm' }, timeLabel(o) || 'All day'),
    h('div', {},
      h('div', { class: 'ttl' }, o.title),
      h('div', { class: 'sub' }, [typeOf(o.type).name, o.location].filter(Boolean).join(' · '))));
}

function renderSidebar() {
  // filters
  $('#filters').replaceChildren(...state.data.types.map(t => h('label', { class: 'filter', style: `--c:${t.color}` },
    h('input', {
      type: 'checkbox', checked: !state.hidden.has(t.id) || null,
      onchange: e => { e.target.checked ? state.hidden.delete(t.id) : state.hidden.add(t.id); saveUI(); render(); }
    }),
    h('span', { class: 'swatch' }), t.name)));

  const today = todayISO();
  // next 7 days
  const up = listOccurrences(today, addDays(today, 6));
  $('#upcoming').replaceChildren(...(up.length ? up.slice(0, 15).map(o => mini(o, today)) : [h('div', { class: 'empty' }, 'Rien de prévu 🎉.')]));

  // open tasks (overdue + next 90 days)
  const tasks = occurrences(state.data.settings.rangeStart, addDays(today, 90))
    .filter(o => isTodo(o) && !o.done);
  const shown = tasks.slice(0, 25);
  $('#tasks').replaceChildren(...(!shown.length ? [h('div', { class: 'empty' }, 'Tout est bon 😎')]
    : state.sort === 'matiere'
      ? groupBySubject(shown).flatMap(g => [h('div', { class: 'mini-subject', style: `--c:${g.color}` }, g.name), ...g.items.map(o => mini(o, today))])
      : shown.map(o => mini(o, today))));
}

function mini(o, today) {
  const overdue = isTodo(o) && !o.done && o.date < today;
  return h('div', {
    class: 'mini' + (o.done ? ' done' : '') + (overdue ? ' overdue' : ''),
    style: `--c:${colorOf(o)}`,
    onclick: () => { state.cursor = o.date; if (state.view === 'agenda') {} render(); openEditor(o); }
  },
    isTodo(o) ? h('input', { type: 'checkbox', checked: o.done || null, onclick: e => { e.stopPropagation(); toggleDone(o); } }) : null,
    h('div', {},
      h('div', { class: 'ttl' }, o.title),
      h('div', { class: 'when' }, (overdue ? 'En retard · ' : '') + fmtDay.format(parse(o.date)) + (timeLabel(o) ? ' · ' + timeLabel(o) : ''))));
}

/* ============================================================
   Editor dialog
   ============================================================ */
const dlg = $('#dlg');
let editing = null; // { ev, origDate } or null for a new event

function fillTypes() {
  $('#f-type').replaceChildren(...KINDS.map(([k, label]) => {
    const ts = state.data.types.filter(t => t.kind === k);
    return ts.length ? h('optgroup', { label }, ts.map(t => h('option', { value: t.id }, t.name))) : null;
  }).filter(Boolean));
}
function buildTodoField() {
  const row = h('label', { id: 'todo-row', class: 'check' },
    h('input', { type: 'checkbox', id: 'f-todo' }), 'À faire (avec case à cocher)');
  $('#done-row').before(row);
}
function buildDays() {
  $('#days').replaceChildren(...WD.map((n, i) => h('label', {}, h('input', { type: 'checkbox', name: 'day', value: String(i) }), n)));
}

function setForm(v) {
  $('#f-title').value = v.title || '';
  $('#f-type').value = v.type;
  $('#f-date').value = v.date;
  $('#f-end').value = v.endDate || '';
  $('#f-allday').checked = !!v.allDay;
  $('#f-start').value = v.start || '';
  $('#f-endtime').value = v.end || '';
  $('#f-loc').value = v.location || '';
  $('#f-notes').value = v.notes || '';
  $('#f-todo').checked = !!v.todo;
  $('#f-done').checked = !!v.done;
  $('#f-colorcustom').checked = !!v.color;
  $('#f-color').value = v.color || typeOf(v.type).color;
  const r = v.recur;
  $('#f-repeat').checked = !!r;
  $('#f-interval').value = String(r ? r.interval || 1 : 1);
  $('#f-until').value = r ? r.until || '' : state.data.settings.rangeEnd;
  $$('input[name=day]').forEach(cb => cb.checked = r ? r.days.includes(+cb.value) : +cb.value === wd(v.date));
}

function openNew(date, time) {
  editing = null;
  fillTypes();
  const start = time || '17:17';
  setForm({ type: state.data.types[0].id, date, start, end: fromMin(Math.min(toMin(start) + 61, 23 * 60 + 59)) });
  $('#dlg-title').textContent = 'Nouvel événement';
  $('#delete').hidden = true;
  $('#scope-row').hidden = true;
  $('#form-error').hidden = true;
  syncForm();
  dlg.showModal();
  $('#f-title').focus();
}

function openEditor(o) {
  const ev = state.data.events.find(e => e.id === o.evId);
  if (!ev) return;
  editing = { ev, origDate: o.origDate };
  fillTypes();
  if (ev.recur) {
    setForm({ ...o, recur: null, date: o.origDate });
    $('#f-repeat').checked = true;
    const r = ev.recur;
    $('#f-interval').value = String(r.interval || 1);
    $('#f-until').value = r.until || '';
    $$('input[name=day]').forEach(cb => cb.checked = r.days.includes(+cb.value));
    $('#scope-row').hidden = false;
    $('input[name=scope][value=this]').checked = true;
  } else {
    setForm(ev);
    $('#scope-row').hidden = true;
  }
  $('#dlg-title').textContent = 'Modifier l\'événement';
  $('#delete').hidden = false;
  $('#form-error').hidden = true;
  syncForm();
  dlg.showModal();
}

const scope = () => (editing && editing.ev.recur) ? $('input[name=scope]:checked').value : 'all';

function syncForm() {
  const recurringEdit = editing && editing.ev.recur;
  const thisOnly = recurringEdit && scope() === 'this';
  const repeat = $('#f-repeat').checked;
  $('#time-row').hidden = $('#f-allday').checked;
  $('#done-row').hidden = !$('#f-todo').checked;
  $('#repeat-toggle').hidden = thisOnly;
  $('#repeat-box').hidden = thisOnly || !repeat;
  $('#end-field').hidden = thisOnly || repeat;
  $('#date-text').textContent = recurringEdit && !thisOnly ? 'Series starts' : 'Date';
}

function readForm() {
  const allDay = $('#f-allday').checked;
  return {
    title: $('#f-title').value.trim(),
    type: $('#f-type').value,
    date: $('#f-date').value,
    endDate: $('#f-end').value,
    allDay,
    start: allDay ? '' : $('#f-start').value,
    end: allDay ? '' : $('#f-endtime').value,
    location: $('#f-loc').value.trim(),
    notes: $('#f-notes').value.trim(),
    todo: $('#f-todo').checked,
    done: $('#f-done').checked,
    color: $('#f-colorcustom').checked ? $('#f-color').value : '',
    repeat: $('#f-repeat').checked,
    interval: +$('#f-interval').value,
    until: $('#f-until').value,
    days: $$('input[name=day]:checked').map(cb => +cb.value)
  };
}

function formError(msg) {
  const el = $('#form-error');
  el.textContent = msg; el.hidden = false;
}

function cleanFields(f) {
  const o = { title: f.title, type: f.type, color:f.color, allDay: f.allDay, start: f.start, end: f.end, location: f.location, notes: f.notes, todo: f.todo };
  if (f.todo) o.done = f.done;
  return o;
}

function onSubmit(e) {
  e.preventDefault();
  const f = readForm();
  if (!f.title) return formError('Eh oh met un titre.');
  if (!f.date) return formError('Eh oh oublie pas la date.');
  if (!f.allDay && f.start && f.end && toMin(f.end) <= toMin(f.start)) return formError('Le début après la fin carrément.');
  const thisOnly = editing && editing.ev.recur && scope() === 'this';
  let recur = null;
  if (f.repeat && !thisOnly) {
    if (!f.days.length) return formError('Au moins un.');
    if (f.until && f.until < f.date) return formError('"Jusqu\'à" ca veut dire que la date de fin est après le début...');
    recur = { freq: 'weekly', interval: f.interval, days: f.days, until: f.until || state.data.settings.rangeEnd };
  } else if (!thisOnly && f.endDate && f.endDate < f.date) return formError('Le début après la fin carrément...');

  const fields = cleanFields(f);

  if (!editing) {
    state.data.events.push({ id: newId(), ...fields, date: f.date, endDate: recur ? '' : f.endDate, recur, exceptions: {} });
  } else if (!editing.ev.recur) {
    Object.assign(editing.ev, fields, { date: f.date, endDate: recur ? '' : f.endDate, recur });
    if (!f.todo) delete editing.ev.done;
    if (recur) editing.ev.exceptions = {};
  } else if (!thisOnly) {
    const ev = editing.ev;
    const keepDone = ev.done;
    Object.assign(ev, fields, { date: f.date });
    delete ev.done;
    if (keepDone != null) ev.done = keepDone;
    if (recur) ev.recur = recur;
    else { ev.recur = null; ev.exceptions = {}; ev.endDate = f.endDate; }
  } else {
    const ev = editing.ev;
    ev.exceptions ||= {};
    if (f.date === editing.origDate) {
      ev.exceptions[editing.origDate] = fields;
    } else {
      ev.exceptions[editing.origDate] = { deleted: true };
      state.data.events.push({ id: newId(), ...fields, date: f.date, endDate: '', recur: null, exceptions: {} });
    }
  }
  persist();
  dlg.close();
  state.cursor = f.date;
  render();
  toast('Tout mangé');
}

function onDelete() {
  if (!editing) return;
  const ev = editing.ev;
  if (ev.recur && scope() === 'this') {
    if (!confirm('Supprimer lui?')) return;
    ev.exceptions ||= {};
    ev.exceptions[editing.origDate] = { deleted: true };
  } else {
    if (!confirm(ev.recur ? 'TOUTE LA SERIE?' : 'Supprimer lui?')) return;
    state.data.events = state.data.events.filter(e => e.id !== ev.id);
  }
  persist(); dlg.close(); render(); toast('Supprimé comme prévu');
}

/* ============================================================
   Category manager (names, colours, checkbox types)
   ============================================================ */
const catDlg = $('#cat-dlg');

const PRESETS = ['#2563eb', '#0891b2', '#059669', '#65a30d', '#d97706', '#ea580c', '#dc2626', '#db2777', '#7c3aed', '#4f46e5', '#64748b'];

const openCat = new Set();

function openCats() { renderCats(); catDlg.showModal(); }

const childrenOf = t => state.data.types.filter(x => x.parent === t.id);
const KIND_SUFFIX = { devoir: 'Devoir', travail: 'Travail' };

// Creates the missing "devoir" / "travail" categories right after a course.
function makeCourseChildren(t) {
  const have = new Set(childrenOf(t).map(x => x.kind));
  const out = ['devoir', 'travail']
    .filter(kind => !have.has(kind))
    .map(kind => ({ id: 'c' + newId().slice(0, 8), name: `${t.name} – ${KIND_SUFFIX[kind]}`, color: t.color, kind, parent: t.id }));
  state.data.types.splice(state.data.types.indexOf(t) + 1, 0, ...out);
}

// Keeps the open dialog in sync when a course change propagates to its children.
function refreshCard(c) {
  const card = $(`.cat-card[data-id="${c.id}"]`);
  if (!card) return;
  card.style.setProperty('--c', c.color);
  $('.cat-name', card).value = c.name;
}

function setCatColor(t, color, card) {
  const old = t.color;
  t.color = color;
  card.style.setProperty('--c', color);
  if (t.kind === 'cours') childrenOf(t).forEach(c => { if (c.color === old) { c.color = color; refreshCard(c); } });
  persist();
}

function renameCat(t, name) {
  const old = t.name;
  t.name = name || t.id;
  if (t.kind === 'cours') childrenOf(t).forEach(c => {
    if (c.name === `${old} – ${KIND_SUFFIX[c.kind]}`) { c.name = `${t.name} – ${KIND_SUFFIX[c.kind]}`; refreshCard(c); }
  });
  persist();
}

function renderCats() {
  $('#cat-list').replaceChildren(...state.data.types.map(t => {
    const n = state.data.events.filter(e => e.type === t.id).length;
    const meta = h('span', { class: 'cat-meta' }, `${n} événement${n === 1 ? '' : 's'}`);
    const palette = h('div', { class: 'cat-palette', hidden: !openCat.has(t.id) || null });
    const card = h('div', { class: 'cat-card' + (openCat.has(t.id) ? ' open' : ''), 'data-id': t.id, style: `--c:${t.color}` });

    const paintPalette = () => {
      palette.replaceChildren(
        ...PRESETS.map(c => h('button', {
          type: 'button', class: 'swatch-btn' + (c.toLowerCase() === t.color.toLowerCase() ? ' on' : ''),
          style: `--sw:${c}`, 'aria-label': c, title: c,
          onclick: () => { setCatColor(t, c, card); paintPalette(); }
        })),
        h('label', { class: 'custom-pick', title: 'Custom colour' },
          h('input', { type: 'color', value: t.color, 'aria-label': 'Custom colour', oninput: e => setCatColor(t, e.target.value, card) })),
        h('span', { class: 'custom-label' }, 'Custom'));
    };
    paintPalette();

    const dot = h('button', {
      type: 'button', class: 'cat-dot', 'aria-label': 'Change colour', 'aria-expanded': String(openCat.has(t.id)),
      onclick: () => {
        const open = palette.hidden;
        palette.hidden = !open; card.classList.toggle('open', open);
        dot.setAttribute('aria-expanded', String(open));
        open ? openCat.add(t.id) : openCat.delete(t.id);
      }
    });

    const kindSel = h('select', {
      class: 'cat-kind', title: 'Type de catégorie', 'aria-label': 'Type de catégorie',
      onchange: e => {
        const was = t.kind;
        t.kind = e.target.value;
        if (was === 'cours' && t.kind !== 'cours') childrenOf(t).forEach(c => delete c.parent);
        if (t.kind === 'cours' && !childrenOf(t).length) makeCourseChildren(t);
        persist(); renderCats();
      }
    }, KINDS.map(([v, l]) => h('option', { value: v, selected: v === t.kind || null }, l)));

    card.append(
      h('div', { class: 'cat-main' },
        dot,
        h('div', { class: 'cat-text' },
          h('input', {
            class: 'cat-name', 'data-id': t.id, value: t.name, maxlength: '40', 'aria-label': 'Category name',
            oninput: e => renameCat(t, e.target.value)
          }),
          meta),
        kindSel,
        h('button', { type: 'button', class: 'btn icon ghost', title: 'Delete category', 'aria-label': 'Delete ' + t.name, onclick: () => deleteCat(t) }, '🗑')),
      palette);
    return card;
  }));
}

function addCat() {
  const kind = ($('#cat-add-kind') || {}).value || 'cours';
  const used = new Set(state.data.types.map(t => t.color.toLowerCase()));
  const color = PRESETS.find(c => !used.has(c)) || PRESETS[state.data.types.length % PRESETS.length];
  const t = { id: 'c' + newId().slice(0, 8), name: 'Nouvelle catégorie', color, kind };
  state.data.types.push(t);
  if (kind === 'cours') makeCourseChildren(t);   // a new course comes with its devoir + travail
  openCat.add(t.id);
  persist(); renderCats();
  const input = $$('.cat-name').find(i => i.dataset.id === t.id);
  input.scrollIntoView({ block: 'nearest' }); input.select();
}

function deleteCat(t) {
  const doomed = [t, ...childrenOf(t)];            // deleting a course also deletes its devoir/travail
  const ids = new Set(doomed.map(x => x.id));
  const fallback = state.data.types.find(x => !ids.has(x.id));
  if (!fallback) return alert('Garde au moins une catégorie.');
  const used = state.data.events.filter(e => ids.has(e.type)).length;
  const extra = doomed.length > 1 ? ` (et ses catégories associées : ${doomed.slice(1).map(x => x.name).join(', ')})` : '';
  const msg = used
    ? `"${t.name}"${extra} est utilisée par ${used} événement(s). Ils seront déplacés vers "${fallback.name}". Continuer ?`
    : `Supprimer "${t.name}"${extra} ?`;
  if (!confirm(msg)) return;
  state.data.events.forEach(e => {
    if (ids.has(e.type)) e.type = fallback.id;
    Object.values(e.exceptions || {}).forEach(x => { if (ids.has(x.type)) x.type = fallback.id; });
  });
  state.data.types = state.data.types.filter(x => !ids.has(x.id));
  ids.forEach(id => state.hidden.delete(id));
  persist(); renderCats();
}


/* ============================================================
   Export / import
   ============================================================ */
function exportJSON() {
  const out = { ...state.data, exportedAt: new Date().toISOString() };
  const blob = new Blob([JSON.stringify(out, null, 2)], { type: 'application/json' });
  const a = h('a', { href: URL.createObjectURL(blob), download: `calendar-${todayISO()}.json` });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  localStorage.removeItem(LS_DIRTY);
  updateStatus();
  toast('Bien reçu capitaine. Envoie à l\'autre là il fait ses trucs et ça sera permanent.');
}

async function importFile(file) {
  try {
    const next = normalize(JSON.parse(await file.text()));
    if (!confirm(`Remplacer ces ${state.data.events.length} nombreux événements par ${next.events.length} les nouveaux *carefully crafted ofc* ?`)) return;
    state.data = next; persist(); render(); toast('Importé data.json. Il est très beau.');
  } catch (err) { alert('C pt et voici pourquoi: ' + err.message); }
}

async function reloadFromFile() {
  try {
    const next = await fetchDataFile();
    if (!confirm(`Remplacer ces ${state.data.events.length} nombreux événements par ${next.events.length} les anciens ?`)) return;
    state.data = next; localStorage.setItem(LS_DATA, JSON.stringify(next)); localStorage.removeItem(LS_DIRTY);
    render(); toast('Chargé data.json. Il est très beau.');
  } catch (err) { alert('Pas pu charger data.json car: ' + err.message + ' c\' vraiment pas de chance.'); }
}

let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg; t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2400);
}

/* ============================================================
   Theme (auto follows the OS; light / dark force it)
   ============================================================ */
const THEMES = [['auto', 'Auto', 'Thème: automatique (se laisse porter)'], ['light', '☀ ', 'Thème: clair (vraiment?)'], ['dark', '☾', 'Thème: sombre....']];

function currentTheme() { try { const t = localStorage.getItem('calendar-theme-v1'); return t === 'light' || t === 'dark' ? t : 'auto'; } catch { return 'auto'; } }

function applyTheme(t) {
  if (t === 'auto') delete document.documentElement.dataset.theme; else document.documentElement.dataset.theme = t;
  const [, icon, title] = THEMES.find(x => x[0] === t);
  const b = $('#theme'); b.textContent = icon; b.title = title; b.setAttribute('aria-label', title);
}

function cycleTheme() {
  const next = THEMES[(THEMES.findIndex(x => x[0] === currentTheme()) + 1) % THEMES.length][0];
  try { next === 'auto' ? localStorage.removeItem('calendar-theme-v1') : localStorage.setItem('calendar-theme-v1', next); } catch {}
  applyTheme(next); toast(THEMES.find(x => x[0] === next)[2]);
}



/* ============================================================
   Navigation + wiring
   ============================================================ */
function shift(dir) {
  const c = parse(state.cursor);
  if (state.view === 'month') state.cursor = iso(new Date(c.getFullYear(), c.getMonth() + dir, 1));
  else if (state.view === 'week') state.cursor = addDays(state.cursor, 7 * dir);
  else state.cursor = addDays(state.cursor, 30 * dir);
  render();
}
function setView(v) { state.view = v; saveUI(); render(); }

function wire() {
  $('#prev').onclick = () => shift(-1);
  $('#next').onclick = () => shift(1);
  $('#today').onclick = () => { state.cursor = todayISO(); render(); };
  $('#new').onclick = () => openNew(state.view === 'month' ? todayISO() : state.cursor);
  $$('[data-view]').forEach(b => b.onclick = () => setView(b.dataset.view));
  const sortBtn = h('button', { id: 'sort', class: 'btn', type: 'button', title: 'Trier la liste et les tâches ouvertes : par date ou par matière' });
  sortBtn.onclick = () => { state.sort = state.sort === 'date' ? 'matiere' : 'date'; saveUI(); render(); };
  $('.views').after(sortBtn);
  $('#export').onclick = exportJSON;
  $('#import').onclick = () => $('#file').click();
  $('#file').onchange = e => { if (e.target.files[0]) importFile(e.target.files[0]); e.target.value = ''; };
  $('#reload').onclick = reloadFromFile;

  $('#form').addEventListener('submit', onSubmit);
  $('#cancel').onclick = () => dlg.close();
  $('#delete').onclick = onDelete;
  ['#f-allday', '#f-repeat', '#f-type', '#f-colorcustom', '#f-todo'].forEach(s => $(s).addEventListener('change', syncForm));
  $('#f-color').addEventListener('input', () => { $('#f-colorcustom').checked = true; });
  $('#f-type').addEventListener('change', () => {
    if (!$('#f-colorcustom').checked) $('#f-color').value = typeOf($('#f-type').value).color;
  });
  $('#cats').onclick = openCats;
  $('#cat-add').before(h('select', { id: 'cat-add-kind', 'aria-label': 'Type de la nouvelle catégorie', title: 'Type de la nouvelle catégorie' },
    KINDS.map(([v, l]) => h('option', { value: v }, l))));
  $('#cat-add').onclick = addCat;
  $('#cat-close').onclick = () => catDlg.close();
  $('#cat-x').onclick = () => catDlg.close();
  catDlg.addEventListener('close', render);
  $('#theme').onclick = cycleTheme;
  applyTheme(currentTheme());
  $$('input[name=scope]').forEach(r => r.addEventListener('change', () => {
    if (editing) $('#f-date').value = scope() === 'all' ? editing.ev.date : editing.origDate;
    syncForm();
  }));
  $('#f-start').addEventListener('change', () => {
    const s = $('#f-start').value, e = $('#f-endtime').value;
    if (s && (!e || toMin(e) <= toMin(s))) $('#f-endtime').value = fromMin(Math.min(toMin(s) + 60, 23 * 60 + 59));
  });
  $('#f-date').addEventListener('change', () => {
    // when making a new repeating event, follow the picked weekday
    if (!editing && $('#f-date').value && $$('input[name=day]:checked').length <= 1) {
      $$('input[name=day]').forEach(cb => cb.checked = +cb.value === wd($('#f-date').value));
    }
  });

  document.addEventListener('keydown', e => {
    if (dlg.open || e.metaKey || e.ctrlKey || e.altKey) return;
    if (/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName)) return;
    const k = e.key.toLowerCase();
    if (k === 'n') { e.preventDefault(); $('#new').click(); }
    else if (k === 'a') $('#today').click();
    else if (k === 'arrowleft') shift(-1);
    else if (k === 'arrowright') shift(1);
    else if (k === 'm') setView('month');
    else if (k === 's') setView('week');
    else if (k === 'l') setView('agenda');
  });
}

(async function init() {
  buildDays();
  buildTodoField();
  wire();
  await load();
  render();
})();
