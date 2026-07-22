/**
 * inphub — goals: progress bars with +/- nudges, status, target dates.
 */
import { apiGet, apiPost } from './api.js';
import { escapeHtml, fmtDate, emptyState, toast, onAction, openModal, formValues, confirmDialog, } from './ui.js';
import { opts } from './todos.js';
const STATUSES = ['active', 'completed', 'paused'];
export async function renderGoals(container) {
    container.innerHTML = `
    <div class="view-head"><h2>Goals</h2>
      <div class="toolbar"><button class="btn btn-primary" data-action="new">+ Goal</button></div>
    </div>
    <div data-role="list"><div class="empty">Loading…</div></div>`;
    onAction(container, (action, el) => {
        const id = Number(el.dataset.id);
        const delta = Number(el.dataset.delta || 0);
        if (action === 'new')
            openEditor(container, null);
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
        list.innerHTML = emptyState('◇', 'No goals yet — set something to aim at.');
        return;
    }
    list.innerHTML = `<div class="grid grid-2">${cache.map(card).join('')}</div>`;
}
function card(g) {
    const pct = g.target_value ? Math.min(100, Math.round((g.current_value / g.target_value) * 100)) : 0;
    const badge = g.status === 'completed' ? 'badge-good' : g.status === 'paused' ? 'badge-warn' : '';
    return `<section class="card">
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
      ${g.target_date ? `<span class="text-dim">by ${escapeHtml(fmtDate(g.target_date))}</span>` : ''}
    </div>
    <div class="row" style="border:none;padding:2px 0;background:none">
      <span class="grow mono tabular">${g.current_value}${g.target_value ? ' / ' + g.target_value : ''} ${escapeHtml(g.unit ?? '')}</span>
      <span class="row-actions" style="opacity:1">
        <button class="btn btn-sm" data-action="nudge" data-id="${g.id}" data-delta="-1">−</button>
        <button class="btn btn-sm" data-action="nudge" data-id="${g.id}" data-delta="1">+</button>
      </span>
    </div>
    ${g.target_value ? `<div class="progress"><span style="width:${pct}%"></span></div>` : ''}
  </section>`;
}
async function nudge(container, id, delta) {
    try {
        await apiPost('goals', 'nudge', { id, delta });
        await load(container);
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
