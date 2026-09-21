/**
 * inphub: repositories: synced from GitHub, sorted by staleness, health badge,
 * pin, detail drawer with README + AI suggestions (suggestions surfaced in P2).
 */
import { apiGet, apiPost } from './api.js?v=42714d0ded';
import { escapeHtml, fmtDate, timeAgo, markdown, emptyState, toast, onAction, openModal, confirmDialog, flashFocused, loadingState, } from './ui.js?v=42714d0ded';
import { aiAvailable, currentParams } from './app.js?v=42714d0ded';
let staleDays = 60;
let cache = [];
/** Free-text filter over the loaded repos (name, description, language). */
let repoFilter = '';
export async function renderRepos(container) {
    container.innerHTML = `
    <div class="view-head">
      <div class="toolbar">
        <input type="search" data-role="search" placeholder="Filter repos…" style="width:180px">
        ${aiAvailable ? `<button class="btn" data-action="analyze-stale" title="Runs AI analysis on every repo untouched for ${staleDays}+ days and saves suggestions to each repo's Details.">Analyze stale</button>` : ''}
        <button class="btn btn-primary" data-action="sync">Sync from GitHub</button>
      </div>
    </div>
    <div data-role="grid">${loadingState()}</div>`;
    const searchEl = container.querySelector('[data-role="search"]');
    searchEl.value = repoFilter;
    searchEl.addEventListener('input', () => {
        repoFilter = searchEl.value.trim();
        render(container);
    });
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
    const res = await apiGet('repos', 'list');
    staleDays = res.stale_repo_days;
    cache = res.repos;
    render(container);
}
/** Paint the cached repos through the text filter. */
function render(container) {
    const grid = container.querySelector('[data-role="grid"]');
    if (!grid)
        return;
    if (!cache.length) {
        grid.innerHTML = emptyState('', 'No repos yet. Add a GitHub username in Settings, then sync.');
        return;
    }
    const q = repoFilter.toLowerCase();
    const shown = q
        ? cache.filter((r) => `${r.full_name} ${r.description ?? ''} ${r.language ?? ''}`.toLowerCase().includes(q))
        : cache;
    grid.innerHTML = shown.length
        ? `<div class="grid grid-3">${shown.map(card).join('')}</div>`
        : emptyState('', 'No repos match that filter.');
    flashFocused(container, currentParams().get('focus'));
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
    return `<section class="card repo-card" data-row="${r.id}">
    <div class="card-head">
      <h3>${escapeHtml(r.name)} ${r.pinned ? '📌' : ''}</h3>
      <span class="health-ring ${healthClass(r.health_score)}">${r.health_score ?? '-'}</span>
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
        btn.textContent = 'Sync from GitHub';
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
        <span class="health-ring ${healthClass(r.health_score)}">Health ${r.health_score ?? '-'}</span>
        ${r.language ? `<span>${escapeHtml(r.language)}</span>` : ''}
        <span>★ ${r.stars}</span><span>⑂ ${r.forks}</span>
        ${r.last_pushed_at ? `<span>pushed ${escapeHtml(fmtDate(r.last_pushed_at))}</span>` : ''}
      </div>
      <p>${escapeHtml(r.description ?? '')}</p>
      ${r.readme_excerpt ? `<div class="md" style="max-height:36vh;overflow:auto;border-top:1px solid var(--border);padding-top:12px">${markdown(r.readme_excerpt)}</div>` : ''}
      <div class="card-head" style="margin-top:16px">
        <h3 style="margin:0">Suggestions</h3>
        ${aiAvailable ? `<button class="btn btn-sm" data-role="analyze">Analyze</button>
          <button class="btn btn-sm" data-role="reanalyze" title="Ignore the cooldown">Re-analyze</button>` : ''}
      </div>
      <div data-role="suggestions">${suggestionList(res.suggestions)}</div>`,
    });
    const box = root.querySelector('[data-role="suggestions"]');
    const analyze = async (btn, force) => {
        btn.disabled = true;
        const label = btn.textContent;
        btn.textContent = 'Analyzing…';
        try {
            const out = await apiPost('ai', 'analyze_repo', force ? { repo_id: id, force: '1' } : { repo_id: id });
            box.innerHTML = suggestionList(out.suggestions);
            if (out.cached) {
                // The API has always accepted force=1; there was no way to ask for it.
                toast(`Showing a cached analysis from ${out.analyzed_at.slice(0, 16)}. Use Re-analyze for a fresh one.`, '');
            }
        }
        catch (err) {
            toast(err instanceof Error ? err.message : 'Analysis failed', 'bad');
        }
        finally {
            btn.disabled = false;
            btn.textContent = label;
        }
    };
    root.querySelector('[data-role="analyze"]')
        ?.addEventListener('click', (e) => void analyze(e.currentTarget, false));
    root.querySelector('[data-role="reanalyze"]')
        ?.addEventListener('click', (e) => void analyze(e.currentTarget, true));
    // One delegated handler on the modal body, the suggestion list is replaced
    // in place after every analyze, so per-button listeners would be lost.
    root.querySelector('.modal-body').addEventListener('click', async (e) => {
        const el = e.target;
        const statusBtn = el.closest('[data-sug]');
        const todoBtn = el.closest('[data-sug-todo]');
        if (statusBtn) {
            try {
                await apiPost('repos', 'suggestion_status', {
                    id: Number(statusBtn.dataset.sug), status: statusBtn.dataset.status,
                });
                const fresh = await apiGet('repos', 'detail', { id });
                box.innerHTML = suggestionList(fresh.suggestions);
            }
            catch (err) {
                toast(err instanceof Error ? err.message : 'Failed', 'bad');
            }
        }
        else if (todoBtn) {
            const sug = Number(todoBtn.dataset.sugTodo);
            const item = (await apiGet('repos', 'detail', { id })).suggestions
                .find((x) => x.id === sug);
            if (!item)
                return;
            try {
                // Both endpoints existed; nothing ever bridged a suggestion to a task.
                await apiPost('todos', 'create', {
                    title: item.title,
                    description: item.detail,
                    project: r.name,
                    priority: item.priority === 'high' ? 'high' : 'medium',
                });
                await apiPost('repos', 'suggestion_status', { id: sug, status: 'done' });
                const fresh = await apiGet('repos', 'detail', { id });
                box.innerHTML = suggestionList(fresh.suggestions);
                toast(`Added "${item.title}" to your tasks.`, 'good');
                window.dispatchEvent(new CustomEvent('inphub:data-changed'));
            }
            catch (err) {
                toast(err instanceof Error ? err.message : 'Failed', 'bad');
            }
        }
    });
}
function suggestionList(items) {
    if (!items.length) {
        return `<p class="text-dim" style="margin-top:8px">${aiAvailable ? 'No suggestions yet.' : 'Enable AI in Settings to get suggestions.'}</p>`;
    }
    // The open→done→dismissed lifecycle existed in the schema and the API
    // (?action=suggestion_status) with no caller at all, so a suggestion list
    // could only ever grow and done items looked identical to open ones.
    return `<div class="list">${items.map((s) => `
    <div class="row" style="${s.status === 'open' ? '' : 'opacity:.55'}">
      <span class="grow"><strong>${escapeHtml(s.title)}</strong>
        ${s.detail ? `<div class="muted">${escapeHtml(s.detail)}</div>` : ''}</span>
      <span class="chip">${escapeHtml(s.category)}</span>
      <span class="chip pri-${escapeHtml(s.priority)}">${escapeHtml(s.priority)}</span>
      ${s.status === 'open' ? `
        <span class="row-actions" style="opacity:1">
          <button class="btn btn-ghost btn-sm" data-sug-todo="${s.id}" title="Add as a task">＋ task</button>
          <button class="btn btn-ghost btn-sm" data-sug="${s.id}" data-status="done" title="Mark done">✓</button>
          <button class="btn btn-ghost btn-sm" data-sug="${s.id}" data-status="dismissed" title="Dismiss">✕</button>
        </span>`
        : `<span class="badge ${s.status === 'done' ? 'badge-good' : 'badge-warn'}">${escapeHtml(s.status)}</span>
         <button class="btn btn-ghost btn-sm" data-sug="${s.id}" data-status="open" title="Reopen">↺</button>`}
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
        // Results live in each repo's Details drawer, reload so the grid reflects them.
        await load(container);
    }
    catch (e) {
        toast(e instanceof Error ? e.message : 'Failed', 'bad');
    }
    finally {
        const b = container.querySelector('[data-action="analyze-stale"]');
        if (b) {
            b.disabled = false;
            b.textContent = 'Analyze stale';
        }
    }
}
