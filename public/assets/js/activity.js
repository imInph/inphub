/**
 * inphub: activity history: a filterable timeline that links through to the
 * thing each row is about.
 */
import { apiGet } from './api.js?v=c10f314afe';
import { escapeHtml, timeAgo, fmtDate, emptyState, onAction, loadingState } from './ui.js?v=c10f314afe';
import { go } from './app.js?v=c10f314afe';
/**
 * Entity types that have somewhere to go. `log_activity` also writes `user`
 * (admin actions) and `brief` (AI output), which have no per-row destination,
 * so they stay plain text.
 */
const ENTITY_VIEWS = {
    todo: 'todos',
    expense: 'expenses',
    note: 'notes',
    habit: 'habits',
    goal: 'goals',
    repo: 'repos',
};
/** Readable labels for the machine tags stored in activity_log.type. */
const TYPE_LABELS = {
    'todo.created': 'task added', 'todo.updated': 'task edited',
    'todo.completed': 'task done', 'todo.deleted': 'task deleted',
    'expense.created': 'money logged', 'expense.updated': 'entry edited',
    'expense.deleted': 'entry deleted',
    'habit.logged': 'habit logged', 'habit.unlogged': 'habit unlogged',
    'habit.created': 'habit added',
    'goal.created': 'goal added', 'goal.progress': 'goal progress', 'goal.status': 'goal status',
    'note.created': 'note added', 'note.updated': 'note edited',
    'focus.completed': 'focus session',
    'repos.synced': 'repos synced', 'repo.suggestion': 'repo suggestion',
    'ai.brief': 'daily brief', 'ai.repo_analyzed': 'repo analysed',
    'auth.login': 'signed in', 'admin.user_active': 'account changed',
};
/** A deleted row's id points at nothing, never offer to navigate there. */
const DELETED_TYPES = ['todo.deleted', 'expense.deleted', 'note.deleted', 'habit.deleted'];
let actor = '';
let typeFilter = '';
let limit = 200;
export async function renderActivity(container) {
    container.innerHTML = `
    <div class="view-head">
      <div class="toolbar">
        <select data-role="actor" style="width:auto">
          <option value="">Everyone</option>
          <option value="user">Me</option>
          <option value="ai">AI</option>
          <option value="system">System</option>
        </select>
        <select data-role="type" style="width:auto"></select>
      </div>
    </div>
    <div class="card"><div data-role="list">${loadingState()}</div></div>`;
    const actorEl = container.querySelector('[data-role="actor"]');
    actorEl.value = actor;
    actorEl.addEventListener('change', () => {
        actor = actorEl.value;
        limit = 200;
        load(container);
    });
    const typeEl = container.querySelector('[data-role="type"]');
    typeEl.addEventListener('change', () => {
        typeFilter = typeEl.value;
        limit = 200;
        load(container);
    });
    // Delegated, idempotent (see CLAUDE.md): never addEventListener on #view-*.
    onAction(container, (action, el) => {
        if (action === 'open-entity') {
            const view = el.dataset.view;
            const id = el.dataset.entity;
            if (view && id)
                go(view, { focus: id });
        }
        if (action === 'more') {
            limit = Math.min(500, limit + 200);
            load(container);
        }
    });
    await load(container);
}
async function load(container) {
    const items = await apiGet('activity', 'list', {
        limit,
        ...(actor ? { actor } : {}),
        ...(typeFilter ? { type: typeFilter } : {}),
    });
    const list = container.querySelector('[data-role="list"]');
    syncTypeOptions(container, items);
    if (!items.length) {
        list.innerHTML = emptyState('', typeFilter || actor ? 'Nothing matches that filter.' : 'No activity recorded yet.');
        return;
    }
    // Group by calendar day.
    const groups = {};
    for (const a of items) {
        const day = a.created_at.slice(0, 10);
        (groups[day] ?? (groups[day] = [])).push(a);
    }
    const more = items.length >= limit && limit < 500
        ? `<div style="text-align:center"><button class="btn btn-sm" data-action="more">Load more</button></div>`
        : '';
    list.innerHTML = Object.entries(groups).map(([day, rows]) => `
    <div style="margin-bottom:14px">
      <div class="text-dim mono" style="margin-bottom:6px">${escapeHtml(fmtDate(day))}</div>
      <div class="list">${rows.map(row).join('')}</div>
    </div>`).join('') + more;
}
function row(a) {
    const view = a.entity_type ? ENTITY_VIEWS[a.entity_type] : undefined;
    // repos.synced stores a null entity_id, and deleted rows point at ids that
    // no longer exist, both must stay unclickable.
    const linkable = view !== undefined && a.entity_id !== null && !DELETED_TYPES.includes(a.type);
    const label = TYPE_LABELS[a.type] ?? a.type;
    const summary = linkable
        ? `<a class="grow act-link" data-action="open-entity" data-view="${escapeHtml(view)}"
          data-entity="${a.entity_id}" href="#${escapeHtml(view)}?focus=${a.entity_id}">${escapeHtml(a.summary)}</a>`
        : `<span class="grow">${escapeHtml(a.summary)}</span>`;
    return `<div class="row" style="border:none;background:none;padding:4px 0">
    <span class="chip" title="${escapeHtml(a.type)}">${icon(a.actor)} ${escapeHtml(label)}</span>
    ${summary}
    <span class="muted">${escapeHtml(timeAgo(a.created_at))}</span>
  </div>`;
}
/**
 * Populate the type filter from what the log actually contains, so it never
 * offers a type with zero rows. Rebuilt only when the option set changes, to
 * avoid resetting the user's selection on every load.
 */
function syncTypeOptions(container, items) {
    const el = container.querySelector('[data-role="type"]');
    if (!el)
        return;
    const types = [...new Set(items.map((a) => a.type))].sort();
    // Keep the active filter in the list even when the current page has none.
    if (typeFilter && !types.includes(typeFilter))
        types.push(typeFilter);
    const signature = types.join('|');
    if (el.dataset.sig === signature) {
        el.value = typeFilter;
        return;
    }
    el.dataset.sig = signature;
    el.innerHTML = `<option value="">All types</option>` + types.map((t) => `<option value="${escapeHtml(t)}">${escapeHtml(TYPE_LABELS[t] ?? t)}</option>`).join('');
    el.value = typeFilter;
}
function icon(actor) {
    return actor === 'ai' ? 'ai' : actor === 'system' ? 'sys' : '';
}
