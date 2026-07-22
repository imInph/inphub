/**
 * inphub — focus: a client-side pomodoro/deep-work timer that logs finished
 * sessions to focus.php, plus today's total and a 7-day bar chart.
 */
import { apiGet, apiPost } from './api.js';
import { escapeHtml, fmtDate, timeAgo, emptyState, toast, localDateTime } from './ui.js';
let remaining = 25 * 60; // seconds
let planned = 25 * 60;
let running = false;
let ticker = 0;
let startedAt = null;
let sessionLabel = '';
/** The live view container — the timer outlives navigation, captured nodes don't. */
function view() {
    return document.getElementById('view-focus');
}
export async function renderFocus(container) {
    container.innerHTML = `
    <div class="view-head"><h2>Focus</h2></div>
    <div class="grid grid-2">
      <section class="card">
        <div class="timer-display" data-role="display">25:00</div>
        <div class="field-row" style="justify-content:center;margin:14px 0">
          <button class="btn" data-role="preset" data-min="25">25</button>
          <button class="btn" data-role="preset" data-min="50">50</button>
          <button class="btn" data-role="preset" data-min="15">15</button>
          <button class="btn" data-role="preset" data-min="5">5</button>
        </div>
        <label><span>What are you focusing on?</span><input data-role="label" placeholder="Optional label"></label>
        <div class="field-row" style="margin-top:14px">
          <button class="btn btn-primary btn-block" data-role="startstop">Start</button>
          <button class="btn btn-block" data-role="reset">Reset</button>
        </div>
      </section>
      <section class="card">
        <div class="card-head"><h3>This week</h3><span class="chip" data-role="today">0 min today</span></div>
        <div class="weekbar" data-role="week"></div>
      </section>
    </div>
    <section class="card" style="margin-top:16px">
      <div class="card-head"><h3>Recent sessions</h3></div>
      <div data-role="sessions"></div>
    </section>`;
    const display = container.querySelector('[data-role="display"]');
    const startstop = container.querySelector('[data-role="startstop"]');
    const paint = () => {
        const m = Math.floor(remaining / 60);
        const s = remaining % 60;
        display.textContent = `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    };
    container.querySelectorAll('[data-role="preset"]').forEach((b) => {
        b.addEventListener('click', () => {
            if (running)
                return;
            planned = remaining = Number(b.dataset.min) * 60;
            paint();
        });
    });
    startstop.addEventListener('click', () => {
        if (running) {
            stop(false);
        }
        else {
            start();
        }
    });
    container.querySelector('[data-role="reset"]').addEventListener('click', () => {
        if (running)
            stop(false);
        remaining = planned;
        paint();
    });
    paint();
    // A session may still be ticking from before a navigation — reflect it.
    if (running) {
        startstop.textContent = 'Pause';
        startstop.classList.remove('btn-primary');
        const labelEl = container.querySelector('[data-role="label"]');
        if (labelEl)
            labelEl.value = sessionLabel;
    }
    await loadStats(container);
}
function start() {
    running = true;
    startedAt = localDateTime(new Date());
    sessionLabel = view()?.querySelector('[data-role="label"]')?.value.trim() ?? '';
    const btn = view()?.querySelector('[data-role="startstop"]');
    if (btn) {
        btn.textContent = 'Pause';
        btn.classList.remove('btn-primary');
    }
    ticker = window.setInterval(() => {
        remaining--;
        const m = Math.floor(remaining / 60);
        const s = ((remaining % 60) + 60) % 60;
        const display = view()?.querySelector('[data-role="display"]');
        if (display)
            display.textContent = `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
        if (remaining <= 0) {
            stop(true);
            toast('Session complete — nice work.', 'good');
        }
    }, 1000);
}
async function stop(completed) {
    clearInterval(ticker);
    running = false;
    const root = view();
    const btn = root?.querySelector('[data-role="startstop"]');
    if (btn) {
        btn.textContent = 'Start';
        btn.classList.add('btn-primary');
    }
    const elapsedSecs = planned - Math.max(0, remaining);
    const minutes = Math.round(elapsedSecs / 60);
    if (minutes >= 1) {
        // Prefer the live input (still editable mid-session); fall back to the
        // label captured at start if the view was navigated away and rebuilt.
        const label = root?.querySelector('[data-role="label"]')?.value.trim() ?? sessionLabel;
        try {
            await apiPost('focus', 'log', {
                label: label || null,
                duration_minutes: minutes,
                started_at: startedAt,
                ended_at: localDateTime(new Date()),
                completed: completed ? 1 : 0,
            });
            if (root)
                await loadStats(root);
        }
        catch (e) {
            toast(e instanceof Error ? e.message : 'Could not log session', 'bad');
        }
    }
    if (completed)
        remaining = planned;
}
async function loadStats(container) {
    const d = await apiGet('focus', 'list');
    container.querySelector('[data-role="today"]').textContent = `${d.today_total} min today`;
    const max = Math.max(60, ...d.weekly.map((w) => w.minutes));
    container.querySelector('[data-role="week"]').innerHTML = d.weekly.map((w) => {
        const h = Math.round((w.minutes / max) * 100);
        const day = new Date(w.date + 'T00:00:00').toLocaleDateString(undefined, { weekday: 'short' });
        return `<div class="bar-wrap" title="${escapeHtml(w.date)}: ${w.minutes} min">
      <div class="bar" style="height:${h}%"></div><small>${escapeHtml(day[0])}</small></div>`;
    }).join('');
    const sessions = container.querySelector('[data-role="sessions"]');
    if (!d.sessions.length) {
        sessions.innerHTML = emptyState('◔', 'No sessions logged yet.');
        return;
    }
    sessions.innerHTML = `<div class="list">${d.sessions.map((s) => `
    <div class="row">
      <span class="grow">${escapeHtml(s.label || s.todo_title || 'Focus session')}
        <span class="muted"> · ${escapeHtml(fmtDate(s.started_at))}</span></span>
      ${s.completed ? '' : '<span class="chip">interrupted</span>'}
      <span class="mono tabular">${s.duration_minutes}m</span>
      <span class="muted">${escapeHtml(timeAgo(s.started_at))}</span>
    </div>`).join('')}</div>`;
}
