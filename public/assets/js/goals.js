/**
 * inphub: goals: progress bars with +/- nudges, status, target dates.
 */
import { apiGet, apiPost } from './api.js?v=c10f314afe';
import { escapeHtml, fmtDate, emptyState, toast, onAction, openModal, formValues, confirmDialog, flashFocused, confetti, todayStr, loadingState, } from './ui.js?v=c10f314afe';
import { currentParams } from './app.js?v=c10f314afe';
import { opts } from './todos.js?v=c10f314afe';
const STATUSES = ['active', 'completed', 'paused'];
/** Hide finished goals, the server sorts completed above paused, so without
 *  this they pile up at the top of the grid forever. */
let hideCompleted = false;
export async function renderGoals(container) {
    container.innerHTML = `
    <div class="view-head">
      <div class="toolbar">
        <label class="checkbox" style="margin:0"><input type="checkbox" data-role="hide-done">
          <span>Hide completed</span></label>
        <button class="btn btn-primary" data-action="new">+ Goal</button>
      </div>
    </div>
    <div data-role="list">${loadingState()}</div>`;
    const hideEl = container.querySelector('[data-role="hide-done"]');
    hideEl.checked = hideCompleted;
    hideEl.addEventListener('change', () => {
        hideCompleted = hideEl.checked;
        load(container);
    });
    onAction(container, (action, el) => {
        const id = Number(el.dataset.id);
        const delta = Number(el.dataset.delta || 0);
        if (action === 'new')
            openEditor(container, null);
        if (action === 'step')
            stepBy(container, id);
        if (action === 'status')
            setStatus(container, id, el.dataset.status ?? 'active');
        if (action === 'edit')
            openEditor(container, cache.find((g) => g.id === id) ?? null);
        if (action === 'nudge')
            nudge(container, id, delta);
        if (action === 'delete')
            remove(container, id);
    });
    await load(container);
}
let cache = [];
async function load(container) {
    cache = await apiGet('goals', 'list');
    const list = container.querySelector('[data-role="list"]');
    if (!cache.length) {
        list.innerHTML = emptyState('', 'No goals yet.');
        return;
    }
    const shown = hideCompleted ? cache.filter((g) => g.status !== 'completed') : cache;
    list.innerHTML = shown.length
        ? `<div class="grid grid-2">${shown.map(card).join('')}</div>`
        : emptyState('', 'No goals to show.');
    flashFocused(container, currentParams().get('focus'));
}
function card(g) {
    const pct = g.target_value ? Math.min(100, Math.round((g.current_value / g.target_value) * 100)) : 0;
    const over = g.target_value !== null && g.current_value > g.target_value;
    const badge = g.status === 'completed' ? 'badge-good' : g.status === 'paused' ? 'badge-warn' : '';
    const due = deadline(g);
    return `<section class="card" data-row="${g.id}">
    <div class="card-head">
      <h3>${escapeHtml(g.title)}</h3>
      <span class="row-actions" style="opacity:1">
        <button class="btn btn-ghost btn-sm" data-action="edit" data-id="${g.id}">Edit</button>
        <button class="btn btn-ghost btn-sm" data-action="delete" data-id="${g.id}">✕</button>
      </span>
    </div>
    ${g.description ? `<div class="text-dim">${escapeHtml(g.description)}</div>` : ''}
    <div class="repo-meta" style="margin:6px 0">
      ${g.category ? `<span class="chip">${escapeHtml(g.category)}</span>` : ''}
      ${badge ? `<span class="badge ${badge}">${escapeHtml(g.status)}</span>` : ''}
      ${due ? `<span class="${due.cls}">${escapeHtml(due.text)}</span>` : ''}
    </div>
    <div class="row" style="border:none;padding:2px 0;background:none">
      <span class="grow mono tabular">${g.current_value}${g.target_value ? ' / ' + g.target_value : ''} ${escapeHtml(g.unit ?? '')}</span>
      <span class="row-actions" style="opacity:1">
        <button class="btn btn-sm" data-action="nudge" data-id="${g.id}" data-delta="-1">−</button>
        <button class="btn btn-sm" data-action="nudge" data-id="${g.id}" data-delta="1">+</button>
        <button class="btn btn-sm" data-action="step" data-id="${g.id}" title="Add any amount">+ n</button>
      </span>
    </div>
    ${g.target_value ? `<div class="progress ${over ? 'over' : ''}"><span style="width:${pct}%"></span></div>` : ''}
    <div class="row-actions" style="opacity:1;margin-top:8px">
      ${g.status !== 'active' ? `<button class="btn btn-ghost btn-sm" data-action="status" data-id="${g.id}" data-status="active">Resume</button>` : ''}
      ${g.status === 'active' ? `<button class="btn btn-ghost btn-sm" data-action="status" data-id="${g.id}" data-status="paused">Pause</button>` : ''}
      ${g.status !== 'completed' ? `<button class="btn btn-ghost btn-sm" data-action="status" data-id="${g.id}" data-status="completed">Mark done</button>` : ''}
    </div>
  </section>`;
}
/** Deadline text with urgency, an overdue goal used to look like any other. */
function deadline(g) {
    if (!g.target_date)
        return null;
    if (g.status === 'completed')
        return { text: 'by ' + fmtDate(g.target_date), cls: 'text-dim' };
    const days = Math.round((new Date(g.target_date + 'T00:00:00').getTime() - new Date(todayStr() + 'T00:00:00').getTime()) / 86400000);
    if (days < 0)
        return { text: `${-days}d overdue`, cls: 'text-bad' };
    if (days === 0)
        return { text: 'due today', cls: 'text-bad' };
    if (days <= 7)
        return { text: `${days}d left`, cls: 'text-warn' };
    return { text: 'by ' + fmtDate(g.target_date), cls: 'text-dim' };
}
/** Any-size step. ±1 alone meant "ran 5km" was five clicks and five requests. */
function stepBy(container, id) {
    const g = cache.find((x) => x.id === id);
    if (!g)
        return;
    openModal({
        title: `Add to ${g.title}`,
        confirmLabel: 'Apply',
        bodyHtml: `<label><span>Amount to add (negative to subtract)</span>
      <input name="delta" type="number" step="1" value="1"></label>`,
        onConfirm: async (root) => {
            const delta = Number(formValues(root).delta);
            if (!Number.isFinite(delta) || delta === 0)
                return false;
            await nudge(container, id, delta);
        },
    });
}
async function setStatus(container, id, status) {
    try {
        await apiPost('goals', 'update', { id, status });
        await load(container);
    }
    catch (e) {
        toast(e instanceof Error ? e.message : 'Failed', 'bad');
    }
}
async function nudge(container, id, delta) {
    const before = cache.find((g) => g.id === id)?.status;
    try {
        // The API flips status to 'completed' on reaching the target and returns it;
        // the client used to throw that away, so hitting a goal was silent.
        const res = await apiPost('goals', 'nudge', { id, delta });
        await load(container);
        if (res.status === 'completed' && before !== 'completed') {
            confetti();
            toast('Goal reached.', 'good');
        }
    }
    catch (e) {
        toast(e instanceof Error ? e.message : 'Failed', 'bad');
    }
}
async function remove(container, id) {
    if (!(await confirmDialog('Delete this goal?')))
        return;
    try {
        await apiPost('goals', 'delete', { id });
        await load(container);
    }
    catch (e) {
        toast(e instanceof Error ? e.message : 'Failed', 'bad');
    }
}
function openEditor(container, g) {
    openModal({
        title: g ? 'Edit goal' : 'New goal',
        confirmLabel: g ? 'Save' : 'Create',
        bodyHtml: `
      <label><span>Title</span><input name="title" value="${escapeHtml(g?.title ?? '')}" required></label>
      <label><span>Description</span><textarea name="description">${escapeHtml(g?.description ?? '')}</textarea></label>
      <div class="field-row">
        <label><span>Category</span><input name="category" value="${escapeHtml(g?.category ?? '')}"></label>
        <label><span>Status</span><select name="status">${opts(STATUSES, g?.status ?? 'active')}</select></label>
      </div>
      <div class="field-row">
        <label><span>Current</span><input name="current_value" type="number" value="${escapeHtml(String(g?.current_value ?? 0))}"></label>
        <label><span>Target</span><input name="target_value" type="number" value="${escapeHtml(g?.target_value != null ? String(g.target_value) : '')}"></label>
        <label><span>Unit</span><input name="unit" value="${escapeHtml(g?.unit ?? '')}"></label>
      </div>
      <label><span>Target date</span><input name="target_date" type="date" value="${escapeHtml(g?.target_date ?? '')}"></label>`,
        onConfirm: async (root) => {
            const v = formValues(root);
            if (!v.title.trim()) {
                toast('Title is required.', 'bad');
                return false;
            }
            const payload = { ...v };
            if (!v.target_value)
                payload.target_value = null;
            if (g)
                payload.id = g.id;
            try {
                await apiPost('goals', g ? 'update' : 'create', payload);
                await load(container);
            }
            catch (e) {
                toast(e instanceof Error ? e.message : 'Failed', 'bad');
                return false;
            }
        },
    });
}
