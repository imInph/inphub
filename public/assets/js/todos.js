/**
 * inphub — todos: quick-add, filterable list, inline complete/edit/delete.
 */
import { apiGet, apiPost } from './api.js';
import { escapeHtml, fmtDate, emptyState, toast, onAction, openModal, formValues, confirmDialog, } from './ui.js';
const STATUSES = ['todo', 'in_progress', 'done', 'archived'];
const PRIORITIES = ['low', 'medium', 'high', 'urgent'];
let filterStatus = 'open';
let historyMode = false;
export async function renderTodos(container) {
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
        <button class="btn btn-ghost" data-action="history" title="Weekly history (Mon–Sun)">🗓 History</button>
        <button class="btn btn-ghost" data-action="export" title="Export the list">↓ Export</button>
        <button class="btn btn-primary" data-action="new">+ New</button>
      </div>
    </div>
    <form class="quick-add" data-role="quick">
      <input name="title" placeholder="Add a task and press Enter…" data-role="search" autocomplete="off">
    </form>
    <div data-role="list"></div>`;
    const filterEl = container.querySelector('[data-role="filter"]');
    filterEl.value = filterStatus;
    filterEl.addEventListener('change', () => {
        filterStatus = filterEl.value;
        load(container);
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
        if (action === 'export')
            openExport();
        if (action === 'history') {
            historyMode = !historyMode;
            load(container);
        }
        if (action === 'edit')
            openEditorById(container, id);
        if (action === 'complete')
            complete(container, id);
        if (action === 'delete')
            remove(container, id);
    });
    await load(container);
}
/** Offer the current to-do list as a download in Markdown, CSV, or plain text. */
function openExport() {
    const q = encodeURIComponent(filterStatus);
    const link = (fmt, label, hint) => `<a class="btn" style="justify-content:flex-start" href="../api/export.php?action=todos_${fmt}&status=${q}">
       ⬇ ${label} <span class="muted" style="margin-left:6px">${hint}</span></a>`;
    openModal({
        title: 'Export to-do list',
        cancelLabel: 'Close',
        confirmLabel: 'Close',
        bodyHtml: `
      <p class="text-dim" style="margin:0 0 10px">Exports the <strong>${escapeHtml(filterStatus)}</strong> list.</p>
      <div class="list" style="display:flex;flex-direction:column;gap:8px">
        ${link('md', 'Markdown', '.md — checklist with status')}
        ${link('csv', 'CSV', '.csv — number, title, status, completed')}
        ${link('txt', 'Plain text', '.txt — numbered 1…n')}
      </div>`,
    });
}
let cache = [];
async function load(container) {
    const list = container.querySelector('[data-role="list"]');
    const quick = container.querySelector('[data-role="quick"]');
    const filter = container.querySelector('[data-role="filter"]');
    const histBtn = container.querySelector('[data-action="history"]');
    // History mode swaps the flat list for week buckets and hides the live controls.
    if (quick)
        quick.hidden = historyMode;
    if (filter)
        filter.style.display = historyMode ? 'none' : '';
    if (histBtn)
        histBtn.textContent = historyMode ? '← List' : '🗓 History';
    if (historyMode) {
        await loadHistory(list);
        return;
    }
    const query = filterStatus === 'open' ? {} : { status: filterStatus };
    let items = await apiGet('todos', 'list', query);
    if (filterStatus === 'open')
        items = items.filter((t) => t.status === 'todo' || t.status === 'in_progress');
    cache = items;
    if (!items.length) {
        list.innerHTML = emptyState('✓', 'No tasks here.');
        return;
    }
    list.innerHTML = `<div class="list">${items.map(row).join('')}</div>`;
}
function row(t) {
    const done = t.status === 'done';
    const meta = [];
    if (t.project)
        meta.push('#' + t.project);
    if (t.due_date)
        meta.push(fmtDate(t.due_date));
    if (t.recurring)
        meta.push('↻ ' + t.recurring);
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
/* -------------------------------------------------------- weekly history */
async function loadHistory(list) {
    const res = await apiGet('todos', 'history');
    if (!res.weeks.length) {
        list.innerHTML = emptyState('🗓', 'No history yet.');
        return;
    }
    list.innerHTML = res.weeks.map((w) => weekSection(w, res.current_week_start)).join('');
}
function weekSection(w, current) {
    const isCurrent = w.week_start === current;
    const label = isCurrent ? 'This week' : `${fmtDate(w.week_start)} – ${fmtDate(w.week_end)}`;
    const count = `${w.items.length} task${w.items.length !== 1 ? 's' : ''}`;
    return `<section class="week-bucket">
    <div class="week-head"><h3>${escapeHtml(label)}</h3><span class="muted">${count}</span></div>
    ${w.items.length ? `<div class="list">${w.items.map(histRow).join('')}</div>` : emptyState('·', 'Nothing this week.')}
  </section>`;
}
function histRow(t) {
    const done = t.state === 'done';
    const tag = t.state === 'carried'
        ? '<span class="chip">carried over</span>'
        : t.state === 'open' ? '<span class="chip">open</span>' : '';
    const when = done && t.completed_at ? `<span class="muted"> · completed ${escapeHtml(fmtDate(t.completed_at))}</span>` : '';
    return `<div class="row">
    <span class="check ${done ? 'done' : ''}">${done ? '✓' : ''}</span>
    <span class="grow"><span style="${done ? 'text-decoration:line-through;opacity:.6' : ''}">${escapeHtml(t.title)}</span>${when}</span>
    ${tag}
  </div>`;
}
async function complete(container, id) {
    const t = cache.find((x) => x.id === id);
    try {
        if (t && t.status === 'done') {
            await apiPost('todos', 'update', { id, status: 'todo' });
        }
        else {
            await apiPost('todos', 'complete', { id });
        }
        load(container);
    }
    catch (e) {
        toast(e instanceof Error ? e.message : 'Failed', 'bad');
    }
}
async function remove(container, id) {
    if (!(await confirmDialog('Delete this task?')))
        return;
    try {
        await apiPost('todos', 'delete', { id });
        load(container);
    }
    catch (e) {
        toast(e instanceof Error ? e.message : 'Failed', 'bad');
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
