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
import { initPalette, setPaletteChat } from './command-palette.js';
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
export const boot = window.INPHUB;
const VIEWS = {
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
function viewFromHash() {
    const id = location.hash.replace(/^#/, '').split('?')[0];
    return VIEWS[id] ? id : DEFAULT_VIEW;
}
async function activate(view) {
    currentView = view;
    document.querySelectorAll('.nav-item').forEach((el) => {
        el.classList.toggle('active', el.dataset.view === view);
    });
    document.querySelectorAll('.view').forEach((section) => {
        section.hidden = section.id !== `view-${view}`;
    });
    const container = document.getElementById(`view-${view}`);
    if (!container)
        return;
    try {
        await VIEWS[view](container);
    }
    catch (err) {
        container.innerHTML = `<div class="empty"><div class="big">⚠️</div><div>Could not load this view.</div></div>`;
        toast(err instanceof Error ? err.message : 'Load failed.', 'bad');
    }
}
function onRoute() {
    const view = viewFromHash();
    if (view !== currentView)
        activate(view);
}
/** Navigate programmatically (used by palette + shortcuts). */
export function go(view) {
    if (VIEWS[view])
        location.hash = view;
}
/** Whether the AI layer is configured — set once at boot. */
export let aiAvailable = false;
/** Re-render the current view (used after an AI-initiated write). */
export function refreshCurrentView() {
    const container = document.getElementById(`view-${currentView}`);
    if (container && VIEWS[currentView])
        VIEWS[currentView](container);
}
/* -------------------------------------------------------------------- theme */
const THEME_KEY = 'inphub.theme';
function applyTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
}
async function toggleTheme() {
    const next = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
    applyTheme(next);
    // Instant local cache so the choice survives a reload even if the save fails.
    try {
        localStorage.setItem(THEME_KEY, next);
    }
    catch {
        /* storage unavailable — settings save below still covers it */
    }
    try {
        await apiPost('settings', 'save', { settings: { theme: next } });
    }
    catch {
        toast('Theme saved locally, but syncing to your account failed.', 'bad');
    }
}
/* ---------------------------------------------------------- clock + greeting */
function tick() {
    const clock = document.getElementById('clock');
    if (clock) {
        clock.textContent = new Date().toLocaleTimeString(undefined, {
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
        });
    }
}
function greet() {
    const el = document.getElementById('greeting');
    if (!el)
        return;
    const h = new Date().getHours();
    const part = h < 5 ? 'Late night' : h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
    const name = boot.user.display_name || boot.user.username;
    el.innerHTML = `${part}, ${escapeName(name)}<small>Here's your hub.</small>`;
}
function escapeName(name) {
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
const G_MAP = {
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
function isTyping(el) {
    const node = el;
    return !!node && (node.tagName === 'INPUT' || node.tagName === 'TEXTAREA' || node.tagName === 'SELECT' || node.isContentEditable);
}
function onKey(e) {
    if (isTyping(e.target))
        return;
    if (e.metaKey || e.ctrlKey || e.altKey)
        return;
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
        const search = document.querySelector(`#view-${currentView} input[type="search"], #view-${currentView} input[data-role="search"]`);
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
function init() {
    // localStorage holds the user's latest choice (set only on toggle) — it wins
    // over the server value in case a previous settings save failed.
    let cached = null;
    try {
        cached = localStorage.getItem(THEME_KEY);
    }
    catch {
        /* storage unavailable */
    }
    applyTheme(cached === 'light' || cached === 'dark' ? cached : (boot.theme || 'dark'));
    greet();
    tick();
    setInterval(tick, 1000);
    document.getElementById('btn-theme')?.addEventListener('click', toggleTheme);
    // Mobile nav drawer (hamburger is only visible at the small breakpoint).
    const sidebar = document.querySelector('.sidebar');
    const navBackdrop = document.getElementById('nav-backdrop');
    const setDrawer = (open) => {
        sidebar?.classList.toggle('open', open);
        if (navBackdrop)
            navBackdrop.hidden = !open;
    };
    document.getElementById('btn-nav')?.addEventListener('click', () => setDrawer(!sidebar?.classList.contains('open')));
    navBackdrop?.addEventListener('click', () => setDrawer(false));
    sidebar?.addEventListener('click', (e) => {
        // Navigating or using a footer action closes the drawer.
        if (e.target.closest('.nav-item, .sidebar-foot .btn'))
            setDrawer(false);
    });
    document.querySelectorAll('.nav-item').forEach((el) => {
        // Anchors already set location.hash; nothing extra needed, but keep focus tidy.
        el.addEventListener('click', () => el.blur());
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
let chatInited = false;
/**
 * (Re-)check whether the AI layer is configured and show/hide every AI entry
 * point accordingly. Called at boot and again after a Settings save so
 * toggling AI off removes chat + brief immediately, without a reload.
 */
export async function refreshAiAvailability(rerender = true) {
    try {
        const res = await apiGet('ai', 'status');
        aiAvailable = res.available;
    }
    catch {
        aiAvailable = false;
    }
    const btn = document.getElementById('btn-chat');
    if (btn)
        btn.hidden = !aiAvailable;
    if (!aiAvailable) {
        const panel = document.getElementById('chat-panel');
        if (panel)
            panel.hidden = true;
    }
    if (aiAvailable && !chatInited) {
        initChat();
        chatInited = true;
    }
    setPaletteChat(aiAvailable);
    // Re-render so AI affordances (e.g. the dashboard brief) appear/disappear.
    // Views also re-render on navigation, so callers already inside a view
    // (Settings save) skip this to avoid rebuilding their own DOM mid-flow.
    if (rerender)
        refreshCurrentView();
}
async function setupAi() {
    await refreshAiAvailability();
    initPalette({ chat: aiAvailable });
}
init();
