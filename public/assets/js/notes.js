/**
 * inphub — notes: capture, pin, tag, search, markdown-rendered preview.
 */
import { apiGet, apiPost } from './api.js';
import { escapeHtml, timeAgo, markdown, emptyState, toast, onAction, openModal, formValues, confirmDialog, } from './ui.js';
let query = '';
let searchTimer = 0;
export async function renderNotes(container) {
    container.innerHTML = `
    <div class="view-head"><h2>Notes</h2>
      <div class="toolbar">
        <input type="search" data-role="search" placeholder="Search notes…" style="width:220px" value="${escapeHtml(query)}">
        <button class="btn btn-primary" data-action="new">+ Note</button>
      </div>
    </div>
    <div data-role="list"><div class="empty">Loading…</div></div>`;
    const searchEl = container.querySelector('[data-role="search"]');
    searchEl.addEventListener('input', () => {
        clearTimeout(searchTimer);
        searchTimer = window.setTimeout(() => {
            query = searchEl.value.trim();
            load(container);
        }, 220);
    });
    onAction(container, (action, el) => {
        const id = Number(el.dataset.id);
        if (action === 'new')
            openEditor(container, null);
        if (action === 'edit')
            openEditor(container, cache.find((n) => n.id === id) ?? null);
        if (action === 'pin')
            pin(container, id);
        if (action === 'delete')
            remove(container, id);
    });
    await load(container);
}
let cache = [];
async function load(container) {
    cache = await apiGet('notes', 'list', query ? { q: query } : {});
    const list = container.querySelector('[data-role="list"]');
    if (!cache.length) {
        list.innerHTML = emptyState('✎', query ? 'No notes match.' : 'No notes yet — jot something down.');
        return;
    }
    list.innerHTML = `<div class="grid grid-2">${cache.map(card).join('')}</div>`;
}
function card(n) {
    const tags = (n.tags ?? '').split(',').map((t) => t.trim()).filter(Boolean);
    return `<section class="card">
    <div class="card-head">
      <h3>${n.pinned ? '📌 ' : ''}${escapeHtml(n.title || 'Untitled')}</h3>
      <span class="row-actions" style="opacity:1">
        <button class="btn btn-ghost btn-sm" data-action="pin" data-id="${n.id}" title="Pin">${n.pinned ? '★' : '☆'}</button>
        <button class="btn btn-ghost btn-sm" data-action="edit" data-id="${n.id}">Edit</button>
        <button class="btn btn-ghost btn-sm" data-action="delete" data-id="${n.id}">✕</button>
      </span>
    </div>
    <div class="md" style="max-height:220px;overflow:auto">${markdown(n.content)}</div>
    <div class="repo-meta" style="margin-top:8px">
      ${tags.map((t) => `<span class="chip">#${escapeHtml(t)}</span>`).join('')}
      <span class="text-dim">${escapeHtml(timeAgo(n.updated_at))}</span>
    </div>
  </section>`;
}
async function pin(container, id) {
    const n = cache.find((x) => x.id === id);
    try {
        await apiPost('notes', 'pin', { id, pinned: n && n.pinned ? 0 : 1 });
        await load(container);
    }
    catch (e) {
        toast(e instanceof Error ? e.message : 'Failed', 'bad');
    }
}
async function remove(container, id) {
    if (!(await confirmDialog('Delete this note?')))
        return;
    try {
        await apiPost('notes', 'delete', { id });
        await load(container);
    }
    catch (e) {
        toast(e instanceof Error ? e.message : 'Failed', 'bad');
    }
}
function openEditor(container, n) {
    openModal({
        title: n ? 'Edit note' : 'New note',
        confirmLabel: n ? 'Save' : 'Create',
        bodyHtml: `
      <label><span>Title</span><input name="title" value="${escapeHtml(n?.title ?? '')}"></label>
      <label><span>Content (markdown)</span><textarea name="content" style="min-height:160px">${escapeHtml(n?.content ?? '')}</textarea></label>
      <div class="field-row">
        <label style="flex:2"><span>Tags (comma-sep)</span><input name="tags" value="${escapeHtml(n?.tags ?? '')}"></label>
        <label class="checkbox" style="align-self:flex-end"><input type="checkbox" name="pinned" ${n?.pinned ? 'checked' : ''}><span>Pinned</span></label>
      </div>`,
        onConfirm: async (root) => {
            const v = formValues(root);
            if (!v.content.trim()) {
                toast('Content is required.', 'bad');
                return false;
            }
            const payload = { ...v };
            if (n)
                payload.id = n.id;
            try {
                await apiPost('notes', n ? 'update' : 'create', payload);
                await load(container);
            }
            catch (e) {
                toast(e instanceof Error ? e.message : 'Failed', 'bad');
                return false;
            }
        },
    });
}
