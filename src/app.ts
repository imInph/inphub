/**
 * inphub — SPA shell.
 *
 * Owns hash routing, lazy per-view rendering, the theme toggle, the live clock
 * and greeting, and the global keyboard shortcuts. Each view module exposes a
 * `render(container)` entry point; we import them all up front (small app, no
 * bundler) and mount the active one into its <section id="view-<id>">.
 */

import { apiGet, apiPost } from './api.js';
import { toast } from './ui.js';
import { initChat } from './chat.js';
import { initPalette } from './command-palette.js';

import { renderDashboard } from './dashboard.js';
import { renderTodos } from './todos.js';
import { renderExpenses } from './expenses.js';
import { renderRepos } from './repos.js';
import { renderHabits } from './habits.js';
import { renderGoals } from './goals.js';
import { renderNotes } from './notes.js';
import { renderFocus } from './focus.js';
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
  activity: renderActivity,
  settings: renderSettings,
};

const DEFAULT_VIEW = 'dashboard';
let currentView = '';

/* ------------------------------------------------------------------ routing */

function viewFromHash(): string {
  const id = location.hash.replace(/^#/, '').split('?')[0];
  return VIEWS[id] ? id : DEFAULT_VIEW;
}

async function activate(view: string): Promise<void> {
  currentView = view;
  closeNav();

  document.querySelectorAll<HTMLElement>('.nav-item').forEach((el) => {
    el.classList.toggle('active', el.dataset.view === view);
  });
  document.querySelectorAll<HTMLElement>('.view').forEach((section) => {
    section.hidden = section.id !== `view-${view}`;
  });

  const container = document.getElementById(`view-${view}`);
  if (!container) return;
  try {
    await VIEWS[view](container);
  } catch (err) {
    container.innerHTML = `<div class="empty"><div class="big">⚠️</div><div>Could not load this view.</div></div>`;
    toast(err instanceof Error ? err.message : 'Load failed.', 'bad');
  }
}

function onRoute(): void {
  const view = viewFromHash();
  if (view !== currentView) activate(view);
}

/** Navigate programmatically (used by palette + shortcuts). */
export function go(view: string): void {
  if (VIEWS[view]) location.hash = view;
}

/** Close the mobile nav drawer if open. */
function closeNav(): void {
  document.body.classList.remove('nav-open');
}

/** Whether the AI layer is configured — set once at boot. */
export let aiAvailable = false;

/** Re-render the current view (used after an AI-initiated write). */
export function refreshCurrentView(): void {
  const container = document.getElementById(`view-${currentView}`);
  if (container && VIEWS[currentView]) VIEWS[currentView](container);
}

/* -------------------------------------------------------------------- theme */

function applyTheme(theme: string): void {
  document.documentElement.setAttribute('data-theme', theme);
}

async function toggleTheme(): Promise<void> {
  const next = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
  applyTheme(next);
  try {
    await apiPost('settings', 'save', { settings: { theme: next } });
  } catch {
    /* non-fatal: theme still applied for the session */
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
  el.innerHTML = `${part}, ${escapeName(name)}<small>Here's your hub.</small>`;
}

function escapeName(name: string): string {
  const div = document.createElement('div');
  div.textContent = name;
  return div.innerHTML;
}

/* ----------------------------------------------------------------- shortcuts */

/**
 * Global keys:
 *   g then d/t/e/r/h/g/n/f/a/s → jump to a view
 *   /                          → focus the current view's search box (if any)
 *   c                          → open chat (Phase 2; button hidden until then)
 *   ?                          → shortcut help toast
 * Ctrl/Cmd+K is handled by the command palette module (Phase 2).
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
    toast('g+letter to jump · / to search · Ctrl/Cmd+K palette', '');
  }
}

/* -------------------------------------------------------------------- init */

function init(): void {
  applyTheme(boot.theme || 'dark');
  greet();
  tick();
  setInterval(tick, 1000);

  document.getElementById('btn-theme')?.addEventListener('click', toggleTheme);

  // Mobile nav drawer: hamburger toggles it; scrim or a nav choice closes it.
  document.getElementById('btn-menu')?.addEventListener('click', () => document.body.classList.toggle('nav-open'));
  document.getElementById('nav-scrim')?.addEventListener('click', closeNav);

  document.querySelectorAll<HTMLAnchorElement>('.nav-item').forEach((el) => {
    // Anchors already set location.hash; nothing extra needed, but keep focus tidy.
    el.addEventListener('click', () => {
      el.blur();
      closeNav();
    });
  });

  window.addEventListener('hashchange', onRoute);
  document.addEventListener('keydown', onKey);
  window.addEventListener('inphub:data-changed', refreshCurrentView);

  // Initial route (normalise empty/invalid hash to the default view).
  const initial = viewFromHash();
  if (location.hash.replace(/^#/, '') !== initial) {
    location.replace('#' + initial);
  }
  activate(initial);

  // AI is optional: only wire chat + reveal its button once we know it's configured.
  setupAi();
}

async function setupAi(): Promise<void> {
  try {
    const res = await apiGet<{ available: boolean }>('ai', 'status');
    aiAvailable = res.available;
  } catch {
    aiAvailable = false;
  }
  if (aiAvailable) {
    const btn = document.getElementById('btn-chat');
    if (btn) btn.hidden = false;
    initChat();
    // The first view render happened before we knew AI was on — re-render so
    // its AI affordances (e.g. the dashboard brief) appear.
    refreshCurrentView();
  }
  initPalette({ chat: aiAvailable });
}

init();
