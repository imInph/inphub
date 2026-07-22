/**
 * inphub — dashboard: a glanceable overview stitched from stats.php.
 */
import { apiGet, apiPost } from './api.js';
import { escapeHtml, money, fmtDate, timeAgo, markdown, emptyState, toast, onAction, openModal, formValues, } from './ui.js';
import { go, aiAvailable } from './app.js';
let shortcuts = [];
export async function renderDashboard(container) {
    container.innerHTML = `<div class="empty">Loading…</div>`;
    const d = await apiGet('stats', 'dashboard');
    const cur = d.currency || 'TRY';
    shortcuts = Array.isArray(d.shortcuts) ? d.shortcuts : [];
    container.innerHTML = `
    <div class="view-head"><h2>Dashboard</h2>
      <div class="toolbar"><span class="chip">${escapeHtml(d.money.month)}</span></div>
    </div>
    <form class="dash-search" action="https://www.google.com/search" method="get" target="_self">
      <input type="text" name="q" placeholder="Search Google…" autocomplete="off" spellcheck="false" data-role="search">
    </form>
    ${aiAvailable ? '<div data-role="brief" style="margin-bottom:16px"></div>' : ''}
    <div class="grid grid-dash">
      ${cardTodos(d.todos)}
      ${cardHabits(d.habits)}
      ${cardMoney(d.money, cur)}
      ${cardRepos(d.repos)}
      ${cardGoals(d.goals)}
      ${cardActivity(d.activity)}
    </div>
    <section style="margin-top:20px">
      <div class="view-head" style="margin-bottom:12px">
        <h3 style="margin:0">Shortcuts</h3>
        <button class="btn btn-sm" data-action="add-shortcut">+ Add site</button>
      </div>
      <div class="shortcuts" data-role="shortcuts">${renderShortcuts()}</div>
    </section>`;
    onAction(container, (action, el, ev) => {
        if (action === 'goto')
            go(el.dataset.view);
        if (action === 'toggle-habit')
            toggleHabit(container, Number(el.dataset.id));
        if (action === 'gen-brief')
            generateBrief(container);
        if (action === 'add-shortcut')
            addShortcut(container);
        if (action === 'del-shortcut') {
            ev.preventDefault();
            ev.stopPropagation();
            removeShortcut(container, Number(el.dataset.idx));
        }
    });
    if (aiAvailable)
        loadBrief(container);
}
/* -------------------------------------------------------------- shortcuts */
function renderShortcuts() {
    const tiles = shortcuts.map((s, i) => {
        let host = '';
        try {
            host = new URL(s.url).hostname;
        }
        catch {
            host = '';
        }
        const fav = host
            ? `<span class="fav"><img src="https://www.google.com/s2/favicons?domain=${encodeURIComponent(host)}&sz=64"
           alt="" onerror="this.remove()"></span>`
            : `<span class="fav">${escapeHtml((s.name[0] || '?').toUpperCase())}</span>`;
        return `<a class="shortcut" href="${escapeHtml(s.url)}" target="_blank" rel="noopener" title="${escapeHtml(s.url)}">
      ${fav}
      <span class="sc-name">${escapeHtml(s.name)}</span>
      <button class="shortcut-del" data-action="del-shortcut" data-idx="${i}" title="Remove">✕</button>
    </a>`;
    });
    tiles.push(`<button class="shortcut shortcut-add" data-action="add-shortcut" title="Add shortcut">＋</button>`);
    return tiles.join('');
}
function addShortcut(container) {
    openModal({
        title: 'Add shortcut',
        confirmLabel: 'Add',
        bodyHtml: `
      <label><span>Name</span><input name="name" placeholder="GitHub" autocomplete="off"></label>
      <label><span>URL</span><input name="url" placeholder="github.com" autocomplete="off"></label>`,
        onConfirm: async (root) => {
            const v = formValues(root);
            const name = v.name.trim();
            let url = v.url.trim();
            if (!name || !url) {
                toast('Name and URL are required.', 'bad');
                return false;
            }
            if (!/^https?:\/\//i.test(url))
                url = 'https://' + url;
            shortcuts.push({ name, url });
            await saveShortcuts(container);
        },
    });
}
async function removeShortcut(container, idx) {
    if (idx < 0 || idx >= shortcuts.length)
        return;
    shortcuts.splice(idx, 1);
    await saveShortcuts(container);
}
async function saveShortcuts(container) {
    const host = container.querySelector('[data-role="shortcuts"]');
    if (host)
        host.innerHTML = renderShortcuts();
    try {
        await apiPost('settings', 'save', { settings: { dashboard_shortcuts: JSON.stringify(shortcuts) } });
    }
    catch (e) {
        toast(e instanceof Error ? e.message : 'Could not save shortcuts', 'bad');
    }
}
async function loadBrief(container) {
    const host = container.querySelector('[data-role="brief"]');
    if (!host)
        return;
    try {
        const res = await apiGet('ai', 'brief');
        host.innerHTML = briefCard(res.brief?.content ?? null);
    }
    catch {
        host.innerHTML = '';
    }
}
function briefCard(content) {
    return `<section class="card">
    <div class="card-head"><h3>Daily brief</h3>
      <button class="btn btn-ghost btn-sm" data-action="gen-brief">${content ? '↻ Regenerate' : '✨ Generate'}</button>
    </div>
    ${content ? `<div class="md">${markdown(content)}</div>` : '<div class="text-dim">Generate an AI summary of your day.</div>'}
  </section>`;
}
async function generateBrief(container) {
    const host = container.querySelector('[data-role="brief"]');
    if (!host)
        return;
    host.querySelector('.md, .text-dim')?.replaceChildren();
    host.querySelector('.card-head')?.insertAdjacentHTML('afterend', '<div class="text-dim" data-role="thinking">Thinking…</div>');
    try {
        const res = await apiPost('ai', 'generate_brief', {});
        host.innerHTML = briefCard(res.brief.content);
    }
    catch (e) {
        toast(e instanceof Error ? e.message : 'Failed', 'bad');
        loadBrief(container);
    }
}
function cardTodos(todos) {
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
function cardHabits(habits) {
    const body = habits.length
        ? `<div class="habit-chips">${habits.map((h) => `
        <button class="habit-chip ${h.logged_today ? 'done' : ''}" data-action="toggle-habit" data-id="${h.id}">
          ${h.logged_today ? '✓' : '○'} ${escapeHtml(h.name)}
        </button>`).join('')}</div>`
        : emptyState('◎', 'No habits yet.');
    return card('Today’s habits', 'habits', body);
}
function cardMoney(m, cur) {
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
function cardRepos(r) {
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
function cardGoals(goals) {
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
function cardActivity(items) {
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
function card(title, view, body) {
    return `<section class="card">
    <div class="card-head"><h3>${escapeHtml(title)}</h3>
      <button class="btn btn-ghost btn-sm" data-action="goto" data-view="${escapeHtml(view)}">Open →</button></div>
    ${body}
  </section>`;
}
function dot(color) {
    return `<span style="display:inline-block;width:9px;height:9px;border-radius:50%;background:${escapeHtml(color || '#6b7280')}"></span>`;
}
async function toggleHabit(container, id) {
    try {
        await apiPost('habits', 'log', { id });
        renderDashboard(container);
    }
    catch (e) {
        toast(e instanceof Error ? e.message : 'Failed', 'bad');
    }
}
