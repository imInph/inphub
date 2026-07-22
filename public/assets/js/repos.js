/**
 * inphub — repositories: synced from GitHub, sorted by staleness, health badge,
 * pin, detail drawer with README + AI suggestions (suggestions surfaced in P2).
 */
import { apiGet, apiPost } from './api.js';
import { escapeHtml, fmtDate, timeAgo, markdown, emptyState, toast, onAction, openModal, confirmDialog, } from './ui.js';
import { aiAvailable } from './app.js';
let staleDays = 60;
export async function renderRepos(container) {
    container.innerHTML = `
    <div class="view-head">
      <h2>Repositories</h2>
      <div class="toolbar">
        ${aiAvailable ? `<button class="btn" data-action="analyze-stale" title="Runs AI analysis on every repo untouched for ${staleDays}+ days and saves suggestions to each repo's Details.">✨ Analyze stale</button>` : ''}
        <button class="btn btn-primary" data-action="sync">↻ Sync from GitHub</button>
      </div>
    </div>
    <div data-role="grid"><div class="empty">Loading…</div></div>`;
    onAction(container, (action, el) => {
        const id = Number(el.dataset.id);
        if (action === 'sync')
            sync(container);
        if (action === 'pin')
            pin(container, id);
        if (action === 'detail')
            openDetail(id);
        if (action === 'delete')
            remove(container, id);
        if (action === 'analyze-stale')
            analyzeStale(container);
    });
    await load(container);
}
async function load(container) {
    const grid = container.querySelector('[data-role="grid"]');
    const res = await apiGet('repos', 'list');
    staleDays = res.stale_repo_days;
    if (!res.repos.length) {
        grid.innerHTML = emptyState('⌥', 'No repos yet — add a GitHub username in Settings, then Sync.');
        return;
    }
    grid.innerHTML = `<div class="grid grid-3">${res.repos.map(card).join('')}</div>`;
}
function healthClass(score) {
    if (score === null)
        return 'text-dim';
    if (score >= 70)
        return 'text-good';
    if (score >= 40)
        return 'text-dim';
    return 'text-bad';
}
function card(r) {
    const meta = [];
    if (r.language)
        meta.push(escapeHtml(r.language));
    meta.push('★ ' + r.stars);
    if (r.open_issues)
        meta.push(r.open_issues + ' issues');
    return `<section class="card repo-card">
    <div class="card-head">
      <h3>${escapeHtml(r.name)} ${r.pinned ? '📌' : ''}</h3>
      <span class="health-ring ${healthClass(r.health_score)}">${r.health_score ?? '—'}</span>
    </div>
    <div class="text-dim" style="min-height:2.6em">${escapeHtml(r.description ?? 'No description.')}</div>
    <div class="repo-meta">${meta.join(' · ')}</div>
    <div class="repo-meta">
      ${r.last_pushed_at ? `pushed ${escapeHtml(timeAgo(r.last_pushed_at))}` : 'never pushed'}
      ${r.is_stale ? '<span class="badge badge-warn">stale</span>' : ''}
      ${r.is_archived ? '<span class="badge badge-bad">archived</span>' : ''}
      ${r.has_license ? '<span class="chip">licensed</span>' : ''}
    </div>
    <div class="row-actions" style="opacity:1;margin-top:6px">
      <button class="btn btn-ghost btn-sm" data-action="detail" data-id="${r.id}">Details</button>
      <button class="btn btn-ghost btn-sm" data-action="pin" data-id="${r.id}">${r.pinned ? 'Unpin' : 'Pin'}</button>
      ${r.url ? `<a class="btn btn-ghost btn-sm" href="${escapeHtml(r.url)}" target="_blank" rel="noopener">GitHub ↗</a>` : ''}
      <button class="btn btn-ghost btn-sm" data-action="delete" data-id="${r.id}">✕</button>
    </div>
  </section>`;
}
async function sync(container) {
    const btn = container.querySelector('[data-action="sync"]');
    btn.disabled = true;
    btn.textContent = 'Syncing…';
    try {
        const res = await apiPost('sync_repos', 'sync', {});
        toast(`Synced ${res.synced ?? ''} repos.`, 'good');
        await load(container);
    }
    catch (e) {
        toast(e instanceof Error ? e.message : 'Sync failed', 'bad');
    }
    finally {
        btn.disabled = false;
        btn.textContent = '↻ Sync from GitHub';
    }
}
async function pin(container, id) {
    try {
        await apiPost('repos', 'pin', { id });
        load(container);
    }
    catch (e) {
        toast(e instanceof Error ? e.message : 'Failed', 'bad');
    }
}
async function remove(container, id) {
    if (!(await confirmDialog('Remove this repo from inphub? (Re-sync re-adds it.)')))
        return;
    try {
        await apiPost('repos', 'delete', { id });
        load(container);
    }
    catch (e) {
        toast(e instanceof Error ? e.message : 'Failed', 'bad');
    }
}
async function openDetail(id) {
    const res = await apiGet('repos', 'detail', { id });
    const r = res.repo;
    const root = openModal({
        title: r.full_name,
        cancelLabel: 'Close',
        confirmLabel: 'Close',
        bodyHtml: `
      <div class="repo-meta">
        <span class="health-ring ${healthClass(r.health_score)}">Health ${r.health_score ?? '—'}</span>
        ${r.language ? `<span>${escapeHtml(r.language)}</span>` : ''}
        <span>★ ${r.stars}</span><span>⑂ ${r.forks}</span>
        ${r.last_pushed_at ? `<span>pushed ${escapeHtml(fmtDate(r.last_pushed_at))}</span>` : ''}
      </div>
      <p>${escapeHtml(r.description ?? '')}</p>
      ${r.readme_excerpt ? `<div class="md" style="max-height:36vh;overflow:auto;border-top:1px solid var(--border);padding-top:12px">${markdown(r.readme_excerpt)}</div>` : ''}
      <div class="card-head" style="margin-top:16px">
        <h3 style="margin:0">Suggestions</h3>
        ${aiAvailable ? `<button class="btn btn-sm" data-role="analyze">✨ Analyze</button>` : ''}
      </div>
      <div data-role="suggestions">${suggestionList(res.suggestions)}</div>`,
    });
    const box = root.querySelector('[data-role="suggestions"]');
    root.querySelector('[data-role="analyze"]')?.addEventListener('click', async (e) => {
        const btn = e.currentTarget;
        btn.disabled = true;
        btn.textContent = 'Analyzing…';
        try {
            const out = await apiPost('ai', 'analyze_repo', { repo_id: id });
            box.innerHTML = suggestionList(out.suggestions);
            if (out.cached) {
                toast(`Showing cached analysis from ${out.analyzed_at.slice(0, 16)} — analysis re-runs after the cooldown.`, '');
            }
        }
        catch (err) {
            toast(err instanceof Error ? err.message : 'Analysis failed', 'bad');
        }
        finally {
            btn.disabled = false;
            btn.textContent = '✨ Analyze';
        }
    });
}
function suggestionList(items) {
    if (!items.length) {
        return `<p class="text-dim" style="margin-top:8px">${aiAvailable ? 'No suggestions yet — click Analyze.' : 'Enable AI in Settings to get suggestions.'}</p>`;
    }
    return `<div class="list">${items.map((s) => `
    <div class="row">
      <span class="grow"><strong>${escapeHtml(s.title)}</strong>
        ${s.detail ? `<div class="muted">${escapeHtml(s.detail)}</div>` : ''}</span>
      <span class="chip">${escapeHtml(s.category)}</span>
      <span class="chip pri-${escapeHtml(s.priority)}">${escapeHtml(s.priority)}</span>
    </div>`).join('')}</div>`;
}
async function analyzeStale(container) {
    const btn = container.querySelector('[data-action="analyze-stale"]');
    if (btn) {
        btn.disabled = true;
        btn.textContent = 'Analyzing…';
    }
    try {
        const res = await apiPost('ai', 'analyze_stale', {});
        const parts = [`Analyzed ${res.analyzed} stale repos`];
        if (res.skipped)
            parts.push(`${res.skipped} recently analyzed (skipped)`);
        if (res.failed)
            parts.push(`${res.failed} failed`);
        toast(parts.join(' · ') + '.', res.failed ? 'bad' : 'good');
        // Results live in each repo's Details drawer — reload so the grid reflects them.
        await load(container);
    }
    catch (e) {
        toast(e instanceof Error ? e.message : 'Failed', 'bad');
    }
    finally {
        const b = container.querySelector('[data-action="analyze-stale"]');
        if (b) {
            b.disabled = false;
            b.textContent = '✨ Analyze stale';
        }
    }
}
