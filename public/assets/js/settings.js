/**
 * inphub — settings: profile, currency, GitHub, stale threshold, AI provider,
 * and (admins only) an account management panel. Secrets arrive masked and are
 * only re-sent when the user actually types a new value.
 */
import { apiGet, apiPost } from './api.js';
import { escapeHtml, fmtDate, markdown, toast, formValues, openModal, confetti } from './ui.js';
import { opts } from './todos.js';
import { boot, aiAvailable } from './app.js';
const SECRET_UNCHANGED = '••••••••';
export async function renderSettings(container) {
    container.innerHTML = `<div class="empty">Loading…</div>`;
    const s = await apiGet('settings', 'get');
    const aiOn = s.ai_enabled === '1';
    container.innerHTML = `
    <div class="view-head"><h2>Settings</h2></div>
    <form data-role="form" class="grid grid-2">

      <section class="card">
        <div class="card-head"><h3>Profile</h3></div>
        <label><span>Display name (owner)</span><input name="owner_name" value="${escapeHtml(s.owner_name)}"></label>
        <div class="field-row">
          <label><span>Theme</span><select name="theme">${opts(['dark', 'light'], s.theme || 'dark')}</select></label>
          <label><span>Base currency</span><input name="base_currency" value="${escapeHtml(s.base_currency || 'TRY')}" maxlength="3"></label>
        </div>
      </section>

      <section class="card">
        <div class="card-head"><h3>GitHub</h3></div>
        <label><span>Username</span><input name="github_username" value="${escapeHtml(s.github_username)}"></label>
        <label><span>Personal access token ${s.github_token_set ? '<span class="chip">set</span>' : ''}</span>
          <input name="github_token" type="password" value="${s.github_token_set ? SECRET_UNCHANGED : ''}" placeholder="ghp_… (optional, for private repos)"></label>
        <label><span>Stale after (days)</span><input name="stale_repo_days" type="number" min="1" value="${escapeHtml(s.stale_repo_days || '60')}"></label>
      </section>

      <section class="card" style="grid-column:1/-1">
        <div class="card-head"><h3>AI assistant</h3>
          <label class="checkbox"><input type="checkbox" name="ai_enabled" ${aiOn ? 'checked' : ''}><span>Enable AI features</span></label>
        </div>
        <div class="field-row">
          <label><span>Provider</span><select name="ai_provider">${opts(['claude', 'ollama'], s.ai_provider || 'claude')}</select></label>
        </div>
        <div class="field-row">
          <label><span>Claude API key ${s.claude_api_key_set ? '<span class="chip">set</span>' : ''}</span>
            <input name="claude_api_key" type="password" value="${s.claude_api_key_set ? SECRET_UNCHANGED : ''}" placeholder="sk-ant-…"></label>
          <label><span>Claude model</span><input name="claude_model" value="${escapeHtml(s.claude_model || 'claude-sonnet-5')}"></label>
        </div>
        <div class="field-row">
          <label><span>Ollama base URL</span><input name="ollama_base_url" value="${escapeHtml(s.ollama_base_url || 'http://localhost:11434')}"></label>
          <label><span>Ollama model</span><input name="ollama_model" value="${escapeHtml(s.ollama_model || 'llama3.1')}"></label>
        </div>
        <div class="field-row" style="margin-top:12px">
          <button type="button" class="btn" data-role="test-ai">Test connection</button>
          <span data-role="ai-result" class="text-dim" style="align-self:center"></span>
        </div>
      </section>

      <div style="grid-column:1/-1">
        <button class="btn btn-primary" type="submit">Save settings</button>
      </div>
    </form>

    <section class="card" style="margin-top:16px">
      <div class="card-head"><h3>Data</h3></div>
      <div class="toolbar">
        <a class="btn" href="../api/export.php?action=json">⬇ Export all (JSON)</a>
        <a class="btn" href="../api/export.php?action=expenses_csv">⬇ Expenses (CSV)</a>
      </div>
    </section>

    ${aiAvailable ? `<section class="card" style="margin-top:16px">
      <div class="card-head"><h3>Weekly review</h3>
        <button class="btn btn-sm" data-role="weekly">✨ Generate</button></div>
      <div data-role="review" class="text-dim">A short AI review of your last 7 days.</div>
    </section>` : ''}

    <div data-role="admin"></div>

    <div style="text-align:center;margin-top:28px">
      <button type="button" class="btn btn-ghost btn-sm" data-role="egg" title="?">🐣</button>
    </div>`;
    const form = container.querySelector('[data-role="form"]');
    form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const saved = await save(container, form);
        // Toggling AI on/off changes what's gated app-wide (chat, brief, weekly
        // review, palette). aiAvailable is set at boot, so reload to re-evaluate it.
        const nowOn = form.querySelector('[name="ai_enabled"]').checked;
        if (saved && nowOn !== aiOn)
            location.reload();
    });
    container.querySelector('[data-role="test-ai"]').addEventListener('click', () => testAi(container));
    container.querySelector('[data-role="weekly"]')?.addEventListener('click', () => weeklyReview(container));
    container.querySelector('[data-role="egg"]')?.addEventListener('click', openEasterEgg);
    if (boot.user.role === 'admin') {
        await renderAdmin(container);
    }
}
/** Easter egg: pop zoktay.jpg (served from the XAMPP htdocs root) with confetti. */
function openEasterEgg() {
    openModal({
        title: 'zoktay',
        cancelLabel: 'Close',
        confirmLabel: 'Nice',
        bodyHtml: `<img src="/zoktay.jpg" alt="zoktay.jpg not found in htdocs"
      style="display:block;max-width:100%;max-height:60vh;margin:0 auto;border-radius:var(--radius)">`,
    });
    confetti();
}
async function weeklyReview(container) {
    const host = container.querySelector('[data-role="review"]');
    host.textContent = 'Thinking…';
    host.className = 'text-dim';
    try {
        const res = await apiGet('ai', 'weekly_review');
        host.className = 'md';
        host.innerHTML = markdown(res.review);
    }
    catch (e) {
        host.className = 'text-bad';
        host.textContent = e instanceof Error ? e.message : 'Failed';
    }
}
async function save(container, form) {
    const v = formValues(form);
    // Drop unchanged secret masks so the stored values survive (backend also guards this).
    if (v.github_token === SECRET_UNCHANGED)
        delete v.github_token;
    if (v.claude_api_key === SECRET_UNCHANGED)
        delete v.claude_api_key;
    try {
        await apiPost('settings', 'save', { settings: v });
        toast('Settings saved.', 'good');
        if (v.theme)
            document.documentElement.setAttribute('data-theme', v.theme);
        return true;
    }
    catch (e) {
        toast(e instanceof Error ? e.message : 'Save failed', 'bad');
        return false;
    }
}
async function testAi(container) {
    const result = container.querySelector('[data-role="ai-result"]');
    result.textContent = 'Testing…';
    result.className = 'text-dim';
    try {
        // Save first so the just-typed provider/key/model are what we test.
        const form = container.querySelector('[data-role="form"]');
        await save(container, form);
        const res = await apiPost('settings', 'test_ai', {});
        result.textContent = '✓ Connected' + (res.model ? ` (${res.model})` : '') + '.';
        result.className = 'text-good';
    }
    catch (e) {
        result.textContent = '✕ ' + (e instanceof Error ? e.message : 'Failed');
        result.className = 'text-bad';
    }
}
/* --------------------------------------------------------------- admin panel */
async function renderAdmin(container) {
    const host = container.querySelector('[data-role="admin"]');
    let users;
    try {
        users = await apiGet('users', 'list');
    }
    catch {
        return; // not an admin after all / endpoint guarded
    }
    const draw = () => {
        host.innerHTML = `
      <section class="card" style="margin-top:16px">
        <div class="card-head"><h3>Accounts</h3><span class="chip">admin</span></div>
        <table class="data">
          <thead><tr><th>User</th><th>Role</th><th>Created</th><th>Last login</th><th>Status</th><th></th></tr></thead>
          <tbody>${users.map((u) => `
            <tr>
              <td>${escapeHtml(u.display_name || u.username)} <span class="muted">@${escapeHtml(u.username)}</span></td>
              <td>${escapeHtml(u.role)}</td>
              <td>${escapeHtml(fmtDate(u.created_at))}</td>
              <td>${u.last_login_at ? escapeHtml(fmtDate(u.last_login_at)) : '<span class="muted">never</span>'}</td>
              <td>${u.is_active ? '<span class="badge badge-good">active</span>' : '<span class="badge badge-bad">disabled</span>'}</td>
              <td class="num"><button class="btn btn-ghost btn-sm" data-uid="${u.id}" data-active="${u.is_active ? 0 : 1}">
                ${u.is_active ? 'Deactivate' : 'Activate'}</button></td>
            </tr>`).join('')}</tbody>
        </table>
        <p class="text-dim" style="margin-top:10px">New accounts are added by hand — hash a password with
          <code>php tools/hashpw.php "pw"</code> and insert a <code>users</code> row.</p>
      </section>`;
        host.querySelectorAll('[data-uid]').forEach((btn) => {
            btn.addEventListener('click', async () => {
                try {
                    await apiPost('users', 'set_active', { id: Number(btn.dataset.uid), active: Number(btn.dataset.active) });
                    const u = users.find((x) => x.id === Number(btn.dataset.uid));
                    if (u)
                        u.is_active = Number(btn.dataset.active);
                    draw();
                }
                catch (e) {
                    toast(e instanceof Error ? e.message : 'Failed', 'bad');
                }
            });
        });
    };
    draw();
}
