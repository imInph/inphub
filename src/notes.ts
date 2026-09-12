/**
 * inphub: notes: capture, pin, tag, search, markdown-rendered preview.
 */

import { apiGet, apiPost } from './api.js';
import {
  escapeHtml, timeAgo, markdown, emptyState, toast, onAction, openModal, formValues, confirmDialog,
  flashFocused,
  loadingState,
} from './ui.js';
import { currentParams } from './app.js';

interface Note {
  id: number; title: string | null; content: string; tags: string | null;
  pinned: number; created_at: string; updated_at: string;
}

let query = '';
let searchTimer = 0;

export async function renderNotes(container: HTMLElement): Promise<void> {
  container.innerHTML = `
    <div class="view-head"><h2>Notes</h2>
      <div class="toolbar">
        <input type="search" data-role="search" placeholder="Search notes…" style="width:220px" value="${escapeHtml(query)}">
        <button class="btn btn-primary" data-action="new">+ Note</button>
      </div>
    </div>
    <div data-role="list">${loadingState()}</div>`;

  const searchEl = container.querySelector<HTMLInputElement>('[data-role="search"]')!;
  searchEl.addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = window.setTimeout(() => {
      query = searchEl.value.trim();
      load(container);
    }, 220);
  });

  onAction(container, (action, el) => {
    const id = Number(el.dataset.id);
    if (action === 'new') openEditor(container, null);
    if (action === 'edit') openEditor(container, cache.find((n) => n.id === id) ?? null);
    if (action === 'pin') pin(container, id);
    if (action === 'read') openReader(cache.find((n) => n.id === id) ?? null);
    if (action === 'tag') {
      // Tag chips were rendered but inert, no way to see "notes tagged dev".
      query = el.dataset.tag ?? '';
      const box = container.querySelector<HTMLInputElement>('[data-role="search"]');
      if (box) box.value = query;
      load(container);
    }
    if (action === 'delete') remove(container, id);
  });

  await load(container);
}

let cache: Note[] = [];

async function load(container: HTMLElement): Promise<void> {
  cache = await apiGet<Note[]>('notes', 'list', query ? { q: query } : {});
  const list = container.querySelector<HTMLElement>('[data-role="list"]')!;
  if (cache.length) {
    list.innerHTML = `<div class="grid grid-2">${cache.map(card).join('')}</div>`;
  } else {
    list.innerHTML = emptyState('', query ? 'No notes match.' : 'No notes yet.');
  }

  // Arrived from search or history (#notes?focus=7). If our own search filter
  // is hiding that note, widen it and reload, otherwise the jump would look
  // like nothing happened. Only retried when there was a filter to clear, so
  // a focus id that no longer exists fails silently instead of looping.
  const focus = currentParams().get('focus');
  if (focus !== null && !flashFocused(container, focus) && query !== '') {
    query = '';
    const searchEl = container.querySelector<HTMLInputElement>('[data-role="search"]');
    if (searchEl) searchEl.value = '';
    await load(container);
  }
}

/** Read a note in full, the card clips at 220px and editing was the only way in. */
function openReader(n: Note | null): void {
  if (!n) return;
  openModal({
    title: n.title || 'Untitled',
    confirmLabel: 'Close',
    cancelLabel: '',
    bodyHtml: `<div class="md" style="max-height:60vh;overflow:auto">${markdown(n.content)}</div>
      <div class="text-dim" style="margin-top:10px;font-size:.8rem">
        ${escapeHtml((n.tags ?? '').split(',').map((t) => t.trim()).filter(Boolean).map((t) => '#' + t).join(' '))}
        · updated ${escapeHtml(timeAgo(n.updated_at))}</div>`,
  });
}

function card(n: Note): string {
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
    <div class="md" style="max-height:220px;overflow:auto">${markdown(n.content)}</div>
    <div class="repo-meta" style="margin-top:8px">
      ${tags.map((t) => `<button class="chip" data-action="tag" data-tag="${escapeHtml(t)}">#${escapeHtml(t)}</button>`).join('')}
      <span class="text-dim">${escapeHtml(timeAgo(n.updated_at))}</span>
    </div>
  </section>`;
}

async function pin(container: HTMLElement, id: number): Promise<void> {
  const n = cache.find((x) => x.id === id);
  try {
    await apiPost('notes', 'pin', { id, pinned: n && n.pinned ? 0 : 1 });
    await load(container);
  } catch (e) {
    toast(e instanceof Error ? e.message : 'Failed', 'bad');
  }
}

async function remove(container: HTMLElement, id: number): Promise<void> {
  const n = cache.find((x) => x.id === id);
  if (!(await confirmDialog('Delete this note?'))) return;
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
          } catch (e) {
            toast(e instanceof Error ? e.message : 'Could not restore', 'bad');
          }
        },
      });
    }
  } catch (e) {
    toast(e instanceof Error ? e.message : 'Failed', 'bad');
  }
}

function openEditor(container: HTMLElement, n: Note | null): void {
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
      const payload: Record<string, unknown> = { ...v };
      if (n) payload.id = n.id;
      try {
        await apiPost('notes', n ? 'update' : 'create', payload);
        await load(container);
      } catch (e) {
        toast(e instanceof Error ? e.message : 'Failed', 'bad');
        return false;
      }
    },
  });
}
