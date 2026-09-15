/**
 * inphub: habits: today toggles, current/best streaks, 140-day heatmap.
 */
import { apiGet, apiPost } from './api.js?v=a03b746989';
import { escapeHtml, emptyState, toast, onAction, openModal, formValues, confirmDialog, localDate, flashFocused, fmtDate, confetti, } from './ui.js?v=a03b746989';
import { currentParams } from './app.js?v=a03b746989';
import { opts } from './todos.js?v=a03b746989';
/** Streak lengths worth celebrating, checked after each log. */
const MILESTONES = [7, 30, 100, 365];
export async function renderHabits(container) {
    container.innerHTML = `
    <div class="view-head">
      <div class="toolbar"><button class="btn btn-primary" data-action="new">+ Habit</button></div>
    </div>
    <div data-role="today"></div>
    <div data-role="list" style="margin-top:16px"></div>`;
    onAction(container, (action, el) => {
        const id = Number(el.dataset.id);
        if (action === 'new')
            openEditor(container, null);
        if (action === 'edit')
            openEditor(container, cache.find((h) => h.id === id) ?? null);
        if (action === 'toggle')
            toggle(container, id);
        if (action === 'day')
            toggle(container, id, el.dataset.date);
        if (action === 'delete')
            remove(container, id);
    });
    await load(container);
}
let cache = [];
async function load(container) {
    cache = await apiGet('habits', 'list');
    const active = cache.filter((h) => h.is_active);
    const today = container.querySelector('[data-role="today"]');
    const list = container.querySelector('[data-role="list"]');
    if (!cache.length) {
        today.innerHTML = '';
        list.innerHTML = emptyState('', 'No habits yet.');
        return;
    }
    today.innerHTML = `<div class="card"><div class="card-head"><h3>Today</h3></div>
    <div class="habit-chips">${active.map((h) => `
      <button class="habit-chip ${h.logged_today ? 'done' : ''}" data-action="toggle" data-id="${h.id}" style="${h.logged_today ? '' : `border-color:${escapeHtml(h.color || '#4f8cff')}55`}">
        <span>${h.logged_today ? '✓' : (h.icon ? escapeHtml(h.icon) : '○')}</span>
        <span>${escapeHtml(h.name)}</span>
        ${h.target > 1 ? `<span class="streak">${h.today_count}/${h.target}</span>` : ''}
        <span class="streak">${h.current_streak}d</span>
      </button>`).join('')}</div></div>`;
    list.innerHTML = `<div class="grid grid-2">${cache.map(habitCard).join('')}</div>`;
    // Arrived from search or history. Every habit is rendered, so there is no
    // filter to widen, a missing id just means it was deleted.
    flashFocused(container, currentParams().get('focus'));
}
function habitCard(h) {
    const counts = new Map(h.logs.map((l) => [l.logged_date, l.count]));
    return `<section class="card" data-row="${h.id}">
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
    ${heatmap(h, counts)}
    
  </section>`;
}
/**
 * A 20-week (140-day) heatmap, 7 rows tall, columns oldest→newest.
 *
 * Cells are clickable: the API has always accepted a `date`, so any missed day
 * can be filled in, previously the grid was inert and a missed day was
 * permanent. Partial days (count below target) use the `l1` intensity class,
 * which existed in the CSS with nothing ever emitting it.
 */
function heatmap(h, counts) {
    const cells = [];
    const start = new Date();
    start.setDate(start.getDate() - 139);
    const colour = h.color || '#22c55e';
    const target = Math.max(1, h.target);
    const today = localDate(new Date());
    for (let i = 0; i < 140; i++) {
        const d = new Date(start);
        d.setDate(start.getDate() + i);
        const key = localDate(d);
        const count = counts.get(key) ?? 0;
        const full = count >= target;
        const partial = count > 0 && !full;
        const label = fmtDate(key)
            + (count > 0 ? `, ${target > 1 ? `${count}/${target}` : 'done'}` : ', not logged')
            + (key === today ? ' (today)' : '');
        cells.push(`<i class="${full ? 'l2' : partial ? 'l1' : ''}" data-action="day" data-id="${h.id}"
      data-date="${key}" title="${escapeHtml(label)}"
      ${full ? `style="background:${escapeHtml(colour)}"` : ''}></i>`);
    }
    return `<div class="heatmap">${cells.join('')}</div>`;
}
async function toggle(container, id, date) {
    const before = cache.find((h) => h.id === id)?.current_streak ?? 0;
    try {
        const res = await apiPost('habits', 'log', date ? { id, date } : { id });
        await load(container);
        const after = cache.find((h) => h.id === id)?.current_streak ?? 0;
        // Only celebrate crossing a milestone, never merely sitting on one.
        const crossed = MILESTONES.find((m) => after >= m && before < m);
        if (crossed) {
            confetti();
            toast(`${crossed} day streak.`, 'good');
        }
        else if (res.target > 1 && res.logged) {
            toast(`${res.count}/${res.target} today.`, res.count >= res.target ? 'good' : '');
        }
    }
    catch (e) {
        toast(e instanceof Error ? e.message : 'Failed', 'bad');
    }
}
async function remove(container, id) {
    if (!(await confirmDialog('Delete this habit and its logs?')))
        return;
    try {
        await apiPost('habits', 'delete', { id });
        await load(container);
    }
    catch (e) {
        toast(e instanceof Error ? e.message : 'Failed', 'bad');
    }
}
function openEditor(container, h) {
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
            const payload = { ...v };
            if (h)
                payload.id = h.id;
            try {
                await apiPost('habits', h ? 'update' : 'create', payload);
                await load(container);
            }
            catch (e) {
                toast(e instanceof Error ? e.message : 'Failed', 'bad');
                return false;
            }
        },
    });
}
