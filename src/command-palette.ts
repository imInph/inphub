/**
 * inphub: command palette (Ctrl/Cmd+K): commands *and* global search.
 *
 * Typing filters the built-in commands locally and, in parallel, searches
 * every entity through api/search.php and asks Google for suggestions
 * (api/suggest.php). Results are grouped under headings (Commands → inphub
 * groups → Google) and share one arrow/Enter selection. The Google group
 * always opens with a "Search Google for …" row, so with no local match,
 * typing and pressing Enter searches the web, even when suggestions fail.
 *
 * The box is built once into the persistent #palette node and its listeners
 * are bound once, open() only unhides and resets. Re-binding on every open
 * (as an earlier version did) stacks handlers on a node that is never
 * replaced; see the onAction() note in CLAUDE.md for the same hazard.
 */

import { go } from './app.js';
import { openChat } from './chat.js';
import { apiGet, apiPost } from './api.js';
import { toast, openModal, formValues, escapeHtml, money } from './ui.js';
import {
  RESULT_VIEWS, SEARCH_MIN_CHARS, fetchSuggestions, searchGoogle, suggestionHtml, isAbort,
  type SearchItem, type SearchGroup,
} from './web-search.js';

declare global {
  interface Window {
    /** Called by the inline onclick in index.php. */
    inphubPalette?: () => void;
  }
}

interface Command {
  label: string;
  hint?: string;
  run: () => void;
}

/** Selectable row, commands and results share one index space. */
type Entry =
  | { kind: 'command'; cmd: Command }
  | { kind: 'result'; type: string; item: SearchItem }
  | { kind: 'web'; query: string };

/** Google suggestions shown under the fixed "Search Google for …" row. */
const WEB_SUGGESTIONS = 4;

const VIEW_COMMANDS: [string, string][] = [
  ['dashboard', 'Dashboard'],
  ['todos', 'To-Do'],
  ['expenses', 'Money'],
  ['repos', 'Repositories'],
  ['habits', 'Habits'],
  ['goals', 'Goals'],
  ['notes', 'Notes'],
  ['focus', 'Focus'],
  ['insights', 'Insights'],
  ['activity', 'History'],
  ['settings', 'Settings'],
];

/** g+letter hints, declared rather than derived from the view id. */
const VIEW_HINTS: Record<string, string> = {
  dashboard: 'g d', todos: 'g t', expenses: 'g e', repos: 'g r', habits: 'g h',
  goals: 'g g', notes: 'g n', focus: 'g f', insights: 'g i', activity: 'g a', settings: 'g s',
};

let palette: HTMLElement | null = null;
let input: HTMLInputElement | null = null;
let listHost: HTMLElement | null = null;

let commands: Command[] = [];
let entries: Entry[] = [];
let active = 0;
let chatEnabled = false;

let groups: SearchGroup[] = [];
let searchedFor = '';
let suggestions: string[] = [];
let searchTimer = 0;
let searchCtl: AbortController | null = null;

/** Update chat availability without re-binding listeners (AI toggled in Settings). */
export function setPaletteChat(chat: boolean): void {
  chatEnabled = chat;
}

export function initPalette(opts: { chat: boolean }): void {
  chatEnabled = opts.chat;
  palette = document.getElementById('palette');
  if (!palette) return;

  palette.innerHTML = `
    <div class="palette-box">
      <input data-role="q" placeholder="Search or type a command" autocomplete="off"
             autocorrect="off" autocapitalize="off" spellcheck="false">
      <div class="palette-list" data-role="list"></div>
    </div>`;
  input = palette.querySelector<HTMLInputElement>('[data-role="q"]');
  listHost = palette.querySelector<HTMLElement>('[data-role="list"]');

  palette.addEventListener('mousedown', (e) => {
    if (e.target === palette) close();
  });
  input?.addEventListener('input', onInput);
  input?.addEventListener('keydown', onKey);
  // One delegated click for the whole list, so re-rendering results costs nothing.
  listHost?.addEventListener('click', (e) => {
    const row = (e.target as HTMLElement).closest<HTMLElement>('[data-i]');
    if (row) choose(Number(row.dataset.i));
  });

  // Exposed for the inline onclick in index.php. Inline DOM level-0 handlers
  // are the established pattern here: in the owner's Firefox, addEventListener
  // bindings on the sidebar/topbar chrome silently never fire (an extension
  // appears to wrap addEventListener). See the note in CLAUDE.md.
  window.inphubPalette = open;
  document.getElementById('btn-palette')?.addEventListener('click', open);

  // Registered twice on purpose: addEventListener for normal browsers, and the
  // DOM level-0 slot as a fallback for the environment above. handleKey()
  // stamps the event so whichever fires second is a no-op.
  document.addEventListener('keydown', handleKey);
  const previous = document.onkeydown;
  document.onkeydown = (e: KeyboardEvent) => {
    handleKey(e);
    previous?.call(document, e);
  };
}

interface StampedEvent extends KeyboardEvent {
  __inphubPaletteSeen?: boolean;
}

function handleKey(e: KeyboardEvent): void {
  const ev = e as StampedEvent;
  if (ev.__inphubPaletteSeen) return;
  ev.__inphubPaletteSeen = true;

  // Ctrl/Cmd+K is the conventional binding, but Firefox reserves it for its
  // search bar and will not let a page have it, so bare 'k' opens the palette
  // too, matching the app's existing bare-letter keys (g+letter, c for chat).
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
    e.preventDefault();
    open();
    return;
  }
  if (e.metaKey || e.ctrlKey || e.altKey || isTyping(e.target)) return;

  if (e.key === 'k') {
    e.preventDefault();
    open();
    return;
  }
  if (chatEnabled && e.key === 'c') {
    e.preventDefault();
    openChat();
  }
}

function buildCommands(): Command[] {
  const list: Command[] = VIEW_COMMANDS.map(([id, label]) => ({
    label: `Go to ${label}`,
    hint: VIEW_HINTS[id],
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
  if (!palette || !input) return;
  commands = buildCommands();
  groups = [];
  searchedFor = '';
  suggestions = [];
  input.value = '';
  palette.hidden = false;
  render('', true);
  input.focus();
}

function close(): void {
  if (palette) palette.hidden = true;
  // Drop anything in flight so a late response can't render into a closed
  // (or freshly reopened) palette.
  clearTimeout(searchTimer);
  searchCtl?.abort();
  searchCtl = null;
}

/* ------------------------------------------------------------------ search */

function onInput(): void {
  const q = input!.value.trim();
  render(q, true);

  clearTimeout(searchTimer);
  searchCtl?.abort();

  if (q.length < SEARCH_MIN_CHARS) {
    groups = [];
    searchedFor = '';
    suggestions = [];
    return;
  }
  searchTimer = window.setTimeout(() => runSearch(q), 200);
}

/** inphub results and Google suggestions, in parallel; each renders on arrival. */
function runSearch(q: string): void {
  const ctl = new AbortController();
  searchCtl = ctl;
  // A newer keystroke may have superseded this request.
  const current = () => ctl === searchCtl && input!.value.trim() === q;

  apiGet<{ groups: SearchGroup[] }>('search', 'search', { q }, { signal: ctl.signal })
    .then((res) => res.groups, (e) => (isAbort(e) ? null : []))
    .then((res) => {
      // Search failing must never break the command palette.
      if (res === null || !current()) return;
      groups = res;
      searchedFor = q;
      render(q, false);
    });

  fetchSuggestions(q, ctl.signal)
    .catch((e) => (isAbort(e) ? null : []))
    .then((res) => {
      if (res === null || !current()) return;
      suggestions = res.filter((s) => s.trim().toLocaleLowerCase() !== q.toLocaleLowerCase()).slice(0, WEB_SUGGESTIONS);
      render(q, false);
    });
}

/* ------------------------------------------------------------------ render */

/**
 * @param resetActive true when the user typed (selection returns to the top),
 *   false when debounced results merge in, moving the highlight out from
 *   under their fingers mid-keystroke is disorienting.
 */
function render(query: string, resetActive: boolean): void {
  if (!listHost) return;
  const q = query.trim();
  // Commands are matched locally; results arrive already ranked by the server
  // and must not be re-filtered (its collation is Turkish-correct, JS
  // toLowerCase is not, and fuzzy() would drop good hits).
  const cmds = q ? commands.filter((c) => fuzzy(c.label.toLowerCase(), q.toLowerCase())) : commands;

  const previous = entries[active];
  entries = [];
  const html: string[] = [];

  if (cmds.length) {
    if (q) html.push(section('Commands'));
    for (const cmd of cmds) {
      html.push(row(entries.length, escapeHtml(cmd.label), '', cmd.hint ? escapeHtml(cmd.hint) : ''));
      entries.push({ kind: 'command', cmd });
    }
  }

  for (const group of groups) {
    if (!group.items.length) continue;
    html.push(section(group.label + (group.truncated ? ' <span class="hint">top ' + group.items.length + '</span>' : '')));
    for (const item of group.items) {
      const meta = item.amount !== undefined
        ? escapeHtml(money(item.amount, item.currency ?? 'TRY')) + ' · ' + escapeHtml(item.meta)
        : escapeHtml(item.meta);
      html.push(row(entries.length, escapeHtml(item.label), escapeHtml(item.sub), meta));
      entries.push({ kind: 'result', type: group.type, item });
    }
  }

  if (q) {
    html.push(section('Google'));
    html.push(row(entries.length, `Search Google for “${escapeHtml(q)}”`, '', ''));
    entries.push({ kind: 'web', query: q });
    for (const s of suggestions) {
      // Wrapped: .palette-label is a column flexbox and would stack the two halves.
      html.push(row(entries.length, `<span>${suggestionHtml(q, s)}</span>`, '', ''));
      entries.push({ kind: 'web', query: s });
    }
  }

  if (!entries.length) {
    const searching = q.length >= SEARCH_MIN_CHARS && searchedFor !== q;
    html.push(`<div class="palette-item text-dim">${searching ? 'Searching…' : 'No matches'}</div>`);
  }

  listHost.innerHTML = html.join('');

  if (resetActive) {
    active = 0;
  } else {
    // Keep the same row selected across a results merge where possible.
    const i = previous ? entries.findIndex((e) => sameEntry(e, previous)) : -1;
    active = i >= 0 ? i : Math.min(active, Math.max(0, entries.length - 1));
  }
  paintActive(false);
}

function section(label: string): string {
  return `<div class="palette-section">${label}</div>`;
}

function row(i: number, label: string, sub: string, meta: string): string {
  return `<div class="palette-item" data-i="${i}">
    <span class="palette-label">${label}${sub ? `<small>${sub}</small>` : ''}</span>
    ${meta ? `<span class="hint">${meta}</span>` : ''}
  </div>`;
}

function sameEntry(a: Entry, b: Entry): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === 'command' && b.kind === 'command') return a.cmd.label === b.cmd.label;
  if (a.kind === 'result' && b.kind === 'result') return a.type === b.type && a.item.id === b.item.id;
  if (a.kind === 'web' && b.kind === 'web') return a.query === b.query;
  return false;
}

function paintActive(scroll: boolean): void {
  if (!listHost) return;
  const rows = listHost.querySelectorAll<HTMLElement>('[data-i]');
  rows.forEach((el, i) => el.classList.toggle('active', i === active));
  // The list scrolls at 320px; without this, arrowing past the fold looks inert.
  if (scroll) rows[active]?.scrollIntoView({ block: 'nearest' });
}

/* -------------------------------------------------------------------- keys */

function onKey(e: KeyboardEvent): void {
  // Enter/arrows that confirm an IME composition belong to the IME.
  if (e.isComposing) return;
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
  if (!entries.length) return;
  active = (active + delta + entries.length) % entries.length;
  paintActive(true);
}

function choose(i: number): void {
  const entry = entries[i];
  if (!entry) return;
  close();
  if (entry.kind === 'command') {
    entry.cmd.run();
    return;
  }
  if (entry.kind === 'web') {
    searchGoogle(entry.query);
    return;
  }
  // Routing through go() keeps view validation in one place, a result can
  // never navigate somewhere that isn't a real view.
  const view = RESULT_VIEWS[entry.type];
  if (view) go(view, { focus: entry.item.id });
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

/* ----------------------------------------------------------------- actions */

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
      `,
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
