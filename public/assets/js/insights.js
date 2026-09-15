/**
 * inphub: insights: the cross-entity patterns no single view can show.
 *
 * Everything comes from one api/insights.php call, scoped by the same period
 * vocabulary as Money. Chart.js is a global, vendored in public/assets/js and
 * loaded by the shell, so charts cost nothing extra here.
 */
import { apiGet } from './api.js?v=83d0559b02';
import { escapeHtml, money, fmtMonth, fmtDate, emptyState, loadingState, onAction } from './ui.js?v=83d0559b02';
/** Same six windows as Money, server keys live in MONEY_PERIODS. */
const PERIODS = [
    ['month', 'This month'],
    ['last_month', 'Last month'],
    ['3m', 'Last 3 months'],
    ['6m', 'Last 6 months'],
    ['year', 'This year'],
    ['all', 'All time'],
];
const PERIOD_KEY = 'inphub.insights.period';
let period = storedPeriod();
const charts = {};
function storedPeriod() {
    try {
        const v = localStorage.getItem(PERIOD_KEY);
        if (v && PERIODS.some(([k]) => k === v))
            return v;
    }
    catch {
        /* storage unavailable */
    }
    return '3m';
}
function rememberPeriod(value) {
    try {
        localStorage.setItem(PERIOD_KEY, value);
    }
    catch {
        /* storage unavailable */
    }
}
/** Theme tokens, read live so charts follow the light/dark switch. */
function palette() {
    const cs = getComputedStyle(document.documentElement);
    const get = (name, fallback) => cs.getPropertyValue(name).trim() || fallback;
    return {
        accent: get('--accent', '#4f8cff'),
        good: get('--good', '#22c55e'),
        warn: get('--warn', '#eab308'),
        bad: get('--bad', '#ef4444'),
        text: get('--text-dim', '#97a0b0'),
        grid: get('--border', '#232936'),
    };
}
export async function renderInsights(container) {
    container.innerHTML = `
    <div class="view-head">
      <div class="toolbar">
        <select data-role="period" style="width:auto">
          ${PERIODS.map(([k, label]) => `<option value="${k}"${k === period ? ' selected' : ''}>${escapeHtml(label)}</option>`).join('')}
        </select>
      </div>
    </div>
    <div class="grid grid-3 stat-strip" data-role="stats">${loadingState(1)}</div>
    <div data-role="body"></div>`;
    // Bound once; only [data-role] nodes are swapped, never .view-head.
    const periodEl = container.querySelector('[data-role="period"]');
    periodEl.addEventListener('change', () => {
        period = periodEl.value || '3m';
        rememberPeriod(period);
        void load(container);
    });
    onAction(container, () => {
        /* no row actions yet, registered so future ones are delegated */
    });
    await load(container);
}
async function load(container) {
    const body = container.querySelector('[data-role="body"]');
    body.innerHTML = loadingState(4);
    const d = await apiGet('insights', 'summary', { period });
    const cur = d.currency || 'TRY';
    const hasAnything = d.totals.spend > 0 || d.totals.tasks_done > 0
        || d.totals.focus_minutes > 0 || d.habits.length > 0;
    container.querySelector('[data-role="stats"]').innerHTML = `
    ${stat('Spent', d.label, money(d.totals.spend, cur), d.totals.spend > 0 ? 'text-bad' : '')}
    ${stat('Focused', d.label, hours(d.totals.focus_minutes), 'text-good')}
    ${stat('Tasks done', d.label, String(d.totals.tasks_done), '')}
    ${stat('Habit consistency', `${d.days} days`, pct(d.totals.habit_rate), rateTone(d.totals.habit_rate))}
    ${stat('Notes written', d.label, String(d.totals.notes), '')}
    ${stat('Net', d.label, money(d.totals.income - d.totals.spend, cur), d.totals.income - d.totals.spend < 0 ? 'text-bad' : 'text-good')}`;
    if (!hasAnything) {
        body.innerHTML = emptyState('', 'Not enough logged in this period to chart.');
        return;
    }
    body.innerHTML = `
    <div class="grid grid-2">
      <section class="card">
        <div class="card-head"><h3>Spend by weekday</h3>
          <span class="chip">${escapeHtml(busiestDay(d))}</span></div>
        <canvas data-chart="weekday" height="200"></canvas>
      </section>
      <section class="card">
        <div class="card-head"><h3>Activity by hour</h3>
          <span class="chip">${escapeHtml(busiestHour(d))}</span></div>
        <canvas data-chart="hours" height="200"></canvas>
      </section>
      <section class="card">
        <div class="card-head"><h3>Focus over time</h3>
          <span class="chip">${escapeHtml(d.granularity === 'month' ? 'monthly' : 'daily')}</span></div>
        <canvas data-chart="focus" height="200"></canvas>
      </section>
      <section class="card">
        <div class="card-head"><h3>Tasks completed</h3>
          <span class="chip">${escapeHtml(d.granularity === 'month' ? 'monthly' : 'daily')}</span></div>
        <canvas data-chart="velocity" height="200"></canvas>
      </section>
    </div>

    ${d.habits.length ? `<section class="card" style="margin-top:16px">
      <div class="card-head"><h3>Habit consistency</h3>
        <span class="chip">${d.days} days</span></div>
      <div class="list">${d.habits.map((h) => bar(h.name, h.rate, pct(h.rate), `${h.done_days} of ${d.days} days`, h.color)).join('')}</div>
    </section>` : ''}

    ${d.categories.length ? `<section class="card" style="margin-top:16px">
      <div class="card-head"><h3>Spending by category</h3></div>
      <div class="list">${categoryBars(d, cur)}</div>
    </section>` : ''}`;
    drawCharts(container, d, cur);
}
/* ------------------------------------------------------------------ pieces */
function stat(title, sub, value, tone) {
    return `<div class="card stat">
    <div class="stat-label">${escapeHtml(title)} <span class="text-dim">· ${escapeHtml(sub)}</span></div>
    <div class="stat-value mono tabular ${tone}">${escapeHtml(value)}</div>
  </div>`;
}
/** A labelled progress row, reuses .progress rather than another chart. */
function bar(label, ratio, valueText, sub, color) {
    const width = Math.max(0, Math.min(100, Math.round(ratio * 100)));
    return `<div>
    <div class="row" style="border:none;padding:2px 0;background:none">
      <span class="grow">${dot(color)} ${escapeHtml(label)}
        <span class="muted"> · ${escapeHtml(sub)}</span></span>
      <span class="mono tabular">${escapeHtml(valueText)}</span>
    </div>
    <div class="progress"><span style="width:${width}%;background:${escapeHtml(color)}"></span></div>
  </div>`;
}
function categoryBars(d, cur) {
    const top = Math.max(...d.categories.map((c) => parseFloat(c.total)), 1);
    return d.categories.map((c) => {
        const total = parseFloat(c.total);
        return bar(c.name, total / top, money(total, cur), `${Math.round((total / (d.totals.spend || 1)) * 100)}% of spend`, c.color || '#6b7280');
    }).join('');
}
function dot(color) {
    return `<span style="display:inline-block;width:9px;height:9px;border-radius:50%;background:${escapeHtml(color)}"></span>`;
}
const pct = (r) => `${Math.round(r * 100)}%`;
const rateTone = (r) => (r >= 0.7 ? 'text-good' : r >= 0.4 ? 'text-warn' : 'text-bad');
function hours(minutes) {
    if (minutes < 60)
        return `${minutes} min`;
    return `${(minutes / 60).toFixed(1)} h`;
}
/** Weekday labels from the locale, Monday first (matching MySQL WEEKDAY()). */
function weekdayLabels() {
    // 2026-01-05 is a Monday; walking it gives correctly localised short names.
    return Array.from({ length: 7 }, (_, i) => new Date(2026, 0, 5 + i).toLocaleDateString(undefined, { weekday: 'short' }));
}
function busiestDay(d) {
    const top = d.weekday.reduce((a, b) => (b.total > a.total ? b : a), d.weekday[0]);
    if (!top || top.total <= 0)
        return 'no spending';
    return `${weekdayLabels()[top.dow]} highest`;
}
function busiestHour(d) {
    const top = d.hours.reduce((a, b) => (b.count > a.count ? b : a), d.hours[0]);
    if (!top || top.count <= 0)
        return 'no activity';
    return `busiest ${String(top.hour).padStart(2, '0')}:00`;
}
/* ------------------------------------------------------------------ charts */
function drawCharts(container, d, cur) {
    if (typeof Chart === 'undefined')
        return;
    for (const key of Object.keys(charts)) {
        charts[key]?.destroy();
        delete charts[key];
    }
    const c = palette();
    const axis = {
        x: { ticks: { color: c.text }, grid: { display: false } },
        y: { beginAtZero: true, ticks: { color: c.text }, grid: { color: c.grid } },
    };
    const noLegend = { legend: { display: false } };
    const make = (name, config) => {
        const el = container.querySelector(`[data-chart="${name}"]`);
        if (el)
            charts[name] = new Chart(el, config);
    };
    make('weekday', {
        type: 'bar',
        data: {
            labels: weekdayLabels(),
            datasets: [{ data: d.weekday.map((w) => w.total), backgroundColor: c.accent, borderRadius: 4 }],
        },
        options: {
            plugins: {
                ...noLegend,
                tooltip: { callbacks: { label: (i) => money(i.parsed.y, cur) } },
            },
            scales: axis,
        },
    });
    make('hours', {
        type: 'bar',
        data: {
            labels: d.hours.map((h) => (h.hour % 3 === 0 ? String(h.hour).padStart(2, '0') : '')),
            datasets: [{ data: d.hours.map((h) => h.count), backgroundColor: c.warn, borderRadius: 3 }],
        },
        options: {
            plugins: {
                ...noLegend,
                tooltip: {
                    callbacks: {
                        title: (items) => `${String(d.hours[items[0].dataIndex].hour).padStart(2, '0')}:00`,
                        label: (i) => `${i.parsed.y} actions`,
                    },
                },
            },
            scales: axis,
        },
    });
    const label = (p) => (d.granularity === 'month' ? fmtMonth(p.d) : fmtDate(p.d));
    make('focus', {
        type: 'bar',
        data: {
            labels: d.focus.map(label),
            datasets: [{ data: d.focus.map((p) => p.value), backgroundColor: c.good, borderRadius: 3 }],
        },
        options: {
            plugins: { ...noLegend, tooltip: { callbacks: { label: (i) => `${i.parsed.y} min` } } },
            scales: axis,
        },
    });
    make('velocity', {
        type: 'bar',
        data: {
            labels: d.velocity.map(label),
            datasets: [{ data: d.velocity.map((p) => p.value), backgroundColor: c.accent, borderRadius: 3 }],
        },
        options: {
            plugins: { ...noLegend, tooltip: { callbacks: { label: (i) => `${i.parsed.y} done` } } },
            scales: { ...axis, y: { ...axis.y, ticks: { ...axis.y.ticks, precision: 0 } } },
        },
    });
}
