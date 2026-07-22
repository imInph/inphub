/**
 * inphub — activity history: a filterable, read-only timeline.
 */
import { apiGet } from './api.js';
import { escapeHtml, timeAgo, fmtDate, emptyState } from './ui.js';
let actor = '';
export async function renderActivity(container) {
    container.innerHTML = `
    <div class="view-head"><h2>History</h2>
      <div class="toolbar">
        <select data-role="actor" style="width:auto">
          <option value="">Everyone</option>
          <option value="user">Me</option>
          <option value="ai">AI</option>
          <option value="system">System</option>
        </select>
      </div>
    </div>
    <div class="card"><div data-role="list"><div class="empty">Loading…</div></div></div>`;
    const actorEl = container.querySelector('[data-role="actor"]');
    actorEl.value = actor;
    actorEl.addEventListener('change', () => {
        actor = actorEl.value;
        load(container);
    });
    await load(container);
}
async function load(container) {
    const items = await apiGet('activity', 'list', { limit: 200, ...(actor ? { actor } : {}) });
    const list = container.querySelector('[data-role="list"]');
    if (!items.length) {
        list.innerHTML = emptyState('◷', 'No activity recorded yet.');
        return;
    }
    // Group by calendar day.
    const groups = {};
    for (const a of items) {
        const day = a.created_at.slice(0, 10);
        (groups[day] ?? (groups[day] = [])).push(a);
    }
    list.innerHTML = Object.entries(groups).map(([day, rows]) => `
    <div style="margin-bottom:14px">
      <div class="text-dim mono" style="margin-bottom:6px">${escapeHtml(fmtDate(day))}</div>
      <div class="list">${rows.map((a) => `
        <div class="row" style="border:none;background:none;padding:4px 0">
          <span class="chip">${icon(a.actor)} ${escapeHtml(a.type)}</span>
          <span class="grow">${escapeHtml(a.summary)}</span>
          <span class="muted">${escapeHtml(timeAgo(a.created_at))}</span>
        </div>`).join('')}</div>
    </div>`).join('');
}
function icon(actor) {
    return actor === 'ai' ? '🤖' : actor === 'system' ? '⚙️' : '·';
}
