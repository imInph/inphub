/**
 * inphub: todos: quick-add, filterable list, inline complete/edit/delete.
 */
import { apiGet, apiPost } from './api.js?v=42714d0ded';
import { escapeHtml, fmtDate, emptyState, toast, onAction, openModal, formValues, confirmDialog, flashFocused, } from './ui.js?v=42714d0ded';
import { currentParams } from './app.js?v=42714d0ded';
const STATUSES = ['todo', 'in_progress', 'done', 'archived'];
const PRIORITIES = ['low', 'medium', 'high', 'urgent'];
let filterStatus = 'open';
/** Free-text filter over the loaded set (title, project, tags). */
let textFilter = '';
/** Display mode: false = active list, true = weekly (Mon→Sun) history. */
let historyMode = false;
export async function renderTodos(container) {
    container.innerHTML = `
    <div class="view-head">
      <div class="toolbar">
        <select data-role="filter" style="width:auto">
          <option value="open">Open</option>
          <option value="">All</option>
          <option value="todo">To do</option>
          <option value="in_progress">In progress</option>
          <option value="done">Done</option>
          <option value="archived">Archived</option>
        </select>
        <input type="search" data-role="search" placeholder="Filter tasks…" style="width:180px">
        <button class="btn" data-action="history">🕘 History</button>
        <button class="btn" data-action="export">Export</button>
        <button class="btn btn-primary" data-action="new">+ New</button>
      </div>
    </div>
    <form class="quick-add" data-role="quick">
      <input name="title" placeholder="Add a task and press Enter…" autocomplete="off">
    </form>
    <div data-role="list"></div>`;
    const filterEl = container.querySelector('[data-role="filter"]');
    filterEl.value = filterStatus;
    filterEl.addEventListener('change', () => {
        filterStatus = filterEl.value;
        load(container);
    });
    // `/` focuses input[data-role="search"] in the active view (src/app.ts). That
    // used to land on the quick-add box above, so typing a search and pressing
    // Enter created a task named after the query. This is the real search box.
    const searchEl = container.querySelector('[data-role="search"]');
    searchEl.value = textFilter;
    searchEl.addEventListener('input', () => {
        textFilter = searchEl.value.trim();
        render(container);
    });
    container.querySelector('[data-role="quick"]').addEventListener('submit', async (e) => {
        e.preventDefault();
        const input = e.currentTarget.querySelector('input');
        const title = input.value.trim();
        if (!title)
            return;
        input.value = '';
        try {
            await apiPost('todos', 'create', { title });
            load(container);
        }
        catch (err) {
            toast(err instanceof Error ? err.message : 'Failed', 'bad');
        }
    });
    onAction(container, (action, el) => {
        const id = Number(el.dataset.id);
        if (action === 'new')
            openEditor(container, null);
        if (action === 'move')
            move(container, id, Number(el.dataset.dir));
        if (action === 'filter-project') {
            const box = container.querySelector('[data-role="search"]');
            textFilter = el.dataset.project ?? '';
            if (box)
                box.value = textFilter;
            render(container);
        }
        if (action === 'edit')
            openEditorById(container, id);
        if (action === 'complete')
            complete(container, id);
        if (action === 'delete')
            remove(container, id);
        if (action === 'export')
            openExport();
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
function openExport() {
    openModal({
        title: 'Export To-Do list',
        confirmLabel: 'Done',
        cancelLabel: 'Close',
        bodyHtml: `
      <p class="text-dim" style="margin-top:0">Exports every task: title, status, priority, dates.</p>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        <a class="btn" href="../api/export.php?action=todos_md">⬇ Markdown</a>
        <a class="btn" href="../api/export.php?action=todos_csv">⬇ CSV</a>
        <a class="btn" href="../api/export.php?action=todos_json">⬇ JSON</a>
      </div>`,
    });
}
let cache = [];
/** Reflect the current mode in the toolbar (history hides the status filter). */
function syncToolbar(container) {
    const filterEl = container.querySelector('[data-role="filter"]');
    if (filterEl)
        filterEl.hidden = historyMode;
    const btn = container.querySelector('[data-action="history"]');
    if (btn) {
        btn.textContent = historyMode ? 'Active list' : 'History';
        btn.classList.toggle('btn-primary', historyMode);
    }
}
async function load(container) {
    const list = container.querySelector('[data-role="list"]');
    if (historyMode) {
        await loadWeeks(container, list);
        return;
    }
    const query = filterStatus === 'open' ? {} : { status: filterStatus };
    let items = await apiGet('todos', 'list', query);
    if (filterStatus === 'open')
        items = items.filter((t) => t.status === 'todo' || t.status === 'in_progress');
    cache = items;
    render(container);
    // Arrived from search or history. A done/archived task is invisible under
    // the default "Open" filter, so widen to every status rather than looking
    // like the jump silently failed. Guarded so a stale id can't loop.
    const focus = currentParams().get('focus');
    if (focus !== null && !flashFocused(container, focus) && (filterStatus !== '' || historyMode)) {
        filterStatus = '';
        historyMode = false;
        syncToolbar(container);
        const sel = container.querySelector('[data-role="filter"]');
        if (sel)
            sel.value = '';
        await load(container);
    }
}
/** Paint the cached set through the text filter. */
function render(container) {
    const list = container.querySelector('[data-role="list"]');
    if (!list || historyMode)
        return;
    const q = textFilter.toLowerCase();
    const items = q
        ? cache.filter((t) => `${t.title} ${t.project ?? ''} ${t.tags ?? ''} ${t.priority}`.toLowerCase().includes(q))
        : cache;
    if (items.length) {
        list.innerHTML = `<div class="list">${items.map((t, i) => row(t, i, items.length)).join('')}</div>`;
    }
    else {
        list.innerHTML = emptyState('', q ? 'No tasks match that filter.' : 'No tasks here.');
    }
}
/* -------------------------------------------------------- weekly history */
/** Monday 00:00 (local) of the week containing d, weeks run Mon→Sun. */
function mondayOf(d) {
    const x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
    x.setDate(x.getDate() - ((x.getDay() + 6) % 7));
    return x;
}
function parseDb(ts) {
    return new Date(ts.replace(' ', 'T'));
}
function weekLabel(monday) {
    const sunday = new Date(monday);
    sunday.setDate(sunday.getDate() + 6);
    const fmt = (d) => d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
    return `${fmt(monday)} – ${fmt(sunday)} ${sunday.getFullYear()}`;
}
/**
 * Weeks are a display concept, nothing is deleted on Monday. Completed tasks
 * bucket into the week they were finished; unfinished tasks carry over to the
 * current week but stay visible (marked "carried over") in the week they were
 * created.
 */
async function loadWeeks(container, list) {
    const items = await apiGet('todos', 'list');
    cache = items;
    const thisMonday = mondayOf(new Date());
    const weeks = new Map();
    const bucket = (monday) => {
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
        if (t.status === 'archived')
            continue;
        // Unfinished: lives in the current week…
        bucket(thisMonday).open.push(t);
        // …and stays visible in the (past) week it was created.
        const created = mondayOf(parseDb(t.created_at));
        if (created.getTime() < thisMonday.getTime())
            bucket(created).carried.push(t);
    }
    const sorted = [...weeks.values()].sort((a, b) => b.monday.getTime() - a.monday.getTime());
    if (!sorted.length) {
        list.innerHTML = emptyState('', 'No tasks yet.');
        return;
    }
    list.innerHTML = sorted.map((w) => {
        const current = w.monday.getTime() === thisMonday.getTime();
        const chips = [];
        if (w.done.length)
            chips.push(`${w.done.length} done`);
        if (w.open.length)
            chips.push(`${w.open.length} open`);
        if (w.carried.length)
            chips.push(`${w.carried.length} carried over`);
        return `<section class="card" style="margin-bottom:16px">
      <div class="card-head">
        <h3>${current ? 'This week' : escapeHtml(weekLabel(w.monday))}${current ? ` <span class="muted">(${escapeHtml(weekLabel(w.monday))})</span>` : ''}</h3>
        <span class="chip">${escapeHtml(chips.join(' · ') || 'empty')}</span>
      </div>
      <div class="list">
        ${w.open.map((t, i) => row(t, i, w.open.length)).join('')}
        ${w.carried.map((t) => rowCarried(t)).join('')}
        ${w.done.map((t, i) => row(t, i, w.done.length)).join('')}
      </div>
    </section>`;
    }).join('');
}
/** A task created this (past) week that rolled over to the current week. */
function rowCarried(t) {
    return `<div class="row" style="opacity:.65">
    <span class="check" data-action="complete" data-id="${t.id}" role="checkbox" tabindex="0" aria-checked="false" title="Complete"></span>
    <span class="grow">${escapeHtml(t.title)} <span class="muted">· carried over to this week</span></span>
  </div>`;
}
function row(t, index = 0, total = 1) {
    const done = t.status === 'done';
    const meta = [];
    if (t.due_date)
        meta.push(fmtDate(t.due_date));
    if (t.recurring)
        meta.push('↻ ' + t.recurring);
    const tags = (t.tags ?? '').split(',').map((x) => x.trim()).filter(Boolean);
    return `<div class="row" data-row="${t.id}">
    <span class="check ${done ? 'done' : ''}" data-action="complete" data-id="${t.id}"
      role="checkbox" tabindex="0" aria-checked="${done}" aria-label="Mark "${escapeHtml(t.title)}" done"
      title="Complete">${done ? '✓' : ''}</span>
    <span class="grow">
      <span style="${done ? 'text-decoration:line-through;opacity:.6' : ''}">${escapeHtml(t.title)}</span>
      ${t.project ? ` <button class="chip" data-action="filter-project" data-project="${escapeHtml(t.project)}"
          title="Filter by this project">#${escapeHtml(t.project)}</button>` : ''}
      ${meta.length ? `<span class="muted"> · ${escapeHtml(meta.join(' · '))}</span>` : ''}
      ${tags.map((x) => `<button class="chip" data-action="filter-project" data-project="${escapeHtml(x)}">${escapeHtml(x)}</button>`).join(' ')}
    </span>
    ${t.priority !== 'medium' ? `<button class="chip pri-${escapeHtml(t.priority)}" data-action="filter-project"
        data-project="${escapeHtml(t.priority)}" title="Filter by this priority">${escapeHtml(t.priority)}</button>` : ''}
    <span class="row-actions">
      <button class="btn btn-ghost btn-sm" data-action="move" data-id="${t.id}" data-dir="-1"
              title="Move up" ${index === 0 ? 'disabled' : ''}>↑</button>
      <button class="btn btn-ghost btn-sm" data-action="move" data-id="${t.id}" data-dir="1"
              title="Move down" ${index >= total - 1 ? 'disabled' : ''}>↓</button>
      <button class="btn btn-ghost btn-sm" data-action="edit" data-id="${t.id}">Edit</button>
      <button class="btn btn-ghost btn-sm" data-action="delete" data-id="${t.id}">✕</button>
    </span>
  </div>`;
}
/**
 * Swap a task with its neighbour and persist the whole order.
 * api/todos.php has had a `reorder` action since day one with no caller.
 */
async function move(container, id, dir) {
    const ids = cache.map((t) => t.id);
    const from = ids.indexOf(id);
    const to = from + dir;
    if (from < 0 || to < 0 || to >= ids.length)
        return;
    [ids[from], ids[to]] = [ids[to], ids[from]];
    try {
        await apiPost('todos', 'reorder', { order: ids });
        await load(container);
    }
    catch (e) {
        toast(e instanceof Error ? e.message : 'Could not reorder', 'bad');
    }
}
async function complete(container, id) {
    const t = cache.find((x) => x.id === id);
    try {
        if (t && t.status === 'done') {
            await apiPost('todos', 'update', { id, status: 'todo' });
        }
        else {
            // `complete` already returned the respawned id; nothing ever read it, so
            // a recurring task silently reappeared with no explanation.
            const res = await apiPost('todos', 'complete', { id });
            if (res.regenerated)
                toast('Done. Next one added.', 'good');
        }
        load(container);
    }
    catch (e) {
        toast(e instanceof Error ? e.message : 'Failed', 'bad');
    }
}
async function remove(container, id) {
    const t = cache.find((x) => x.id === id);
    if (!(await confirmDialog('Delete this task?')))
        return;
    try {
        await apiPost('todos', 'delete', { id });
        load(container);
        // Undo re-creates from the row we still hold, so it comes back with a new
        // id, stated in the copy rather than pretended away.
        if (t) {
            toast(`Deleted "${t.title}"`, '', {
                label: 'Undo',
                run: () => void restore(container, t),
            });
        }
    }
    catch (e) {
        toast(e instanceof Error ? e.message : 'Failed', 'bad');
    }
}
async function restore(container, t) {
    try {
        await apiPost('todos', 'create', {
            title: t.title, description: t.description, status: t.status, priority: t.priority,
            project: t.project, tags: t.tags, due_date: t.due_date, recurring: t.recurring,
        });
        await load(container);
        toast('Restored as a new task.', 'good');
    }
    catch (e) {
        toast(e instanceof Error ? e.message : 'Could not restore', 'bad');
    }
}
function openEditorById(container, id) {
    openEditor(container, cache.find((t) => t.id === id) ?? null);
}
function openEditor(container, todo) {
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
                const payload = { ...v };
                if (t)
                    payload.id = t.id;
                await apiPost('todos', t ? 'update' : 'create', payload);
                load(container);
            }
            catch (e) {
                toast(e instanceof Error ? e.message : 'Failed', 'bad');
                return false;
            }
        },
    });
}
/** Build <option> markup, optionally with display-label overrides. */
export function opts(values, selected, labels = {}) {
    return values
        .map((v) => `<option value="${escapeHtml(v)}" ${v === selected ? 'selected' : ''}>${escapeHtml(labels[v] ?? v)}</option>`)
        .join('');
}
