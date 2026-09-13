/**
 * inphub: SPA shell.
 *
 * Owns hash routing, lazy per-view rendering, the theme toggle, the live clock
 * and greeting, and the global keyboard shortcuts. Each view module exposes a
 * `render(container)` entry point; we import them all up front (small app, no
 * bundler) and mount the active one into its <section id="view-<id>">.
 */

import { apiGet, apiPost } from './api.js';
import { toast, openModal, escapeHtml } from './ui.js';
import { initChat } from './chat.js';
import { initPalette, setPaletteChat } from './command-palette.js';

import { renderDashboard } from './dashboard.js';
import { renderTodos } from './todos.js';
import { renderExpenses } from './expenses.js';
import { renderRepos } from './repos.js';
import { renderHabits } from './habits.js';
import { renderGoals } from './goals.js';
import { renderNotes } from './notes.js';
import { renderFocus } from './focus.js';
import { renderInsights } from './insights.js';
import { renderActivity } from './activity.js';
import { renderSettings } from './settings.js';

/** The bootstrap payload injected by index.php. */
export interface BootData {
  user: { id: number; username: string; display_name: string | null; role: string };
  theme: string;
}

declare global {
  interface Window {
    INPHUB: BootData;
    /** Called by inline onclick in index.php (see init for why). */
    inphubToggleTheme?: () => void;
    /** Called by inline onclick in index.php; no arg = toggle. */
    inphubDrawer?: (open?: boolean) => void;
    /** Set once the shell boots; index.php's error guard checks it. */
    __inphubLoaded?: boolean;
  }
}

export const boot: BootData = window.INPHUB;

type ViewRenderer = (container: HTMLElement) => void | Promise<void>;

const VIEWS: Record<string, ViewRenderer> = {
  dashboard: renderDashboard,
  todos: renderTodos,
  expenses: renderExpenses,
  repos: renderRepos,
  habits: renderHabits,
  goals: renderGoals,
  notes: renderNotes,
  focus: renderFocus,
  insights: renderInsights,
  activity: renderActivity,
  settings: renderSettings,
};

const DEFAULT_VIEW = 'dashboard';
let currentView = '';
/** The route key ("view?a=1") we last rendered, so params changes re-render. */
let currentRoute = '';
let routeParams = new URLSearchParams();

/* ------------------------------------------------------------------ routing */

interface Route {
  view: string;
  params: URLSearchParams;
}

/** Parse "#view?key=value", an unknown view falls back to the default. */
function parseRoute(hash: string = location.hash): Route {
  const raw = hash.replace(/^#/, '');
  const cut = raw.indexOf('?');
  const id = cut === -1 ? raw : raw.slice(0, cut);
  return {
    view: VIEWS[id] ? id : DEFAULT_VIEW,
    params: new URLSearchParams(cut === -1 ? '' : raw.slice(cut + 1)),
  };
}

/** Canonical string for a route, used to decide whether to re-render. */
function routeKey(route: Route): string {
  const qs = route.params.toString();
  return route.view + (qs ? '?' + qs : '');
}

/**
 * Query params of the active route, e.g. ?focus=7 from a search result.
 * Views read this during render.
 */
export function currentParams(): URLSearchParams {
  return routeParams;
}

/**
 * Params are read, never consumed.
 *
 * A view can be re-rendered without a route change, the AI-status check at
 * boot does it, and so does every `inphub:data-changed`, and the re-render
 * replaces the DOM, taking any highlight with it. Keeping `focus` in the route
 * lets the view re-apply it, and `activate()` drops it the moment the user
 * navigates anywhere else. flashRow() only scrolls when the row is off-screen,
 * so re-applying it is invisible.
 */

/** Monotonic render token, a superseded render must not paint over a newer one. */
let renderToken = 0;

async function activate(route: Route): Promise<void> {
  const token = ++renderToken;
  const view = route.view;
  cursor = -1;   // the row cursor belongs to whichever view is on screen
  currentView = view;
  routeParams = route.params;
  currentRoute = routeKey(route);

  document.querySelectorAll<HTMLElement>('.nav-item').forEach((el) => {
    const active = el.dataset.view === view;
    el.classList.toggle('active', active);
    if (active) el.setAttribute('aria-current', 'page');
    else el.removeAttribute('aria-current');
  });
  document.querySelectorAll<HTMLElement>('.view').forEach((section) => {
    section.hidden = section.id !== `view-${view}`;
  });

  const container = document.getElementById(`view-${view}`);
  if (!container) return;
  try {
    await VIEWS[view](container);
  } catch (err) {
    // Two fast navigations (Enter-Enter on search results) race here; without
    // the token the loser's error block paints over the winner's good content.
    if (token !== renderToken) return;
    // A dead end with no way out before, the message went to a 4s toast and
    // the view was left blank.
    container.innerHTML = `<div class="empty"><div class="big">⚠️</div>
      <div>Could not load this view.</div>
      <div class="text-dim" style="margin-top:6px;font-size:.85rem">${escapeHtml(err instanceof Error ? err.message : 'Unknown error')}</div>
      <button class="btn btn-primary btn-sm" style="margin-top:12px" data-action="retry-view">Retry</button></div>`;
    container.querySelector('[data-action="retry-view"]')?.addEventListener('click', () => {
      void activate(route);
    });
    toast(err instanceof Error ? err.message : 'Load failed.', 'bad');
  }
}

function onRoute(): void {
  const route = parseRoute();
  // Compare the whole route, not just the view: #notes?focus=7 → #notes?focus=9
  // is a real navigation and must re-render.
  if (routeKey(route) !== currentRoute) activate(route);
}

/** Navigate programmatically (used by palette, search results + shortcuts). */
export function go(view: string, params?: Record<string, string | number>): void {
  if (!VIEWS[view]) return;
  const qs = params
    ? new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)])).toString()
    : '';
  location.hash = view + (qs ? '?' + qs : '');
}

/** Whether the AI layer is configured, set once at boot. */
export let aiAvailable = false;

/** Re-render the current view (used after an AI-initiated write). */
export function refreshCurrentView(): void {
  const container = document.getElementById(`view-${currentView}`);
  if (!container || !VIEWS[currentView]) return;
  // Guarded like activate(): this runs on every inphub:data-changed event, and
  // an unhandled rejection here used to leave a half-rendered view in silence.
  void Promise.resolve(VIEWS[currentView](container)).catch((err: unknown) => {
    toast(err instanceof Error ? err.message : 'Could not refresh this view.', 'bad');
  });
}

/* -------------------------------------------------------------------- theme */

const THEME_KEY = 'inphub.theme';

function applyTheme(theme: string): void {
  document.documentElement.setAttribute('data-theme', theme);
}

async function toggleTheme(): Promise<void> {
  const next = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
  applyTheme(next);
  // Instant local cache so the choice survives a reload even if the save fails.
  try {
    localStorage.setItem(THEME_KEY, next);
  } catch {
    /* storage unavailable, settings save below still covers it */
  }
  try {
    await apiPost('settings', 'save', { settings: { theme: next } });
  } catch {
    toast('Theme saved locally, but syncing to your account failed.', 'bad');
  }
}

/* ---------------------------------------------------------- clock + greeting */

function tick(): void {
  const clock = document.getElementById('clock');
  if (clock) {
    clock.textContent = new Date().toLocaleTimeString(undefined, {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  }
}

function greet(): void {
  const el = document.getElementById('greeting');
  if (!el) return;
  const h = new Date().getHours();
  const part = h < 5 ? 'Late night' : h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
  const name = boot.user.display_name || boot.user.username;
  el.innerHTML = `${part}, ${escapeName(name)}`;
}

function escapeName(name: string): string {
  const div = document.createElement('div');
  div.textContent = name;
  return div.innerHTML;
}

/* ----------------------------------------------------------------- shortcuts */

/**
 * Global keys:
 *   g then d/t/e/r/h/g/n/f/i/a/s → jump to a view
 *   /                          → focus the current view's search box (if any)
 *   c                          → open chat (when AI is enabled)
 *   ?                          → shortcut help toast
 * k / Ctrl+Cmd+K are handled by the command palette module.
 */
let awaitingG = false;
let gTimer = 0;

const G_MAP: Record<string, string> = {
  d: 'dashboard',
  t: 'todos',
  e: 'expenses',
  r: 'repos',
  h: 'habits',
  g: 'goals',
  n: 'notes',
  f: 'focus',
  i: 'insights',
  a: 'activity',
  s: 'settings',
};

function isTyping(el: EventTarget | null): boolean {
  const node = el as HTMLElement | null;
  return !!node && (node.tagName === 'INPUT' || node.tagName === 'TEXTAREA' || node.tagName === 'SELECT' || node.isContentEditable);
}

function onKey(e: KeyboardEvent): void {
  if (isTyping(e.target)) return;
  if (e.metaKey || e.ctrlKey || e.altKey) return;

  if (awaitingG) {
    awaitingG = false;
    clearTimeout(gTimer);
    const dest = G_MAP[e.key.toLowerCase()];
    if (dest) {
      e.preventDefault();
      go(dest);
    }
    return;
  }

  if (e.key === 'g') {
    awaitingG = true;
    gTimer = window.setTimeout(() => (awaitingG = false), 900);
    return;
  }
  if (e.key === '/') {
    const search = document.querySelector<HTMLInputElement>(`#view-${currentView} input[type="search"], #view-${currentView} input[data-role="search"]`);
    if (search) {
      e.preventDefault();
      search.focus();
    }
    return;
  }
  if (e.key === '?') {
    e.preventDefault();
    showShortcuts();
    return;
  }
  if (e.key === 'n') {
    // "New" in whatever view you're looking at.
    const btn = document.querySelector<HTMLElement>(`#view-${currentView} [data-action="new"]`);
    if (btn) {
      e.preventDefault();
      btn.click();
    }
    return;
  }
  if (e.key === 'Escape') {
    // Neither the drawer nor the chat panel responded to Escape before.
    const chat = document.getElementById('chat-panel');
    if (chat && !chat.hidden) {
      chat.hidden = true;
      return;
    }
    window.inphubDrawer?.(false);
    return;
  }
  if (e.key === 'j' || e.key === 'k' || e.key === 'x') {
    rowKeys(e);
  }
}

/* ------------------------------------------------------- row navigation */

/** Index of the row cursor within the active view, -1 when nothing is picked. */
let cursor = -1;

function rowsInView(): HTMLElement[] {
  const host = document.getElementById(`view-${currentView}`);
  return host ? [...host.querySelectorAll<HTMLElement>('[data-row]')] : [];
}

/**
 * j/k move a cursor through the current view's rows and x acts on the focused
 * one. Rows already carry data-row for search highlighting, so this rides on
 * the same markup.
 */
function rowKeys(e: KeyboardEvent): void {
  const rows = rowsInView();
  if (!rows.length) return;
  e.preventDefault();

  if (e.key === 'x') {
    const row = rows[cursor];
    // Prefer a completion control, fall back to whatever primary action exists.
    const hit = row?.querySelector<HTMLElement>('[data-action="complete"], [data-action="toggle"], [data-action="read"]');
    hit?.click();
    return;
  }

  cursor = e.key === 'j'
    ? Math.min(rows.length - 1, cursor + 1)
    : Math.max(0, cursor === -1 ? 0 : cursor - 1);

  rows.forEach((r, i) => r.classList.toggle('row-cursor', i === cursor));
  rows[cursor]?.scrollIntoView({ block: 'nearest' });
}

/** The `?` sheet, this used to be a 2.6s toast that omitted half the keys. */
function showShortcuts(): void {
  const keys: [string, string][] = [
    ['k', 'Search everything'],
    ['g then d t e r h g n f a s', 'Jump to a view'],
    ['/', 'Filter the current view'],
    ['n', 'New item in the current view'],
    ['j / k', 'Move down / up the list'],
    ['x', 'Complete or open the highlighted row'],
    ['c', 'Open AI chat (when enabled)'],
    ['Esc', 'Close a panel, drawer or dialog'],
    ['?', 'This list'],
  ];
  openModal({
    title: 'Keyboard shortcuts',
    confirmLabel: 'Close',
    cancelLabel: '',
    bodyHtml: `<div class="list">${keys.map(([k, what]) => `
      <div class="row" style="border:none;background:none;padding:5px 0">
        <span class="chip mono">${escapeHtml(k)}</span>
        <span class="grow">${escapeHtml(what)}</span>
      </div>`).join('')}</div>`,
  });
}

/* -------------------------------------------------------------------- init */

function init(): void {
  // localStorage holds the user's latest choice (set only on toggle), it wins
  // over the server value in case a previous settings save failed.
  let cached: string | null = null;
  try {
    cached = localStorage.getItem(THEME_KEY);
  } catch {
    /* storage unavailable */
  }
  applyTheme(cached === 'light' || cached === 'dark' ? cached : (boot.theme || 'dark'));
  greet();
  tick();
  setInterval(tick, 1000);

  // Mobile nav drawer (hamburger is only visible at the small breakpoint).
  const sidebar = document.querySelector<HTMLElement>('.sidebar');
  const navBackdrop = document.getElementById('nav-backdrop');
  const setDrawer = (open: boolean) => {
    sidebar?.classList.toggle('open', open);
    if (navBackdrop) navBackdrop.hidden = !open;
    // Without the lock the page scrolls under the overlay.
    document.body.classList.toggle('drawer-open', open);
    document.getElementById('btn-nav')?.setAttribute('aria-expanded', open ? 'true' : 'false');
  };

  // The theme button, hamburger, and drawer backdrop are wired through inline
  // onclick attributes in index.php that call these globals. This is DOM
  // level-0 on purpose: in the owner's environment BOTH direct addEventListener
  // bindings and a document-level delegated listener silently never fired for
  // these buttons (likely an extension wrapping addEventListener), while inline
  // handlers cannot be intercepted that way. Keep it this way.
  window.inphubToggleTheme = () => {
    void toggleTheme();
  };
  window.inphubDrawer = (open?: boolean) => {
    setDrawer(open !== undefined ? open : !sidebar?.classList.contains('open'));
  };

  // Navigating or using a footer action closes the drawer.
  document.addEventListener('click', (e) => {
    const t = e.target as HTMLElement;
    if (t.closest('.sidebar .nav-item, .sidebar .sidebar-foot .btn')) setDrawer(false);
  });

  window.addEventListener('hashchange', onRoute);
  document.addEventListener('keydown', onKey);
  window.addEventListener('inphub:data-changed', refreshCurrentView);

  // Initial route. Normalise only when the *view id* is empty or unknown,
  // comparing the raw hash would rewrite a deep link like #notes?focus=7 down
  // to #notes and eat the param before any view rendered.
  const initial = parseRoute();
  if ((location.hash.replace(/^#/, '').split('?')[0] || '') !== initial.view) {
    location.replace('#' + routeKey(initial));
  }
  activate(initial);

  // The palette owns Ctrl/Cmd+K, so wire it synchronously, it used to be
  // initialised only after the ai/status round-trip, leaving the hotkey dead
  // for the first moments after load. setPaletteChat() reveals the chat entry
  // later, and buildCommands() re-runs on every open.
  initPalette({ chat: false });

  // AI is optional: only wire chat + reveal its button once we know it's configured.
  setupAi();

  // Tells index.php's error guard that the module graph linked and ran, so the
  // "hard-reload" banner only appears for a genuine boot failure.
  window.__inphubLoaded = true;

  // Deploy sanity stamp: if this line is missing from the console, the browser
  // is running a stale app.js (bad copy or cache), see CLAUDE.md deploy notes.
  console.info(`[inphub] v${'2.1.1'} ready`);
}

let chatInited = false;

/**
 * (Re-)check whether the AI layer is configured and show/hide every AI entry
 * point accordingly. Called at boot and again after a Settings save so
 * toggling AI off removes chat + brief immediately, without a reload.
 */
export async function refreshAiAvailability(rerender = true): Promise<void> {
  try {
    const res = await apiGet<{ available: boolean }>('ai', 'status');
    aiAvailable = res.available;
  } catch {
    aiAvailable = false;
  }
  const btn = document.getElementById('btn-chat');
  if (btn) btn.hidden = !aiAvailable;
  if (!aiAvailable) {
    const panel = document.getElementById('chat-panel');
    if (panel) panel.hidden = true;
  }
  if (aiAvailable && !chatInited) {
    initChat();
    chatInited = true;
  }
  setPaletteChat(aiAvailable);
  // Re-render so AI affordances (e.g. the dashboard brief) appear/disappear.
  // Views also re-render on navigation, so callers already inside a view
  // (Settings save) skip this to avoid rebuilding their own DOM mid-flow.
  if (rerender) refreshCurrentView();
}

async function setupAi(): Promise<void> {
  // rerender=false: the initial activate() has already painted. Re-rendering
  // unconditionally here meant every page load rendered its view twice.
  await refreshAiAvailability(false);
  // Only worth a second pass if AI affordances actually need to appear.
  if (aiAvailable) refreshCurrentView();
}

init();
