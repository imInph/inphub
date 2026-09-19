/**
 * inphub: the dashboard search bar's dropdown, Google suggestions (up to 5)
 * followed by matches from the user's own data ("In inphub", up to 5).
 *
 * The bar stays a plain GET form to google.com, so Enter with no row picked
 * still searches exactly what was typed. Arrow keys pick a row; a Google row
 * searches that suggestion, an inphub row deep-links to the item.
 *
 * Listeners go on the input and list themselves: both are rebuilt on every
 * dashboard render, so nothing stacks (the view container itself is only
 * ever wired through onAction()).
 */

import { apiGet } from './api.js';
import { escapeHtml, money } from './ui.js';
import { go } from './app.js';
import {
  RESULT_VIEWS, SEARCH_MIN_CHARS, fetchSuggestions, searchGoogle, suggestionHtml, isAbort,
  type SearchItem, type SearchGroup,
} from './web-search.js';

const GOOGLE_ROWS = 5;
const INPHUB_ROWS = 5;
const DEBOUNCE_MS = 150;

type Entry =
  | { kind: 'web'; query: string }
  | { kind: 'result'; type: string; group: string; item: SearchItem };

/** In-flight requests from the previous render, dropped when the bar is rebuilt. */
let pending: { timer: number; ctl: AbortController | null } = { timer: 0, ctl: null };

/**
 * @param keep the text and focus the previous render's input had, so a
 *   background re-render (inphub:data-changed) never wipes what is being typed.
 */
export function mountDashSearch(container: HTMLElement, keep: { value: string; focused: boolean } | null): void {
  const form = container.querySelector<HTMLFormElement>('.dash-search');
  const input = form?.querySelector<HTMLInputElement>('[data-role="search"]');
  const list = form?.querySelector<HTMLElement>('[data-role="suggest"]');
  if (!form || !input || !list) return;

  clearTimeout(pending.timer);
  pending.ctl?.abort();
  pending = { timer: 0, ctl: null };

  let google: string[] = [];
  let groups: SearchGroup[] = [];
  let entries: Entry[] = [];
  /** -1 = no row picked; Enter then searches the typed text. */
  let active = -1;

  const query = () => input.value.trim();

  const setOpen = (open: boolean) => {
    list.hidden = !open;
    input.setAttribute('aria-expanded', String(open));
    if (!open) {
      active = -1;
      input.removeAttribute('aria-activedescendant');
    }
  };

  const paint = () => {
    list.querySelectorAll<HTMLElement>('[data-i]').forEach((el, i) => el.classList.toggle('active', i === active));
    const row = list.querySelector<HTMLElement>(`[data-i="${active}"]`);
    if (row) {
      input.setAttribute('aria-activedescendant', row.id);
      // Scroll the list only; scrollIntoView() would scroll the page too and
      // slide the bar under the sticky topbar.
      if (row.offsetTop < list.scrollTop) list.scrollTop = row.offsetTop;
      else if (row.offsetTop + row.offsetHeight > list.scrollTop + list.clientHeight) {
        list.scrollTop = row.offsetTop + row.offsetHeight - list.clientHeight;
      }
    } else {
      input.removeAttribute('aria-activedescendant');
    }
  };

  const render = () => {
    const q = query();
    const previous = entries[active];
    entries = [];
    const html: string[] = [];

    if (google.length) {
      html.push('<div class="palette-section">Google</div>');
      for (const s of google.slice(0, GOOGLE_ROWS)) {
        html.push(row(entries.length, `<span class="palette-label"><span>${suggestionHtml(q, s)}</span></span>`));
        entries.push({ kind: 'web', query: s });
      }
    }

    const results = groups.flatMap((g) => g.items.map((item) => ({ type: g.type, group: g.label, item }))).slice(0, INPHUB_ROWS);
    if (results.length) {
      html.push('<div class="palette-section">In inphub</div>');
      for (const r of results) {
        const sub = [r.group, r.item.sub].filter(Boolean).join(' · ');
        const meta = r.item.amount !== undefined
          ? money(r.item.amount, r.item.currency ?? 'TRY') + (r.item.meta ? ' · ' + r.item.meta : '')
          : r.item.meta;
        html.push(row(entries.length,
          `<span class="palette-label">${escapeHtml(r.item.label)}<small>${escapeHtml(sub)}</small></span>`
          + (meta ? `<span class="hint">${escapeHtml(meta)}</span>` : '')));
        entries.push({ kind: 'result', ...r });
      }
    }

    list.innerHTML = html.join('');
    // Keep the picked row picked when the other group lands after it.
    active = previous ? entries.findIndex((e) => sameEntry(e, previous)) : -1;
    setOpen(entries.length > 0 && document.activeElement === input);
    paint();
  };

  const search = (q: string) => {
    const ctl = new AbortController();
    pending.ctl = ctl;
    const current = () => pending.ctl === ctl && query() === q;

    fetchSuggestions(q, ctl.signal)
      .catch((e) => (isAbort(e) ? null : []))
      .then((res) => {
        if (res === null || !current()) return;
        google = res;
        render();
      });

    if (q.length < SEARCH_MIN_CHARS) {
      groups = [];
      return;
    }
    apiGet<{ groups: SearchGroup[] }>('search', 'search', { q, limit: 2 }, { signal: ctl.signal })
      .then((res) => res.groups, (e) => (isAbort(e) ? null : []))
      .then((res) => {
        // A failing search only means no inphub rows, never an error toast.
        if (res === null || !current()) return;
        groups = res;
        render();
      });
  };

  const onInput = () => {
    clearTimeout(pending.timer);
    pending.ctl?.abort();
    pending.ctl = null;
    const q = query();
    if (!q) {
      google = [];
      groups = [];
      entries = [];
      list.innerHTML = '';
      setOpen(false);
      return;
    }
    pending.timer = window.setTimeout(() => search(q), DEBOUNCE_MS);
  };

  const choose = (i: number) => {
    const entry = entries[i];
    if (!entry) return;
    setOpen(false);
    if (entry.kind === 'web') {
      searchGoogle(entry.query);
      return;
    }
    const view = RESULT_VIEWS[entry.type];
    if (view) go(view, { focus: entry.item.id });
  };

  input.addEventListener('input', onInput);
  input.addEventListener('focus', () => {
    if (entries.length && query()) setOpen(true);
  });
  input.addEventListener('blur', () => setOpen(false));
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (!entries.length) return;
      e.preventDefault();
      if (list.hidden) {
        setOpen(true);
        return;
      }
      // Cycles through -1 (the typed text), like a browser's address bar.
      const n = entries.length + 1;
      active = ((active + 1 + (e.key === 'ArrowDown' ? 1 : -1) + n) % n) - 1;
      paint();
    } else if (e.key === 'Enter') {
      if (!list.hidden && active >= 0) {
        e.preventDefault();
        choose(active);
      } else if (!query()) {
        e.preventDefault();
      }
    } else if (e.key === 'Escape') {
      e.preventDefault();
      if (!list.hidden) setOpen(false);
      else input.blur();
    }
  });

  // mousedown would blur the input (closing the list) before click lands.
  list.addEventListener('mousedown', (e) => e.preventDefault());
  list.addEventListener('click', (e) => {
    const el = (e.target as HTMLElement).closest<HTMLElement>('[data-i]');
    if (el) choose(Number(el.dataset.i));
  });

  if (keep?.value) {
    input.value = keep.value;
    if (keep.focused) {
      input.focus();
      input.setSelectionRange(keep.value.length, keep.value.length);
      onInput();
    }
  }
}

function row(i: number, inner: string): string {
  return `<div class="palette-item" role="option" id="dash-suggest-${i}" data-i="${i}">${inner}</div>`;
}

function sameEntry(a: Entry, b: Entry): boolean {
  if (a.kind === 'web' && b.kind === 'web') return a.query === b.query;
  if (a.kind === 'result' && b.kind === 'result') return a.type === b.type && a.item.id === b.item.id;
  return false;
}
