/**
 * inphub — habits: today toggles, current/best streaks, 140-day heatmap.
 */

import { apiGet, apiPost } from './api.js';
import {
  escapeHtml, emptyState, toast, onAction, openModal, formValues, confirmDialog, localDate,
} from './ui.js';
import { opts } from './todos.js';

interface HabitLog { habit_id: number; logged_date: string; count: number; }
interface Habit {
  id: number; name: string; description: string | null; frequency: string;
  target_per_period: number; color: string | null; icon: string | null;
  is_active: number; sort_order: number; logs: HabitLog[];
  logged_today: boolean; current_streak: number; best_streak: number;
}

export async function renderHabits(container: HTMLElement): Promise<void> {
  container.innerHTML = `
    <div class="view-head"><h2>Habits</h2>
      <div class="toolbar"><button class="btn btn-primary" data-action="new">+ Habit</button></div>
    </div>
    <div data-role="today"></div>
    <div data-role="list" style="margin-top:16px"></div>`;

  onAction(container, (action, el) => {
    const id = Number(el.dataset.id);
    if (action === 'new') openEditor(container, null);
    if (action === 'edit') openEditor(container, cache.find((h) => h.id === id) ?? null);
    if (action === 'toggle') toggle(container, id);
    if (action === 'delete') remove(container, id);
  });

  await load(container);
}

let cache: Habit[] = [];

async function load(container: HTMLElement): Promise<void> {
  cache = await apiGet<Habit[]>('habits', 'list');
  const active = cache.filter((h) => h.is_active);
  const today = container.querySelector<HTMLElement>('[data-role="today"]')!;
  const list = container.querySelector<HTMLElement>('[data-role="list"]')!;

  if (!cache.length) {
    today.innerHTML = '';
    list.innerHTML = emptyState('◎', 'No habits yet — add one to start a streak.');
    return;
  }

  today.innerHTML = `<div class="card"><div class="card-head"><h3>Today</h3></div>
    <div class="habit-chips">${active.map((h) => `
      <button class="habit-chip ${h.logged_today ? 'done' : ''}" data-action="toggle" data-id="${h.id}" style="${h.logged_today ? '' : `border-color:${escapeHtml(h.color || '#4f8cff')}55`}">
        <span>${h.logged_today ? '✓' : (h.icon ? escapeHtml(h.icon) : '○')}</span>
        <span>${escapeHtml(h.name)}</span>
        <span class="streak">🔥${h.current_streak}</span>
      </button>`).join('')}</div></div>`;

  list.innerHTML = `<div class="grid grid-2">${cache.map(habitCard).join('')}</div>`;
}

function habitCard(h: Habit): string {
  const logged = new Set(h.logs.map((l) => l.logged_date));
  return `<section class="card">
    <div class="card-head">
      <h3>${h.icon ? escapeHtml(h.icon) + ' ' : ''}${escapeHtml(h.name)} ${h.is_active ? '' : '<span class="chip">paused</span>'}</h3>
      <span class="row-actions" style="opacity:1">
        <button class="btn btn-ghost btn-sm" data-action="edit" data-id="${h.id}">Edit</button>
        <button class="btn btn-ghost btn-sm" data-action="delete" data-id="${h.id}">✕</button>
      </span>
    </div>
    ${h.description ? `<div class="text-dim">${escapeHtml(h.description)}</div>` : ''}
    <div class="repo-meta" style="margin:6px 0">
      <span>Current <strong>${h.current_streak}</strong></span>
      <span>Best <strong>${h.best_streak}</strong></span>
      <span class="text-dim">${escapeHtml(h.frequency)}${h.target_per_period > 1 ? ` ×${h.target_per_period}` : ''}</span>
    </div>
    ${heatmap(logged, h.color)}
  </section>`;
}

/** A 20-week (140-day) heatmap, 7 rows tall, columns oldest→newest. */
function heatmap(logged: Set<string>, color: string | null): string {
  const cells: string[] = [];
  const start = new Date();
  start.setDate(start.getDate() - 139);
  const c = color || '#22c55e';
  for (let i = 0; i < 140; i++) {
    const d = new Date(start);
    d.setDate(start.getDate() + i);
    const key = localDate(d);
    const on = logged.has(key);
    cells.push(`<i class="${on ? 'l2' : ''}" title="${key}" ${on ? `style="background:${escapeHtml(c)}"` : ''}></i>`);
  }
  return `<div class="heatmap">${cells.join('')}</div>`;
}

async function toggle(container: HTMLElement, id: number): Promise<void> {
  try {
    await apiPost('habits', 'log', { id });
    await load(container);
  } catch (e) {
    toast(e instanceof Error ? e.message : 'Failed', 'bad');
  }
}

async function remove(container: HTMLElement, id: number): Promise<void> {
  if (!(await confirmDialog('Delete this habit and its logs?'))) return;
  try {
    await apiPost('habits', 'delete', { id });
    await load(container);
  } catch (e) {
    toast(e instanceof Error ? e.message : 'Failed', 'bad');
  }
}

function openEditor(container: HTMLElement, h: Habit | null): void {
  openModal({
    title: h ? 'Edit habit' : 'New habit',
    confirmLabel: h ? 'Save' : 'Create',
    bodyHtml: `
      <label><span>Name</span><input name="name" value="${escapeHtml(h?.name ?? '')}" required></label>
      <label><span>Description</span><input name="description" value="${escapeHtml(h?.description ?? '')}"></label>
      <div class="field-row">
        <label><span>Frequency</span><select name="frequency">${opts(['daily', 'weekly'], h?.frequency ?? 'daily')}</select></label>
        <label><span>Target / period</span><input name="target_per_period" type="number" min="1" value="${escapeHtml(String(h?.target_per_period ?? 1))}"></label>
      </div>
      <div class="field-row">
        <label><span>Colour</span><input name="color" type="color" value="${escapeHtml(h?.color ?? '#4f8cff')}"></label>
        <label><span>Icon (emoji)</span><input name="icon" value="${escapeHtml(h?.icon ?? '')}" maxlength="4"></label>
      </div>
      ${h ? `<label class="checkbox"><input type="checkbox" name="is_active" ${h.is_active ? 'checked' : ''}><span>Active</span></label>` : ''}`,
    onConfirm: async (root) => {
      const v = formValues(root);
      if (!v.name.trim()) {
        toast('Name is required.', 'bad');
        return false;
      }
      const payload: Record<string, unknown> = { ...v };
      if (h) payload.id = h.id;
      try {
        await apiPost('habits', h ? 'update' : 'create', payload);
        await load(container);
      } catch (e) {
        toast(e instanceof Error ? e.message : 'Failed', 'bad');
        return false;
      }
    },
  });
}
