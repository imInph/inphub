/**
 * inphub: focus: a deep-work timer that logs finished sessions to focus.php,
 * plus today's total and a 7-day bar chart.
 *
 * The timer is wall-clock based, not tick-counted. It stores the accumulated
 * elapsed time plus the timestamp the current segment started, so:
 *   - pausing and resuming cannot double-count (the old version logged a
 *     session on every pause and computed elapsed as planned − remaining, so
 *     10 worked minutes across two sittings were recorded as 15, twice);
 *   - a throttled or suspended background tab stays accurate, because the
 *     display is derived from Date.now() rather than from interval fires;
 *   - a reload mid-session restores it from localStorage instead of losing it.
 *
 * Nothing is written to the server until you finish, let it run out, or stop,
 * "Discard" abandons a session, which previously was impossible.
 */
import { apiGet, apiPost } from './api.js?v=83d0559b02';
import { escapeHtml, fmtDate, timeAgo, emptyState, toast, localDateTime, onAction, confirmDialog, } from './ui.js?v=83d0559b02';
const STORE_KEY = 'inphub.focus.timer';
const PRESETS = [25, 50, 15, 5];
let state = fresh(25 * 60);
let ticker = 0;
let todos = [];
function fresh(planned) {
    return { planned, elapsed: 0, segmentStart: null, label: '', todoId: null, startedAt: null };
}
function save() {
    try {
        if (state.startedAt === null && state.elapsed === 0)
            localStorage.removeItem(STORE_KEY);
        else
            localStorage.setItem(STORE_KEY, JSON.stringify(state));
    }
    catch {
        /* storage unavailable, the timer still works for this page session */
    }
}
function restore() {
    try {
        const raw = localStorage.getItem(STORE_KEY);
        if (!raw)
            return;
        const s = JSON.parse(raw);
        if (typeof s.planned !== 'number' || s.planned <= 0)
            return;
        state = {
            planned: s.planned,
            elapsed: typeof s.elapsed === 'number' && s.elapsed >= 0 ? s.elapsed : 0,
            segmentStart: typeof s.segmentStart === 'number' ? s.segmentStart : null,
            label: typeof s.label === 'string' ? s.label : '',
            todoId: typeof s.todoId === 'number' ? s.todoId : null,
            startedAt: typeof s.startedAt === 'string' ? s.startedAt : null,
        };
    }
    catch {
        /* unreadable, start clean rather than throwing during render */
    }
}
/** The live view container, the timer outlives navigation, captured nodes don't. */
function view() {
    return document.getElementById('view-focus');
}
const running = () => state.segmentStart !== null;
const elapsedMs = () => state.elapsed + (state.segmentStart !== null ? Date.now() - state.segmentStart : 0);
const elapsedSecs = () => Math.floor(elapsedMs() / 1000);
const remainingSecs = () => Math.max(0, state.planned - elapsedSecs());
function clock(total) {
    const m = Math.floor(total / 60);
    const s = total % 60;
    return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}
/* ------------------------------------------------------------------ render */
export async function renderFocus(container) {
    if (state.startedAt === null && state.elapsed === 0 && !running())
        restore();
    container.innerHTML = `
    <div class="grid grid-2">
      <section class="card">
        <div class="timer-display" data-role="display">${clock(remainingSecs())}</div>
        <div class="field-row" style="justify-content:center;margin:14px 0">
          ${PRESETS.map((m) => `<button class="btn" data-action="preset" data-min="${m}">${m}</button>`).join('')}
        </div>
        <label><span>What are you focusing on?</span>
          <input data-role="label" placeholder="Optional label" value="${escapeHtml(state.label)}"></label>
        <label><span>Linked task (optional)</span>
          <select data-role="todo"><option value="">none</option></select></label>
        <div class="field-row" style="margin-top:14px">
          <button class="btn btn-primary btn-block" data-action="startstop">Start</button>
        </div>
        <div class="field-row" data-role="live" hidden>
          <button class="btn btn-block" data-action="finish">Finish &amp; log</button>
          <button class="btn btn-ghost btn-block" data-action="discard">Discard</button>
        </div>
      </section>
      <section class="card">
        <div class="card-head"><h3>This week</h3><span class="chip" data-role="today">0 min today</span></div>
        <div class="weekbar" data-role="week"></div>
        <div class="text-dim" data-role="totals" style="margin-top:10px;font-size:.82rem"></div>
      </section>
    </div>
    <section class="card" style="margin-top:16px">
      <div class="card-head"><h3>Recent sessions</h3></div>
      <div data-role="sessions"></div>
    </section>`;
    const labelEl = container.querySelector('[data-role="label"]');
    labelEl.addEventListener('input', () => {
        state.label = labelEl.value;
        save();
    });
    const todoEl = container.querySelector('[data-role="todo"]');
    todoEl.addEventListener('change', () => {
        state.todoId = todoEl.value ? Number(todoEl.value) : null;
        save();
    });
    onAction(container, (action, el) => {
        if (action === 'preset')
            setPreset(Number(el.dataset.min) * 60);
        if (action === 'startstop')
            running() ? pause() : start();
        if (action === 'finish')
            void finish(false);
        if (action === 'discard')
            void discard();
        if (action === 'del-session')
            void removeSession(Number(el.dataset.id));
    });
    paint();
    if (running())
        startTicker();
    await Promise.all([loadTodos(container), loadStats(container)]);
}
/** Open tasks, so a session can finally set linked_todo_id (the API, the JOIN
 *  and the todo_title fallback all existed already with nothing feeding them). */
async function loadTodos(container) {
    try {
        const all = await apiGet('todos', 'list');
        todos = all.filter((t) => t.status === 'todo' || t.status === 'in_progress').slice(0, 50);
    }
    catch {
        todos = [];
    }
    const sel = container.querySelector('[data-role="todo"]');
    if (!sel)
        return;
    sel.innerHTML = '<option value="">none</option>' + todos.map((t) => `<option value="${t.id}" ${state.todoId === t.id ? 'selected' : ''}>${escapeHtml(t.title)}</option>`).join('');
}
function paint() {
    const root = view();
    if (!root)
        return;
    const display = root.querySelector('[data-role="display"]');
    const left = remainingSecs();
    if (display)
        display.textContent = clock(left);
    const btn = root.querySelector('[data-action="startstop"]');
    if (btn) {
        btn.textContent = running() ? 'Pause' : (elapsedMs() > 0 ? 'Resume' : 'Start');
        btn.classList.toggle('btn-primary', !running());
    }
    const live = root.querySelector('[data-role="live"]');
    if (live)
        live.hidden = elapsedMs() === 0;
    // Visible in a background tab, where a toast never is.
    document.title = running() ? `${clock(left)} inphub` : 'inphub';
}
function startTicker() {
    clearInterval(ticker);
    // 250ms keeps the seconds digit honest without the display depending on
    // interval accuracy, every repaint recomputes from Date.now().
    ticker = window.setInterval(() => {
        paint();
        if (remainingSecs() <= 0)
            void finish(true);
    }, 250);
}
/* ------------------------------------------------------------------- timer */
function setPreset(seconds) {
    if (elapsedMs() > 0) {
        toast('Finish or discard the current session first.', 'bad');
        return;
    }
    state.planned = seconds;
    save();
    paint();
}
function start() {
    state.segmentStart = Date.now();
    if (state.startedAt === null)
        state.startedAt = localDateTime(new Date());
    const input = view()?.querySelector('[data-role="label"]');
    if (input)
        state.label = input.value.trim();
    save();
    paint();
    startTicker();
}
/** Pause banks the elapsed time. It writes nothing to the server. */
function pause() {
    if (state.segmentStart !== null) {
        state.elapsed += Date.now() - state.segmentStart;
        state.segmentStart = null;
    }
    clearInterval(ticker);
    save();
    paint();
}
async function finish(ranOut) {
    pause();
    const minutes = Math.round(state.elapsed / 60000);
    const started = state.startedAt;
    const label = state.label.trim();
    const todoId = state.todoId;
    state = fresh(state.planned);
    save();
    paint();
    if (minutes < 1) {
        toast('Under a minute, so not logged.', '');
        return;
    }
    try {
        await apiPost('focus', 'log', {
            label: label || null,
            linked_todo_id: todoId,
            duration_minutes: minutes,
            started_at: started,
            ended_at: localDateTime(new Date()),
            completed: ranOut ? 1 : 0,
        });
        toast(ranOut ? `Logged ${minutes} min.` : `Logged ${minutes} min.`, 'good');
        const root = view();
        if (root)
            await loadStats(root);
    }
    catch (e) {
        toast(e instanceof Error ? e.message : 'Could not log session', 'bad');
    }
}
/** Throw the session away. The old Reset button silently logged it instead. */
async function discard() {
    const minutes = Math.round(elapsedMs() / 60000);
    if (minutes >= 1 && !(await confirmDialog(`Discard ${minutes} min without logging it?`, 'Discard')))
        return;
    clearInterval(ticker);
    state = fresh(state.planned);
    save();
    paint();
}
async function removeSession(id) {
    if (!(await confirmDialog('Delete this logged session?')))
        return;
    try {
        await apiPost('focus', 'delete', { id });
        const root = view();
        if (root)
            await loadStats(root);
    }
    catch (e) {
        toast(e instanceof Error ? e.message : 'Could not delete', 'bad');
    }
}
/* ------------------------------------------------------------------- stats */
async function loadStats(container) {
    const d = await apiGet('focus', 'list');
    const today = container.querySelector('[data-role="today"]');
    if (today)
        today.textContent = `${d.today_total} min today`;
    const totals = container.querySelector('[data-role="totals"]');
    if (totals) {
        const hours = (d.all_total / 60).toFixed(1);
        totals.textContent = `${d.week_total} min this week · ${d.session_count} sessions all time (${hours} h)`;
    }
    const max = Math.max(60, ...d.weekly.map((w) => w.minutes));
    const week = container.querySelector('[data-role="week"]');
    if (week) {
        week.innerHTML = d.weekly.map((w) => {
            const h = Math.round((w.minutes / max) * 100);
            const day = new Date(w.date + 'T00:00:00').toLocaleDateString(undefined, { weekday: 'short' });
            return `<div class="bar-wrap" title="${escapeHtml(fmtDate(w.date))}: ${w.minutes} min">
        <div class="bar" style="height:${h}%"></div><small>${escapeHtml(day[0])}</small></div>`;
        }).join('');
    }
    const sessions = container.querySelector('[data-role="sessions"]');
    if (!d.sessions.length) {
        sessions.innerHTML = emptyState('', 'No sessions logged yet.');
        return;
    }
    sessions.innerHTML = `<div class="list">${d.sessions.map((s) => `
    <div class="row" data-row="${s.id}">
      <span class="grow">${escapeHtml(s.label || s.todo_title || 'Focus session')}
        <span class="muted"> · ${escapeHtml(fmtDate(s.started_at))}</span></span>
      ${s.completed ? '' : '<span class="chip">stopped early</span>'}
      <span class="mono tabular">${s.duration_minutes}m</span>
      <span class="muted">${escapeHtml(timeAgo(s.started_at))}</span>
      <span class="row-actions">
        <button class="btn btn-ghost btn-sm" data-action="del-session" data-id="${s.id}" title="Delete">✕</button>
      </span>
    </div>`).join('')}</div>`;
}
