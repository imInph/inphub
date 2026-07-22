/**
 * inphub — focus: a client-side pomodoro/deep-work timer that logs finished
 * sessions to focus.php, plus today's total and a 7-day bar chart.
 */

import { apiGet, apiPost } from './api.js';
import { escapeHtml, fmtDate, timeAgo, emptyState, toast } from './ui.js';

interface Session {
  id: number; label: string | null; linked_todo_id: number | null; todo_title: string | null;
  duration_minutes: number; started_at: string; ended_at: string | null; completed: number;
}
interface FocusData { sessions: Session[]; today_total: number; weekly: { date: string; minutes: number }[]; }

let remaining = 25 * 60;   // seconds
let planned = 25 * 60;
let running = false;
let ticker = 0;
let startedAt: string | null = null;

export async function renderFocus(container: HTMLElement): Promise<void> {
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

  const display = container.querySelector<HTMLElement>('[data-role="display"]')!;
  const startstop = container.querySelector<HTMLButtonElement>('[data-role="startstop"]')!;

  const paint = () => {
    const m = Math.floor(remaining / 60);
    const s = remaining % 60;
    display.textContent = `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  };

  container.querySelectorAll<HTMLButtonElement>('[data-role="preset"]').forEach((b) => {
    b.addEventListener('click', () => {
      if (running) return;
      planned = remaining = Number(b.dataset.min) * 60;
      paint();
    });
  });

  startstop.addEventListener('click', () => {
    if (running) {
      stop(container, false);
    } else {
      start(container);
    }
  });
  container.querySelector<HTMLButtonElement>('[data-role="reset"]')!.addEventListener('click', () => {
    if (running) stop(container, false);
    remaining = planned;
    paint();
  });

  paint();
  await loadStats(container);
}

function start(container: HTMLElement): void {
  running = true;
  startedAt = new Date().toISOString().slice(0, 19).replace('T', ' ');
  const btn = container.querySelector<HTMLButtonElement>('[data-role="startstop"]')!;
  const display = container.querySelector<HTMLElement>('[data-role="display"]')!;
  btn.textContent = 'Pause';
  btn.classList.remove('btn-primary');

  ticker = window.setInterval(() => {
    remaining--;
    const m = Math.floor(remaining / 60);
    const s = ((remaining % 60) + 60) % 60;
    display.textContent = `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    if (remaining <= 0) {
      stop(container, true);
      toast('Session complete — nice work.', 'good');
    }
  }, 1000);
}

async function stop(container: HTMLElement, completed: boolean): Promise<void> {
  clearInterval(ticker);
  running = false;
  const btn = container.querySelector<HTMLButtonElement>('[data-role="startstop"]')!;
  btn.textContent = 'Start';
  btn.classList.add('btn-primary');

  const elapsedSecs = planned - Math.max(0, remaining);
  const minutes = Math.round(elapsedSecs / 60);
  if (minutes >= 1) {
    const label = container.querySelector<HTMLInputElement>('[data-role="label"]')!.value.trim();
    try {
      await apiPost('focus', 'log', {
        label: label || null,
        duration_minutes: minutes,
        started_at: startedAt,
        ended_at: new Date().toISOString().slice(0, 19).replace('T', ' '),
        completed: completed ? 1 : 0,
      });
      await loadStats(container);
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not log session', 'bad');
    }
  }
  if (completed) remaining = planned;
}

async function loadStats(container: HTMLElement): Promise<void> {
  const d = await apiGet<FocusData>('focus', 'list');
  container.querySelector<HTMLElement>('[data-role="today"]')!.textContent = `${d.today_total} min today`;

  const max = Math.max(60, ...d.weekly.map((w) => w.minutes));
  container.querySelector<HTMLElement>('[data-role="week"]')!.innerHTML = d.weekly.map((w) => {
    const h = Math.round((w.minutes / max) * 100);
    const day = new Date(w.date + 'T00:00:00').toLocaleDateString(undefined, { weekday: 'short' });
    return `<div class="bar-wrap" title="${escapeHtml(w.date)}: ${w.minutes} min">
      <div class="bar" style="height:${h}%"></div><small>${escapeHtml(day[0])}</small></div>`;
  }).join('');

  const sessions = container.querySelector<HTMLElement>('[data-role="sessions"]')!;
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
