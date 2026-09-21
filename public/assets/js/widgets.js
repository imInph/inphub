/**
 * inphub: dashboard widget registry.
 *
 * Every widget the dashboard can show, keyed by id. The ids MUST match
 * DASHBOARD_WIDGETS in lib/helpers.php, which is what the server validates a
 * saved layout against (an id missing there is silently dropped on save).
 *
 * A widget renders an HTML string from the one stats.php?action=dashboard
 * payload; the few that need live behaviour (clock, capture, brief) also get a
 * mount() call after the dashboard markup is in the DOM.
 */
import { apiGet, apiPost } from './api.js?v=42714d0ded';
import { escapeHtml, money, fmtDate, timeAgo, markdown, toast, localDate, sparkline, } from './ui.js?v=42714d0ded';
import { go, aiAvailable } from './app.js?v=42714d0ded';
import { icon } from './icons.js?v=42714d0ded';
/* ------------------------------------------------------------------ shell */
export function widgetShell(id, def, size, index, body) {
    return `<section class="card widget" data-widget="${id}" data-size="${size}" style="--i:${index}">
    <div class="widget-inner">
      <header class="widget-head">
        <span class="widget-ico tint-${def.tint}">${icon(def.icon, 16)}</span>
        <h3>${escapeHtml(def.title)}</h3>
        ${def.view
        ? `<button class="widget-open" data-action="goto" data-view="${def.view}" aria-label="Open ${escapeHtml(def.title)}">${icon('chevron', 16)}</button>`
        : ''}
      </header>
      <div class="widget-body">${body}</div>
    </div>
  </section>`;
}
function empty(message) {
    return `<div class="w-empty">${escapeHtml(message)}</div>`;
}
/** "YYYY-MM-DD" as a local Date (new Date('2026-09-15') would be UTC midnight). */
function parseDay(day) {
    const [y, m, d] = day.split('-').map(Number);
    return new Date(y, (m || 1) - 1, d || 1);
}
/* ---------------------------------------------------------------- widgets */
function renderTodos(d) {
    if (!d.todos.length)
        return empty('Nothing due. Enjoy it.');
    const today = localDate(new Date());
    return `<div class="w-list">${d.todos.map((t) => {
        const overdue = t.due_date !== null && t.due_date < today;
        return `<button class="w-row" data-action="goto" data-view="todos" data-focus="${t.id}">
      <span class="w-dot ${overdue ? 'bad' : t.due_date ? 'accent' : ''}"></span>
      <span class="grow">${escapeHtml(t.title)}
        ${t.due_date ? `<small class="${overdue ? 'text-bad' : ''}">${overdue ? 'Overdue · ' : ''}${escapeHtml(fmtDate(t.due_date))}</small>` : ''}</span>
      ${t.priority === 'urgent' || t.priority === 'high' ? `<span class="chip pri-${escapeHtml(t.priority)}">${escapeHtml(t.priority)}</span>` : ''}
    </button>`;
    }).join('')}</div>`;
}
function renderHabits(d) {
    if (!d.habits.length)
        return empty('No habits yet.');
    const done = d.habits.filter((h) => Number(h.logged_today)).length;
    const pct = Math.round((done / d.habits.length) * 100);
    return `<div class="w-habits-top">
      <div class="ring" style="--p:${pct}"><span>${done}/${d.habits.length}</span></div>
      <div><div class="w-big">${pct}%</div><small class="text-dim">done today</small></div>
    </div>
    <div class="habit-chips">${d.habits.map((h) => `
      <button class="habit-chip ${Number(h.logged_today) ? 'done' : ''}" data-action="toggle-habit" data-id="${h.id}">
        <span class="habit-tick">${Number(h.logged_today) ? icon('check', 14) : ''}</span>${escapeHtml(h.name)}
      </button>`).join('')}</div>`;
}
function renderMoney(d) {
    const m = d.money;
    const cur = d.currency || 'TRY';
    const net = m.income - m.spent;
    const cats = m.top_categories.length
        ? `<div class="w-list tight">${m.top_categories.map((c) => {
            const total = parseFloat(c.total);
            const budget = c.monthly_budget ? parseFloat(c.monthly_budget) : null;
            const pct = budget ? Math.min(100, Math.round((total / budget) * 100)) : null;
            return `<div class="w-cat">
          <div class="w-cat-line">
            <span class="grow">${dot(c.color)} ${escapeHtml(c.name)}</span>
            <span class="tabular">${escapeHtml(money(total, cur))}</span>
          </div>
          ${pct !== null ? `<div class="progress ${pct >= 100 ? 'over' : ''}"><span style="width:${pct}%"></span></div>` : ''}
        </div>`;
        }).join('')}</div>`
        : '';
    return `<div class="w-stats w-stats-money">
      <div><small>Spent</small><div class="w-num text-bad">${escapeHtml(money(m.spent, cur))}</div></div>
      <div><small>Income</small><div class="w-num text-good">${escapeHtml(money(m.income, cur))}</div></div>
      <div><small>Net</small><div class="w-num">${escapeHtml(money(net, cur))}</div></div>
    </div>${cats}`;
}
function renderWallet(d) {
    const cur = d.currency || 'TRY';
    const series = d.wallet?.series ?? [];
    const values = series.map((p) => p.balance);
    const delta = values.length > 1 ? values[values.length - 1] - values[0] : 0;
    const trend = delta > 0 ? 'good' : delta < 0 ? 'bad' : 'dim';
    return `<div class="w-wallet">
    <small class="text-dim">Current balance</small>
    <div class="w-hero tabular">${escapeHtml(money(d.wallet?.balance ?? 0, cur))}</div>
    <div class="text-${trend} w-delta">${delta > 0 ? '▲' : delta < 0 ? '▼' : '•'}
      ${escapeHtml(money(Math.abs(delta), cur))} <span class="text-dim">in 30 days</span></div>
    <div class="w-spark text-${trend === 'dim' ? 'accent' : trend}">${sparkline(values)}</div>
  </div>`;
}
function renderRepos(d) {
    const r = d.repos;
    const n = r.most_neglected;
    return `<div class="w-stats">
      <div><small>Stale repos</small><div class="w-num">${r.stale_count}</div></div>
      ${n ? `<div class="w-span2"><small>Most neglected</small>
        <div class="w-ellipsis">${escapeHtml(n.name)}</div>
        <small>${n.staleness_days !== null ? `${n.staleness_days}d idle` : ''}${n.health_score !== null ? ` · health ${n.health_score}` : ''}</small></div>` : ''}
    </div>`;
}
function renderGoals(d) {
    if (!d.goals.length)
        return empty('No active goals.');
    return `<div class="w-list tight">${d.goals.map((g) => {
        const pct = g.target_value ? Math.min(100, Math.round((g.current_value / g.target_value) * 100)) : 0;
        return `<button class="w-goal" data-action="goto" data-view="goals" data-focus="${g.id}">
      <span class="w-cat-line">
        <span class="grow">${escapeHtml(g.title)}</span>
        <small class="tabular">${g.current_value}${g.target_value ? '/' + g.target_value : ''} ${escapeHtml(g.unit ?? '')}</small>
      </span>
      ${g.target_value ? `<span class="progress"><span style="width:${pct}%"></span></span>` : ''}
    </button>`;
    }).join('')}</div>`;
}
function renderFocus(d) {
    const f = d.focus;
    if (!f)
        return empty('No focus data.');
    return `<div class="w-stats">
      <div><small>Today</small><div class="w-num">${f.today_minutes}<span class="w-unit">min</span></div></div>
      <div><small>Last 7 days</small><div class="w-num">${f.week_minutes}<span class="w-unit">min</span></div></div>
    </div>
    <div class="w-foot">${f.last
        ? `Last: ${escapeHtml(f.last.label || f.last.todo_title || 'Focus session')} · ${f.last.duration_minutes}m · ${escapeHtml(timeAgo(f.last.started_at))}`
        : 'No sessions yet.'}</div>`;
}
function renderActivity(d) {
    if (!d.activity.length)
        return empty('No activity yet.');
    return `<div class="w-timeline">${d.activity.map((a) => `
    <div class="w-tl-row">
      <span class="w-tl-dot ${a.actor === 'ai' ? 'ai' : ''}"></span>
      <span class="grow">${escapeHtml(a.summary)}</span>
      <small>${a.actor === 'ai' ? 'AI · ' : ''}${escapeHtml(timeAgo(a.created_at))}</small>
    </div>`).join('')}</div>`;
}
/* ---- clock ---- */
let clockTimer = 0;
function clockParts(now = new Date()) {
    return {
        time: now.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }),
        date: now.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' }),
    };
}
function renderClock() {
    const now = new Date();
    const { time, date } = clockParts(now);
    // Weekday initials from a known Monday (1 Jan 2024), so they stay localised.
    const heads = Array.from({ length: 7 }, (_, i) => new Date(2024, 0, 1 + i).toLocaleDateString(undefined, { weekday: 'narrow' }));
    const first = new Date(now.getFullYear(), now.getMonth(), 1);
    const lead = (first.getDay() + 6) % 7; // Monday-first
    const days = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
    const cells = [
        ...Array.from({ length: lead }, () => '<span></span>'),
        ...Array.from({ length: days }, (_, i) => `<span class="${i + 1 === now.getDate() ? 'today' : ''}">${i + 1}</span>`),
    ].join('');
    return `<div class="w-clock">
    <div>
      <div class="w-clock-time tabular" data-clock="time">${escapeHtml(time)}</div>
      <div class="w-clock-date" data-clock="date">${escapeHtml(date)}</div>
    </div>
    <div class="w-cal">
      <div class="w-cal-month">${escapeHtml(now.toLocaleDateString(undefined, { month: 'long', year: 'numeric' }))}</div>
      <div class="w-cal-grid">${heads.map((h) => `<b>${escapeHtml(h)}</b>`).join('')}${cells}</div>
    </div>
  </div>`;
}
function mountClock() {
    if (clockTimer)
        return;
    // One module-wide timer that looks the nodes up every tick: the dashboard
    // replaces its DOM on every render, so captured nodes would go stale.
    clockTimer = window.setInterval(() => {
        const nodes = document.querySelectorAll('[data-clock]');
        if (!nodes.length)
            return;
        const parts = clockParts();
        nodes.forEach((n) => {
            const next = n.dataset.clock === 'time' ? parts.time : parts.date;
            if (n.textContent !== next)
                n.textContent = next;
        });
    }, 1000);
}
/* ---- quick capture ---- */
let captureMode = 'todo';
function renderCapture() {
    const todo = captureMode === 'todo';
    return `<form class="w-capture" data-role="capture">
    <div class="segmented" role="group" aria-label="Capture type">
      <button type="button" class="${todo ? 'on' : ''}" data-action="capture-mode" data-mode="todo" aria-pressed="${todo}">Task</button>
      <button type="button" class="${todo ? '' : 'on'}" data-action="capture-mode" data-mode="note" aria-pressed="${!todo}">Note</button>
    </div>
    <div class="w-capture-field">
      <input name="text" autocomplete="off" spellcheck="true"
        placeholder="${todo ? 'Add a task…' : 'Jot something down…'}" aria-label="${todo ? 'New task' : 'New note'}">
      <button class="btn btn-primary btn-icon" type="submit" aria-label="Save">${icon('send', 18)}</button>
    </div>
    <small class="text-dim">Enter to save to ${todo ? 'To-Do' : 'Notes'}.</small>
  </form>`;
}
export function setCaptureMode(container, mode, rerender) {
    captureMode = mode === 'note' ? 'note' : 'todo';
    const host = container.querySelector('[data-widget="capture"] .widget-body');
    if (!host)
        return;
    host.innerHTML = renderCapture();
    mountCapture(container, rerender);
    host.querySelector('input[name="text"]')?.focus();
}
function mountCapture(container, rerender) {
    const form = container.querySelector('[data-role="capture"]');
    // A fresh node on every render (never the persistent view container), so a
    // direct listener cannot stack.
    form?.addEventListener('submit', async (e) => {
        e.preventDefault();
        const input = form.querySelector('input[name="text"]');
        const text = input.value.trim();
        if (!text)
            return;
        input.disabled = true;
        try {
            if (captureMode === 'todo') {
                await apiPost('todos', 'create', { title: text });
                toast('Task added.', 'good');
            }
            else {
                const res = await apiPost('notes', 'create', { content: text });
                toast('Note saved.', 'good', { label: 'Open', run: () => go('notes', { focus: res.id }) });
            }
            await rerender();
            container.querySelector('[data-role="capture"] input[name="text"]')?.focus();
        }
        catch (err) {
            input.disabled = false;
            toast(err instanceof Error ? err.message : 'Could not save.', 'bad');
        }
    });
}
/* ---- upcoming ---- */
function renderUpcoming(d) {
    const up = d.upcoming ?? { todos: [], goals: [] };
    const entries = [
        ...up.todos.map((t) => ({
            day: t.due_date,
            html: `<button class="w-row" data-action="goto" data-view="todos" data-focus="${t.id}">
        <span class="w-dot accent"></span><span class="grow">${escapeHtml(t.title)}</span>
        ${t.priority === 'urgent' || t.priority === 'high' ? `<span class="chip pri-${escapeHtml(t.priority)}">${escapeHtml(t.priority)}</span>` : ''}
      </button>`,
        })),
        ...up.goals.map((g) => ({
            day: g.target_date,
            html: `<button class="w-row" data-action="goto" data-view="goals" data-focus="${g.id}">
        <span class="w-dot warn"></span><span class="grow">${escapeHtml(g.title)}</span><small>Goal deadline</small>
      </button>`,
        })),
    ].sort((a, b) => a.day.localeCompare(b.day));
    if (!entries.length)
        return empty('A clear week ahead.');
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    const tomorrowKey = localDate(tomorrow);
    const groups = new Map();
    entries.forEach((e) => groups.set(e.day, [...(groups.get(e.day) ?? []), e.html]));
    return `<div class="w-upcoming">${[...groups].map(([day, rows]) => {
        const label = day === tomorrowKey
            ? 'Tomorrow'
            : parseDay(day).toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'short' });
        return `<div class="w-day"><div class="w-day-label">${escapeHtml(label)}</div><div class="w-list tight">${rows.join('')}</div></div>`;
    }).join('')}</div>`;
}
/* ---- daily brief ---- */
/** In-flight brief generation, aborted on re-render/navigation, guards re-entry. */
let briefCtl = null;
export function abortBrief() {
    briefCtl?.abort();
    briefCtl = null;
}
function briefHost(container) {
    return container.querySelector('[data-role="brief"]');
}
function briefBody(content) {
    return `${content ? `<div class="md">${markdown(content)}</div>` : '<div class="w-empty">An AI summary of your day.</div>'}
    <div class="w-actions">
      ${content ? '<button class="btn btn-ghost btn-sm" data-action="clear-brief">Clear</button>' : ''}
      <button class="btn btn-sm" data-action="gen-brief">${icon('sparkles', 14)} ${content ? 'Regenerate' : 'Generate'}</button>
    </div>`;
}
async function loadBrief(container) {
    const host = briefHost(container);
    if (!host)
        return;
    try {
        const res = await apiGet('ai', 'brief');
        host.innerHTML = briefBody(res.brief?.content ?? null);
    }
    catch {
        host.innerHTML = empty('The brief could not be loaded.');
    }
}
export async function clearBrief(container) {
    const host = briefHost(container);
    if (!host)
        return;
    try {
        await apiPost('ai', 'clear_brief', {});
        host.innerHTML = briefBody(null);
    }
    catch (e) {
        toast(e instanceof Error ? e.message : 'Failed', 'bad');
    }
}
export async function generateBrief(container) {
    const host = briefHost(container);
    if (!host || briefCtl)
        return; // one request at a time
    briefCtl = new AbortController();
    host.innerHTML = '<div class="skeleton-wrap"><div class="skeleton"></div><div class="skeleton short"></div></div>';
    try {
        const res = await apiPost('ai', 'generate_brief', {}, { signal: briefCtl.signal });
        host.innerHTML = briefBody(res.brief.content);
    }
    catch (e) {
        if (e instanceof DOMException && e.name === 'AbortError')
            return; // navigated away
        toast(e instanceof Error ? e.message : 'Failed', 'bad');
        loadBrief(container);
    }
    finally {
        briefCtl = null;
    }
}
/* --------------------------------------------------------------- registry */
function dot(color) {
    return `<span class="w-swatch" style="background:${escapeHtml(color || '#6b7280')}"></span>`;
}
export const WIDGETS = {
    clock: {
        title: 'Clock', desc: 'Time, date and this month at a glance.', icon: 'clock', tint: 'indigo', size: 'normal',
        render: renderClock, mount: mountClock,
    },
    capture: {
        title: 'Quick capture', desc: 'Add a task or a note without leaving the dashboard.', icon: 'capture', tint: 'orange', size: 'normal',
        render: renderCapture, mount: mountCapture,
    },
    todos: {
        title: 'Due & overdue', desc: 'Open tasks due today, overdue, or undated.', icon: 'todos', tint: 'blue', view: 'todos', size: 'normal',
        render: renderTodos,
    },
    upcoming: {
        title: 'Upcoming 7 days', desc: 'Tasks and goal deadlines coming up this week.', icon: 'calendar', tint: 'red', view: 'todos', size: 'normal',
        render: renderUpcoming,
    },
    habits: {
        title: "Today's habits", desc: 'Tick off habits with one tap.', icon: 'habits', tint: 'green', view: 'habits', size: 'normal',
        render: renderHabits,
    },
    money: {
        title: 'This month', desc: 'Spent, income and top categories this month.', icon: 'money', tint: 'teal', view: 'expenses', size: 'normal',
        render: renderMoney,
    },
    wallet: {
        title: 'Wallet', desc: 'Your current balance and its 30-day trend.', icon: 'wallet', tint: 'green', view: 'expenses', size: 'normal',
        render: renderWallet,
    },
    goals: {
        title: 'Goals', desc: 'Progress on your active goals.', icon: 'goals', tint: 'pink', view: 'goals', size: 'normal',
        render: renderGoals,
    },
    focus: {
        title: 'Focus', desc: 'Minutes focused today and this week.', icon: 'focus', tint: 'purple', view: 'focus', size: 'normal',
        render: renderFocus,
    },
    brief: {
        title: 'Daily brief', desc: 'An AI-written summary of your day.', icon: 'sparkles', tint: 'purple', size: 'wide', aiOnly: true,
        render: () => '<div data-role="brief"><div class="skeleton-wrap"><div class="skeleton"></div></div></div>',
        mount: (container) => { void loadBrief(container); },
    },
    activity: {
        title: 'Recent activity', desc: 'The latest changes across the app.', icon: 'activity', tint: 'graphite', view: 'activity', size: 'normal',
        render: renderActivity,
    },
    repos: {
        title: 'Repositories', desc: 'Stale repos and the most neglected one.', icon: 'repos', tint: 'graphite', view: 'repos', size: 'normal',
        render: renderRepos,
    },
};
export function isWidgetId(id) {
    return Object.prototype.hasOwnProperty.call(WIDGETS, id);
}
/** Every widget on, in registry order at its default size. */
export function defaultLayout() {
    return Object.keys(WIDGETS).map((id) => ({ id, size: WIDGETS[id].size }));
}
/** Whether a widget can render right now (the brief needs the AI layer). */
export function widgetAvailable(id) {
    return !WIDGETS[id].aiOnly || aiAvailable;
}
