/**
 * inphub — dashboard: a glanceable overview stitched from stats.php.
 */

import { apiGet, apiPost } from './api.js';
import { escapeHtml, money, fmtDate, timeAgo, markdown, emptyState, toast, onAction } from './ui.js';
import { go, aiAvailable } from './app.js';

interface DashTodo { id: number; title: string; priority: string; due_date: string | null; }
interface DashHabit { id: number; name: string; logged_today: number; }
interface DashCat { name: string; color: string | null; total: string; monthly_budget: string | null; }
interface DashGoal { id: number; title: string; current_value: number; target_value: number | null; unit: string | null; }
interface DashActivity { id: number; type: string; summary: string; actor: string; created_at: string; }
interface DashData {
  owner_name: string;
  currency: string;
  ai_enabled: boolean;
  todos: DashTodo[];
  habits: DashHabit[];
  money: { spent: number; income: number; top_categories: DashCat[]; month: string };
  repos: { stale_count: number; most_neglected: { name: string; full_name: string; staleness_days: number | null; health_score: number | null } | null };
  goals: DashGoal[];
  activity: DashActivity[];
}

export async function renderDashboard(container: HTMLElement): Promise<void> {
  container.innerHTML = `<div class="empty">Loading…</div>`;
  const d = await apiGet<DashData>('stats', 'dashboard');
  const cur = d.currency || 'TRY';

  container.innerHTML = `
    <div class="view-head"><h2>Dashboard</h2>
      <div class="toolbar"><span class="chip">${escapeHtml(d.money.month)}</span></div>
    </div>
    ${aiAvailable ? '<div data-role="brief" style="margin-bottom:16px"></div>' : ''}
    <div class="grid grid-dash">
      ${cardTodos(d.todos)}
      ${cardHabits(d.habits)}
      ${cardMoney(d.money, cur)}
      ${cardRepos(d.repos)}
      ${cardGoals(d.goals)}
      ${cardActivity(d.activity)}
    </div>`;

  onAction(container, (action, el) => {
    if (action === 'goto') go(el.dataset.view!);
    if (action === 'toggle-habit') toggleHabit(container, Number(el.dataset.id));
    if (action === 'gen-brief') generateBrief(container);
  });

  if (aiAvailable) loadBrief(container);
}

async function loadBrief(container: HTMLElement): Promise<void> {
  const host = container.querySelector<HTMLElement>('[data-role="brief"]');
  if (!host) return;
  try {
    const res = await apiGet<{ brief: { content: string } | null }>('ai', 'brief');
    host.innerHTML = briefCard(res.brief?.content ?? null);
  } catch {
    host.innerHTML = '';
  }
}

function briefCard(content: string | null): string {
  return `<section class="card">
    <div class="card-head"><h3>Daily brief</h3>
      <button class="btn btn-ghost btn-sm" data-action="gen-brief">${content ? '↻ Regenerate' : '✨ Generate'}</button>
    </div>
    ${content ? `<div class="md">${markdown(content)}</div>` : '<div class="text-dim">Generate an AI summary of your day.</div>'}
  </section>`;
}

async function generateBrief(container: HTMLElement): Promise<void> {
  const host = container.querySelector<HTMLElement>('[data-role="brief"]');
  if (!host) return;
  host.querySelector('.md, .text-dim')?.replaceChildren();
  host.querySelector('.card-head')?.insertAdjacentHTML('afterend', '<div class="text-dim" data-role="thinking">Thinking…</div>');
  try {
    const res = await apiPost<{ brief: { content: string } }>('ai', 'generate_brief', {});
    host.innerHTML = briefCard(res.brief.content);
  } catch (e) {
    toast(e instanceof Error ? e.message : 'Failed', 'bad');
    loadBrief(container);
  }
}

function cardTodos(todos: DashTodo[]): string {
  const body = todos.length
    ? `<div class="list">${todos.map((t) => `
        <div class="row">
          <span class="grow">${escapeHtml(t.title)}
            ${t.due_date ? `<span class="muted"> · ${escapeHtml(fmtDate(t.due_date))}</span>` : ''}</span>
          ${t.priority === 'urgent' || t.priority === 'high' ? `<span class="chip pri-${escapeHtml(t.priority)}">${escapeHtml(t.priority)}</span>` : ''}
        </div>`).join('')}</div>`
    : emptyState('✓', 'Nothing due. Clear runway.');
  return card('Due & overdue', 'todos', body);
}

function cardHabits(habits: DashHabit[]): string {
  const body = habits.length
    ? `<div class="habit-chips">${habits.map((h) => `
        <button class="habit-chip ${h.logged_today ? 'done' : ''}" data-action="toggle-habit" data-id="${h.id}">
          ${h.logged_today ? '✓' : '○'} ${escapeHtml(h.name)}
        </button>`).join('')}</div>`
    : emptyState('◎', 'No habits yet.');
  return card('Today’s habits', 'habits', body);
}

function cardMoney(m: DashData['money'], cur: string): string {
  const net = m.income - m.spent;
  const cats = m.top_categories.length
    ? `<div class="list" style="margin-top:12px">${m.top_categories.map((c) => {
        const total = parseFloat(c.total);
        const budget = c.monthly_budget ? parseFloat(c.monthly_budget) : null;
        const pct = budget ? Math.min(100, Math.round((total / budget) * 100)) : null;
        return `<div>
          <div class="row" style="border:none;padding:2px 0;background:none">
            <span class="grow">${dot(c.color)} ${escapeHtml(c.name)}</span>
            <span class="mono tabular">${escapeHtml(money(total, cur))}</span>
          </div>
          ${pct !== null ? `<div class="progress ${pct >= 100 ? 'over' : ''}"><span style="width:${pct}%"></span></div>` : ''}
        </div>`;
      }).join('')}</div>`
    : '';
  const body = `
    <div class="field-row">
      <div><small>Spent</small><div class="mono tabular text-bad" style="font-size:1.3rem">${escapeHtml(money(m.spent, cur))}</div></div>
      <div><small>Income</small><div class="mono tabular text-good" style="font-size:1.3rem">${escapeHtml(money(m.income, cur))}</div></div>
      <div><small>Net</small><div class="mono tabular" style="font-size:1.3rem">${escapeHtml(money(net, cur))}</div></div>
    </div>${cats}`;
  return card('This month', 'expenses', body);
}

function cardRepos(r: DashData['repos']): string {
  const neglected = r.most_neglected;
  const body = `
    <div class="field-row">
      <div><small>Stale repos</small><div style="font-size:1.6rem;font-weight:700">${r.stale_count}</div></div>
      ${neglected ? `<div style="flex:2 1 200px"><small>Most neglected</small>
        <div>${escapeHtml(neglected.name)}
          <span class="muted">${neglected.staleness_days !== null ? `· ${neglected.staleness_days}d idle` : ''}</span></div></div>` : ''}
    </div>`;
  return card('Repositories', 'repos', body);
}

function cardGoals(goals: DashGoal[]): string {
  const body = goals.length
    ? `<div class="list">${goals.map((g) => {
        const pct = g.target_value ? Math.min(100, Math.round((g.current_value / g.target_value) * 100)) : 0;
        return `<div>
          <div class="row" style="border:none;padding:2px 0;background:none">
            <span class="grow">${escapeHtml(g.title)}</span>
            <span class="muted mono">${g.current_value}${g.target_value ? '/' + g.target_value : ''} ${escapeHtml(g.unit ?? '')}</span>
          </div>
          ${g.target_value ? `<div class="progress"><span style="width:${pct}%"></span></div>` : ''}
        </div>`;
      }).join('')}</div>`
    : emptyState('◇', 'No active goals.');
  return card('Goals', 'goals', body);
}

function cardActivity(items: DashActivity[]): string {
  const body = items.length
    ? `<div class="list">${items.map((a) => `
        <div class="row" style="border:none;padding:4px 0;background:none">
          <span class="grow">${escapeHtml(a.summary)}</span>
          <span class="muted">${a.actor === 'ai' ? '🤖 ' : ''}${escapeHtml(timeAgo(a.created_at))}</span>
        </div>`).join('')}</div>`
    : emptyState('◷', 'No activity yet.');
  return card('Recent activity', 'activity', body);
}

/* ---------------------------------------------------------------- helpers */

function card(title: string, view: string, body: string): string {
  return `<section class="card">
    <div class="card-head"><h3>${escapeHtml(title)}</h3>
      <button class="btn btn-ghost btn-sm" data-action="goto" data-view="${escapeHtml(view)}">Open →</button></div>
    ${body}
  </section>`;
}

function dot(color: string | null): string {
  return `<span style="display:inline-block;width:9px;height:9px;border-radius:50%;background:${escapeHtml(color || '#6b7280')}"></span>`;
}

async function toggleHabit(container: HTMLElement, id: number): Promise<void> {
  try {
    await apiPost('habits', 'log', { id });
    renderDashboard(container);
  } catch (e) {
    toast(e instanceof Error ? e.message : 'Failed', 'bad');
  }
}
