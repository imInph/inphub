/**
 * inphub — command palette (Ctrl/Cmd+K).
 *
 * A lightweight fuzzy launcher: jump to any view, plus a few quick actions
 * (sync repos, toggle theme, open chat, export). No dependencies.
 */

import { go } from './app.js';
import { openChat } from './chat.js';
import { apiPost } from './api.js';
import { toast, openModal, formValues } from './ui.js';

interface Command {
  label: string;
  hint?: string;
  run: () => void;
}

const VIEW_COMMANDS: [string, string][] = [
  ['dashboard', 'Dashboard'],
  ['todos', 'To-Do'],
  ['expenses', 'Money'],
  ['repos', 'Repositories'],
  ['habits', 'Habits'],
  ['goals', 'Goals'],
  ['notes', 'Notes'],
  ['focus', 'Focus'],
  ['activity', 'History'],
  ['settings', 'Settings'],
];

let palette: HTMLElement | null = null;
let commands: Command[] = [];
let filtered: Command[] = [];
let active = 0;
let chatEnabled = false;

/** Update chat availability without re-binding listeners (AI toggled in Settings). */
export function setPaletteChat(chat: boolean): void {
  chatEnabled = chat;
}

export function initPalette(opts: { chat: boolean }): void {
  chatEnabled = opts.chat;
  palette = document.getElementById('palette');
  document.getElementById('btn-palette')?.addEventListener('click', open);

  document.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      open();
    }
    // Bare 'c' opens chat (unless typing) — handled here so it stays with the palette wiring.
    if (chatEnabled && e.key === 'c' && !e.metaKey && !e.ctrlKey && !e.altKey && !isTyping(e.target)) {
      e.preventDefault();
      openChat();
    }
  });
}

function buildCommands(): Command[] {
  const list: Command[] = VIEW_COMMANDS.map(([id, label]) => ({
    label: `Go to ${label}`,
    hint: `g ${id[0]}`,
    run: () => go(id),
  }));
  list.push({ label: 'Quick capture (task / expense / note)', hint: 'add', run: quickCapture });
  list.push({ label: 'Sync repositories from GitHub', hint: 'sync', run: syncRepos });
  list.push({ label: 'Toggle theme', hint: 'theme', run: () => document.getElementById('btn-theme')?.click() });
  list.push({ label: 'Export all data (JSON)', run: () => download('json') });
  list.push({ label: 'Export expenses (CSV)', run: () => download('expenses_csv') });
  if (chatEnabled) list.push({ label: 'Open AI chat', hint: 'c', run: openChat });
  return list;
}

function open(): void {
  if (!palette) return;
  commands = buildCommands();
  palette.hidden = false;
  palette.innerHTML = `
    <div class="palette-box">
      <input data-role="q" placeholder="Type a command…" autocomplete="off">
      <div class="palette-list" data-role="list"></div>
    </div>`;

  palette.addEventListener('mousedown', (e) => {
    if (e.target === palette) close();
  });
  const input = palette.querySelector<HTMLInputElement>('[data-role="q"]')!;
  input.addEventListener('input', () => render(input.value));
  input.addEventListener('keydown', onKey);
  render('');
  input.focus();
}

function close(): void {
  if (palette) palette.hidden = true;
}

function render(query: string): void {
  const q = query.trim().toLowerCase();
  filtered = q ? commands.filter((c) => fuzzy(c.label.toLowerCase(), q)) : commands;
  active = 0;
  const list = palette!.querySelector<HTMLElement>('[data-role="list"]')!;
  list.innerHTML = filtered.length
    ? filtered.map((c, i) => `
        <div class="palette-item ${i === active ? 'active' : ''}" data-i="${i}">
          <span>${escape(c.label)}</span>${c.hint ? `<span class="hint">${escape(c.hint)}</span>` : ''}
        </div>`).join('')
    : '<div class="palette-item">No matches</div>';

  list.querySelectorAll<HTMLElement>('[data-i]').forEach((el) => {
    el.addEventListener('click', () => choose(Number(el.dataset.i)));
  });
}

function onKey(e: KeyboardEvent): void {
  if (e.key === 'Escape') {
    close();
  } else if (e.key === 'ArrowDown') {
    e.preventDefault();
    move(1);
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    move(-1);
  } else if (e.key === 'Enter') {
    e.preventDefault();
    choose(active);
  }
}

function move(delta: number): void {
  if (!filtered.length) return;
  active = (active + delta + filtered.length) % filtered.length;
  const list = palette!.querySelector<HTMLElement>('[data-role="list"]')!;
  list.querySelectorAll<HTMLElement>('.palette-item').forEach((el, i) => {
    el.classList.toggle('active', i === active);
  });
}

function choose(i: number): void {
  const cmd = filtered[i];
  close();
  cmd?.run();
}

/** Subsequence fuzzy match: every char of q appears in order in text. */
function fuzzy(text: string, q: string): boolean {
  let i = 0;
  for (const ch of text) {
    if (ch === q[i]) i++;
    if (i === q.length) return true;
  }
  return q.length === 0;
}

function escape(s: string): string {
  const d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}

async function syncRepos(): Promise<void> {
  toast('Syncing repositories…');
  try {
    const res = await apiPost<{ synced: number }>('sync_repos', 'sync', {});
    toast(`Synced ${res.synced} repos.`, 'good');
    window.dispatchEvent(new CustomEvent('inphub:data-changed'));
  } catch (e) {
    toast(e instanceof Error ? e.message : 'Sync failed', 'bad');
  }
}

function download(action: string): void {
  window.location.href = `../api/export.php?action=${action}`;
}

/**
 * Free-text capture routed by api/ai.php: with AI on the model classifies it,
 * otherwise prefix parsing handles "todo:", "note:", "spent 12 on lunch", etc.
 */
function quickCapture(): void {
  openModal({
    title: 'Quick capture',
    confirmLabel: 'Add',
    bodyHtml: `
      <label><span>What happened?</span>
        <input name="text" placeholder="e.g. spent 45 on groceries · todo: call the bank" autocomplete="off"></label>
      <p class="text-dim" style="font-size:.82rem;margin-top:8px">Routed to the right place automatically.</p>`,
    onConfirm: async (root) => {
      const text = formValues(root).text.trim();
      if (!text) return false;
      try {
        const res = await apiPost<{ kind: string; summary: string }>('ai', 'quick_add', { text });
        toast(res.summary || 'Captured.', 'good');
        window.dispatchEvent(new CustomEvent('inphub:data-changed'));
      } catch (e) {
        toast(e instanceof Error ? e.message : 'Failed', 'bad');
        return false;
      }
    },
  });
}

function isTyping(el: EventTarget | null): boolean {
  const node = el as HTMLElement | null;
  return !!node && (node.tagName === 'INPUT' || node.tagName === 'TEXTAREA' || node.tagName === 'SELECT' || node.isContentEditable);
}
