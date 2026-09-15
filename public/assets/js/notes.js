/**
 * inphub: notes: capture, pin, tag, search, markdown-rendered preview.
 */
import { apiGet, apiPost } from './api.js?v=83d0559b02';
import { escapeHtml, timeAgo, markdown, emptyState, toast, onAction, openModal, formValues, confirmDialog, flashFocused, loadingState, toggleMarkdownTask, } from './ui.js?v=83d0559b02';
import { currentParams } from './app.js?v=83d0559b02';
let query = '';
let searchTimer = 0;
export async function renderNotes(container) {
    container.innerHTML = `
    <div class="view-head">
      <div class="toolbar">
        <input type="search" data-role="search" placeholder="Search notes…" style="width:220px" value="${escapeHtml(query)}">
        <button class="btn btn-primary" data-action="new">+ Note</button>
      </div>
    </div>
    <div data-role="list">${loadingState()}</div>`;
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
        if (action === 'read')
            openReader(container, cache.find((n) => n.id === id) ?? null);
        if (action === 'md-task') {
            const card = el.closest('[data-row]');
            void toggleTask(container, card, Number(card?.dataset.row), el);
        }
        if (action === 'tag') {
            // Tag chips were rendered but inert, no way to see "notes tagged dev".
            query = el.dataset.tag ?? '';
            const box = container.querySelector('[data-role="search"]');
            if (box)
                box.value = query;
            load(container);
        }
        if (action === 'delete')
            remove(container, id);
    });
    await load(container);
}
let cache = [];
async function load(container) {
    cache = await apiGet('notes', 'list', query ? { q: query } : {});
    const list = container.querySelector('[data-role="list"]');
    if (cache.length) {
        list.innerHTML = `<div class="grid grid-2">${cache.map(card).join('')}</div>`;
    }
    else {
        list.innerHTML = emptyState('', query ? 'No notes match.' : 'No notes yet.');
    }
    // Arrived from search or history (#notes?focus=7). If our own search filter
    // is hiding that note, widen it and reload, otherwise the jump would look
    // like nothing happened. Only retried when there was a filter to clear, so
    // a focus id that no longer exists fails silently instead of looping.
    const focus = currentParams().get('focus');
    if (focus !== null && !flashFocused(container, focus) && query !== '') {
        query = '';
        const searchEl = container.querySelector('[data-role="search"]');
        if (searchEl)
            searchEl.value = '';
        await load(container);
    }
}
/** Read a note in full, the card clips at 220px and editing was the only way in. */
function openReader(container, n) {
    if (!n)
        return;
    const root = openModal({
        title: n.title || 'Untitled',
        confirmLabel: 'Close',
        cancelLabel: '',
        size: 'lg', // room for embedded players and tables
        bodyHtml: `<div class="md" style="max-height:60vh;overflow:auto">${markdown(n.content, { tasks: true })}</div>
      <div class="text-dim" style="margin-top:10px;font-size:.8rem">
        ${escapeHtml((n.tags ?? '').split(',').map((t) => t.trim()).filter(Boolean).map((t) => '#' + t).join(' '))}
        · updated ${escapeHtml(timeAgo(n.updated_at))}</div>`,
    });
    // The modal is a fresh node per open, so a direct listener cannot stack.
    root.addEventListener('click', (e) => {
        const box = e.target.closest('input[data-action="md-task"]');
        if (box)
            void toggleTask(container, root.querySelector('.md'), n.id, box);
    });
}
/**
 * Tick a task-list checkbox and save the note. The checkbox has already
 * flipped by the time the click lands, so every failure path flips it back.
 */
async function toggleTask(container, scope, id, box) {
    const n = cache.find((x) => x.id === id);
    const rendered = scope ? scope.querySelectorAll('input[data-task-index]').length : 0;
    const next = n ? toggleMarkdownTask(n.content, Number(box.dataset.taskIndex), rendered) : null;
    if (!n || next === null) {
        box.checked = !box.checked;
        toast('Could not find that task in the note, open it with Edit instead.', 'bad');
        return;
    }
    box.disabled = true;
    try {
        await apiPost('notes', 'update', { id, content: next });
        n.content = next;
        // Keep the card in sync when the tick came from the reader (and vice versa).
        const card = container.querySelector(`[data-row="${id}"] .md`);
        if (card && card !== scope)
            card.innerHTML = markdown(next, { embeds: false, tasks: true });
    }
    catch (e) {
        box.checked = !box.checked;
        toast(e instanceof Error ? e.message : 'Could not save the note', 'bad');
    }
    finally {
        box.disabled = false;
    }
}
function card(n) {
    const tags = (n.tags ?? '').split(',').map((t) => t.trim()).filter(Boolean);
    return `<section class="card" data-row="${n.id}">
    <div class="card-head">
      <h3><button class="note-title" data-action="read" data-id="${n.id}" title="Open">${escapeHtml(n.title || 'Untitled')}</button></h3>
      <span class="row-actions" style="opacity:1">
        <button class="btn btn-ghost btn-sm" data-action="pin" data-id="${n.id}" title="Pin">${n.pinned ? '★' : '☆'}</button>
        <button class="btn btn-ghost btn-sm" data-action="edit" data-id="${n.id}">Edit</button>
        <button class="btn btn-ghost btn-sm" data-action="delete" data-id="${n.id}">✕</button>
      </span>
    </div>
    <div class="md" style="max-height:220px;overflow:auto">${markdown(n.content, { embeds: false, tasks: true })}</div>
    <div class="repo-meta" style="margin-top:8px">
      ${tags.map((t) => `<button class="chip" data-action="tag" data-tag="${escapeHtml(t)}">#${escapeHtml(t)}</button>`).join('')}
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
    const n = cache.find((x) => x.id === id);
    if (!(await confirmDialog('Delete this note?')))
        return;
    try {
        await apiPost('notes', 'delete', { id });
        await load(container);
        if (n) {
            toast(`Deleted "${n.title || 'Untitled'}"`, '', {
                label: 'Undo',
                run: async () => {
                    try {
                        await apiPost('notes', 'create', { title: n.title, content: n.content, tags: n.tags, pinned: n.pinned });
                        await load(container);
                        toast('Restored as a new note.', 'good');
                    }
                    catch (e) {
                        toast(e instanceof Error ? e.message : 'Could not restore', 'bad');
                    }
                },
            });
        }
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
