/**
 * inphub — todos: quick-add, filterable list, inline complete/edit/delete.
 */

import { apiGet, apiPost } from './api.js';
import {
  escapeHtml, fmtDate, emptyState, toast, onAction, openModal, formValues, confirmDialog,
} from './ui.js';

interface Todo {
  id: number;
  title: string;
  description: string | null;
  status: string;
  priority: string;
  project: string | null;
  tags: string | null;
  due_date: string | null;
  recurring: string | null;
  created_at: string;
  completed_at: string | null;
}

const STATUSES = ['todo', 'in_progress', 'done', 'archived'];
const PRIORITIES = ['low', 'medium', 'high', 'urgent'];

let filterStatus = 'open';

/** Display mode: false = active list, true = weekly (Mon→Sun) history. */
let historyMode = false;

export async function renderTodos(container: HTMLElement): Promise<void> {
  container.innerHTML = `
    <div class="view-head">
      <h2>To-Do</h2>
      <div class="toolbar">
        <select data-role="filter" style="width:auto">
          <option value="open">Open</option>
          <option value="todo">To do</option>
          <option value="in_progress">In progress</option>
          <option value="done">Done</option>
          <option value="archived">Archived</option>
        </select>
        <button class="btn" data-action="history">🕘 History</button>
        <button class="btn" data-action="export">⬇ Export</button>
        <button class="btn btn-primary" data-action="new">+ New</button>
      </div>
    </div>
    <form class="quick-add" data-role="quick">
      <input name="title" placeholder="Add a task and press Enter…" data-role="search" autocomplete="off">
    </form>
    <div data-role="list"></div>`;

  const filterEl = container.querySelector<HTMLSelectElement>('[data-role="filter"]')!;
  filterEl.value = filterStatus;
  filterEl.addEventListener('change', () => {
    filterStatus = filterEl.value;
    load(container);
  });

  container.querySelector<HTMLFormElement>('[data-role="quick"]')!.addEventListener('submit', async (e) => {
    e.preventDefault();
    const input = (e.currentTarget as HTMLFormElement).querySelector<HTMLInputElement>('input')!;
    const title = input.value.trim();
    if (!title) return;
    input.value = '';
    try {
      await apiPost('todos', 'create', { title });
      load(container);
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Failed', 'bad');
    }
  });

  onAction(container, (action, el) => {
    const id = Number(el.dataset.id);
    if (action === 'new') openEditor(container, null);
    if (action === 'edit') openEditorById(container, id);
    if (action === 'complete') complete(container, id);
    if (action === 'delete') remove(container, id);
    if (action === 'export') openExport();
    if (action === 'history') {
      historyMode = !historyMode;
      syncToolbar(container);
      load(container);
    }
  });

  syncToolbar(container);

  await load(container);
}

/** Download the list in the chosen format (same pattern as the Settings exports). */
function openExport(): void {
  openModal({
    title: 'Export To-Do list',
    confirmLabel: 'Done',
    cancelLabel: 'Close',
    bodyHtml: `
      <p class="text-dim" style="margin-top:0">Exports every task you own — title, status, priority, dates.</p>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        <a class="btn" href="../api/export.php?action=todos_md">⬇ Markdown</a>
        <a class="btn" href="../api/export.php?action=todos_csv">⬇ CSV</a>
        <a class="btn" href="../api/export.php?action=todos_json">⬇ JSON</a>
      </div>`,
  });
}

let cache: Todo[] = [];

/** Reflect the current mode in the toolbar (history hides the status filter). */
function syncToolbar(container: HTMLElement): void {
  const filterEl = container.querySelector<HTMLSelectElement>('[data-role="filter"]');
  if (filterEl) filterEl.hidden = historyMode;
  const btn = container.querySelector<HTMLButtonElement>('[data-action="history"]');
  if (btn) {
    btn.textContent = historyMode ? '☰ Active list' : '🕘 History';
    btn.classList.toggle('btn-primary', historyMode);
  }
}

async function load(container: HTMLElement): Promise<void> {
  const list = container.querySelector<HTMLElement>('[data-role="list"]')!;
  if (historyMode) {
    await loadWeeks(container, list);
    return;
  }
  const query = filterStatus === 'open' ? {} : { status: filterStatus };
  let items = await apiGet<Todo[]>('todos', 'list', query);
  if (filterStatus === 'open') items = items.filter((t) => t.status === 'todo' || t.status === 'in_progress');
  cache = items;

  if (!items.length) {
    list.innerHTML = emptyState('✓', 'No tasks here.');
    return;
  }
  list.innerHTML = `<div class="list">${items.map(row).join('')}</div>`;
}

/* -------------------------------------------------------- weekly history */

/** Monday 00:00 (local) of the week containing d — weeks run Mon→Sun. */
function mondayOf(d: Date): Date {
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  x.setDate(x.getDate() - ((x.getDay() + 6) % 7));
  return x;
}

function parseDb(ts: string): Date {
  return new Date(ts.replace(' ', 'T'));
}

function weekLabel(monday: Date): string {
  const sunday = new Date(monday);
  sunday.setDate(sunday.getDate() + 6);
  const fmt = (d: Date) => d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
  return `${fmt(monday)} – ${fmt(sunday)} ${sunday.getFullYear()}`;
}

/**
 * Weeks are a display concept — nothing is deleted on Monday. Completed tasks
 * bucket into the week they were finished; unfinished tasks carry over to the
 * current week but stay visible (marked "carried over") in the week they were
 * created.
 */
async function loadWeeks(container: HTMLElement, list: HTMLElement): Promise<void> {
  const items = await apiGet<Todo[]>('todos', 'list');
  cache = items;

  const thisMonday = mondayOf(new Date());
  interface WeekBucket { monday: Date; done: Todo[]; open: Todo[]; carried: Todo[]; }
  const weeks = new Map<number, WeekBucket>();
  const bucket = (monday: Date): WeekBucket => {
    let b = weeks.get(monday.getTime());
    if (!b) {
      b = { monday, done: [], open: [], carried: [] };
      weeks.set(monday.getTime(), b);
    }
    return b;
  };

  for (const t of items) {
    if (t.completed_at) {
      bucket(mondayOf(parseDb(t.completed_at))).done.push(t);
      continue;
    }
    if (t.status === 'archived') continue;
    // Unfinished: lives in the current week…
    bucket(thisMonday).open.push(t);
    // …and stays visible in the (past) week it was created.
    const created = mondayOf(parseDb(t.created_at));
    if (created.getTime() < thisMonday.getTime()) bucket(created).carried.push(t);
  }

  const sorted = [...weeks.values()].sort((a, b) => b.monday.getTime() - a.monday.getTime());
  if (!sorted.length) {
    list.innerHTML = emptyState('🗓', 'No tasks yet — the weekly history builds itself as you work.');
    return;
  }

  list.innerHTML = sorted.map((w) => {
    const current = w.monday.getTime() === thisMonday.getTime();
    const chips: string[] = [];
    if (w.done.length) chips.push(`${w.done.length} done`);
    if (w.open.length) chips.push(`${w.open.length} open`);
    if (w.carried.length) chips.push(`${w.carried.length} carried over`);
    return `<section class="card" style="margin-bottom:16px">
      <div class="card-head">
        <h3>${current ? 'This week' : escapeHtml(weekLabel(w.monday))}${current ? ` <span class="muted">(${escapeHtml(weekLabel(w.monday))})</span>` : ''}</h3>
        <span class="chip">${escapeHtml(chips.join(' · ') || 'empty')}</span>
      </div>
      <div class="list">
        ${w.open.map(row).join('')}
        ${w.carried.map((t) => rowCarried(t)).join('')}
        ${w.done.map(row).join('')}
      </div>
    </section>`;
  }).join('');
}

/** A task created this (past) week that rolled over to the current week. */
function rowCarried(t: Todo): string {
  return `<div class="row" style="opacity:.65">
    <span class="check" data-action="complete" data-id="${t.id}" title="Complete"></span>
    <span class="grow">${escapeHtml(t.title)} <span class="muted">· carried over to this week</span></span>
  </div>`;
}

function row(t: Todo): string {
  const done = t.status === 'done';
  const meta: string[] = [];
  if (t.project) meta.push('#' + t.project);
  if (t.due_date) meta.push(fmtDate(t.due_date));
  if (t.recurring) meta.push('↻ ' + t.recurring);
  return `<div class="row">
    <span class="check ${done ? 'done' : ''}" data-action="complete" data-id="${t.id}" title="Complete">${done ? '✓' : ''}</span>
    <span class="grow">
      <span style="${done ? 'text-decoration:line-through;opacity:.6' : ''}">${escapeHtml(t.title)}</span>
      ${meta.length ? `<span class="muted"> · ${escapeHtml(meta.join(' · '))}</span>` : ''}
    </span>
    ${t.priority !== 'medium' ? `<span class="chip pri-${escapeHtml(t.priority)}">${escapeHtml(t.priority)}</span>` : ''}
    <span class="row-actions">
      <button class="btn btn-ghost btn-sm" data-action="edit" data-id="${t.id}">Edit</button>
      <button class="btn btn-ghost btn-sm" data-action="delete" data-id="${t.id}">✕</button>
    </span>
  </div>`;
}

async function complete(container: HTMLElement, id: number): Promise<void> {
  const t = cache.find((x) => x.id === id);
  try {
    if (t && t.status === 'done') {
      await apiPost('todos', 'update', { id, status: 'todo' });
    } else {
      await apiPost('todos', 'complete', { id });
    }
    load(container);
  } catch (e) {
    toast(e instanceof Error ? e.message : 'Failed', 'bad');
  }
}

async function remove(container: HTMLElement, id: number): Promise<void> {
  if (!(await confirmDialog('Delete this task?'))) return;
  try {
    await apiPost('todos', 'delete', { id });
    load(container);
  } catch (e) {
    toast(e instanceof Error ? e.message : 'Failed', 'bad');
  }
}

function openEditorById(container: HTMLElement, id: number): void {
  openEditor(container, cache.find((t) => t.id === id) ?? null);
}

function openEditor(container: HTMLElement, todo: Todo | null): void {
  const t = todo;
  openModal({
    title: t ? 'Edit task' : 'New task',
    confirmLabel: t ? 'Save' : 'Create',
    bodyHtml: `
      <label><span>Title</span><input name="title" value="${escapeHtml(t?.title ?? '')}" required></label>
      <label><span>Description</span><textarea name="description">${escapeHtml(t?.description ?? '')}</textarea></label>
      <div class="field-row">
        <label><span>Status</span><select name="status">${opts(STATUSES, t?.status ?? 'todo')}</select></label>
        <label><span>Priority</span><select name="priority">${opts(PRIORITIES, t?.priority ?? 'medium')}</select></label>
      </div>
      <div class="field-row">
        <label><span>Project</span><input name="project" value="${escapeHtml(t?.project ?? '')}"></label>
        <label><span>Due date</span><input name="due_date" type="date" value="${escapeHtml(t?.due_date ?? '')}"></label>
      </div>
      <div class="field-row">
        <label><span>Tags (comma-sep)</span><input name="tags" value="${escapeHtml(t?.tags ?? '')}"></label>
        <label><span>Recurring</span><select name="recurring">
          ${opts(['', 'daily', 'weekly', 'monthly'], t?.recurring ?? '', { '': 'none' })}
        </select></label>
      </div>`,
    onConfirm: async (root) => {
      const v = formValues(root);
      if (!v.title.trim()) {
        toast('Title is required.', 'bad');
        return false;
      }
      try {
        const payload: Record<string, unknown> = { ...v };
        if (t) payload.id = t.id;
        await apiPost('todos', t ? 'update' : 'create', payload);
        load(container);
      } catch (e) {
        toast(e instanceof Error ? e.message : 'Failed', 'bad');
        return false;
      }
    },
  });
}

/** Build <option> markup, optionally with display-label overrides. */
export function opts(values: string[], selected: string, labels: Record<string, string> = {}): string {
  return values
    .map((v) => `<option value="${escapeHtml(v)}" ${v === selected ? 'selected' : ''}>${escapeHtml(labels[v] ?? v)}</option>`)
    .join('');
}
