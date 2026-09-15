/**
 * inphub: settings: profile, currency, GitHub, stale threshold, AI provider,
 * and (admins only) an account management panel. Secrets arrive masked and are
 * only re-sent when the user actually types a new value.
 */

import { apiGet, apiPost } from './api.js';
import { escapeHtml, fmtDate, markdown, toast, formValues, openModal, confetti, loadingState } from './ui.js';
import { opts } from './todos.js';
import { boot, aiAvailable, refreshAiAvailability, applyTheme, applyAppearance, cssUrl, type Appearance } from './app.js';

const SECRET_UNCHANGED = '••••••••';

interface SettingsPayload {
  theme: string; base_currency: string; starting_balance: string; owner_name: string;
  github_username: string; github_token: string; github_token_set: boolean;
  stale_repo_days: string;
  ai_enabled: string; ai_provider: string;
  claude_api_key: string; claude_api_key_set: boolean; claude_model: string;
  ollama_base_url: string; ollama_model: string;
  lmstudio_base_url: string; lmstudio_model: string; lmstudio_api_key: string; lmstudio_api_key_set: boolean;
  ui_accent: string; ui_wallpaper: string; ui_wallpaper_url: string; ui_transparency: string;
}

/** Accent presets with their dark-theme swatch colour (UI_ACCENTS in lib/helpers.php). */
const ACCENTS: [string, string, string][] = [
  ['blue', 'Blue', '#3d8bff'], ['indigo', 'Indigo', '#7a78ff'], ['purple', 'Purple', '#bf5af2'],
  ['pink', 'Pink', '#ff5ea8'], ['red', 'Red', '#ff5a5f'], ['orange', 'Orange', '#ff9f0a'],
  ['green', 'Green', '#30d158'], ['teal', 'Teal', '#40c8e0'], ['graphite', 'Graphite', '#9aa0ab'],
];

/** Wallpaper presets (UI_WALLPAPERS in lib/helpers.php). */
const WALLPAPERS: [string, string][] = [
  ['aurora', 'Aurora'], ['sunset', 'Sunset'], ['ocean', 'Ocean'], ['forest', 'Forest'],
  ['graphite', 'Graphite'], ['plain', 'Plain'], ['custom', 'Custom'],
];
interface AdminUser {
  id: number; username: string; display_name: string | null; role: string;
  is_active: number; created_at: string; last_login_at: string | null;
}

export async function renderSettings(container: HTMLElement): Promise<void> {
  container.innerHTML = `${loadingState()}`;
  const s = await apiGet<SettingsPayload>('settings', 'get');
  const aiOn = s.ai_enabled === '1';
  const root = document.documentElement;
  // What is on screen right now (the cache may be newer than the server).
  const theme = root.getAttribute('data-theme') || s.theme || 'dark';
  const accent = root.getAttribute('data-accent') || s.ui_accent || 'blue';
  const wallpaper = root.getAttribute('data-wallpaper') || s.ui_wallpaper || 'aurora';
  const transparency = root.getAttribute('data-glass') || s.ui_transparency || 'full';
  const wpUrl = s.ui_wallpaper_url || '';

  container.innerHTML = `
    <form data-role="form" class="grid grid-2">

      <section class="card" style="grid-column:1/-1" data-role="appearance">
        <div class="card-head"><h3>Appearance</h3><small>Changes preview instantly, Save keeps them.</small></div>
        <div class="appearance">
          <div class="appearance-row"><span>Theme</span>
            <div class="segmented" role="group" aria-label="Theme">
              ${[['dark', 'Dark'], ['light', 'Light']].map(([k, label]) => `
                <button type="button" data-pick="theme" data-value="${k}" class="${theme === k ? 'on' : ''}" aria-pressed="${theme === k}">${label}</button>`).join('')}
            </div>
            <input type="hidden" name="theme" value="${escapeHtml(theme)}">
          </div>
          <div class="appearance-row"><span>Accent colour</span>
            <div class="swatches">
              ${ACCENTS.map(([k, label, hex]) => `
                <button type="button" class="swatch ${accent === k ? 'on' : ''}" data-pick="ui_accent" data-value="${k}"
                  style="--sw:${hex}" title="${label}" aria-label="${label}" aria-pressed="${accent === k}"></button>`).join('')}
            </div>
            <input type="hidden" name="ui_accent" value="${escapeHtml(accent)}">
          </div>
          <div class="appearance-row"><span>Wallpaper</span>
            <div class="wp-grid">
              ${WALLPAPERS.map(([k, label]) => `
                <button type="button" class="wp-thumb ${wallpaper === k ? 'on' : ''}" data-pick="ui_wallpaper" data-value="${k}"
                  data-wallpaper="${k}" aria-pressed="${wallpaper === k}"
                  ${k === 'custom' && /^https?:\/\//i.test(wpUrl) ? `style="background-image:${escapeHtml(cssUrl(wpUrl))}"` : ''}><span>${label}</span></button>`).join('')}
            </div>
            <input type="hidden" name="ui_wallpaper" value="${escapeHtml(wallpaper)}">
            <label data-role="wp-url" style="margin-top:12px" ${wallpaper === 'custom' ? '' : 'hidden'}><span>Image URL</span>
              <input name="ui_wallpaper_url" type="url" inputmode="url" value="${escapeHtml(wpUrl)}" placeholder="https://example.com/wallpaper.jpg" autocomplete="off"></label>
          </div>
          <label class="checkbox"><input type="checkbox" data-role="reduce" ${transparency === 'reduced' ? 'checked' : ''}>
            <span>Reduce transparency</span></label>
          <input type="hidden" name="ui_transparency" value="${escapeHtml(transparency)}">
        </div>
      </section>

      <section class="card">
        <div class="card-head"><h3>Profile</h3></div>
        <label><span>Display name (owner)</span><input name="owner_name" value="${escapeHtml(s.owner_name)}"></label>
        <label><span>Base currency</span><input name="base_currency" value="${escapeHtml(s.base_currency || 'TRY')}" maxlength="3"></label>
        <label><span>Starting balance</span>
          <input name="starting_balance" type="number" step="0.01" value="${escapeHtml(s.starting_balance || '0')}">
          <small class="text-dim">Money you had before you started logging here. Can be negative.</small></label>
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
          <label><span>Provider</span><select name="ai_provider">${opts(['claude', 'ollama', 'lmstudio'], s.ai_provider || 'claude', { claude: 'Claude', ollama: 'Ollama', lmstudio: 'LM Studio' })}</select></label>
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
        <div class="field-row">
          <label><span>LM Studio base URL</span><input name="lmstudio_base_url" value="${escapeHtml(s.lmstudio_base_url || 'http://localhost:1234')}"></label>
          <label><span>LM Studio model</span><input name="lmstudio_model" value="${escapeHtml(s.lmstudio_model)}" placeholder="model id from LM Studio"></label>
          <label><span>LM Studio API key ${s.lmstudio_api_key_set ? '<span class="chip">set</span>' : ''}</span>
            <input name="lmstudio_api_key" type="password" value="${s.lmstudio_api_key_set ? SECRET_UNCHANGED : ''}" placeholder="optional"></label>
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
      <div class="card-head"><h3>Password</h3></div>
      <form data-role="pw-form" class="field-row" style="align-items:flex-end">
        <label style="flex:1 1 180px"><span>Current password</span>
          <input name="current" type="password" autocomplete="current-password" required></label>
        <label style="flex:1 1 180px"><span>New password</span>
          <input name="next" type="password" autocomplete="new-password" minlength="8" required></label>
        <label style="flex:1 1 180px"><span>Repeat new password</span>
          <input name="again" type="password" autocomplete="new-password" minlength="8" required></label>
        <button class="btn" type="submit">Change</button>
      </form>
      <div class="text-dim" style="margin-top:8px;font-size:.82rem">
        At least 8 characters. Signs out other devices.</div>
    </section>

    <section class="card" style="margin-top:16px">
      <div class="card-head"><h3>Data</h3></div>
      <div class="toolbar">
        <a class="btn" href="../api/export.php?action=json">Export all (JSON)</a>
        <a class="btn" href="../api/export.php?action=expenses_csv">Expenses (CSV)</a>
      </div>
    </section>

    ${aiAvailable ? `<section class="card" style="margin-top:16px">
      <div class="card-head"><h3>Weekly review</h3>
        <button class="btn btn-sm" data-role="weekly">Generate</button></div>
      <div data-role="review" class="text-dim">AI review of the last 7 days.</div>
    </section>` : ''}

    <div data-role="admin"></div>

    <div style="text-align:center;margin-top:28px">
      <button type="button" class="btn btn-ghost btn-sm" data-role="egg" title="?">🐣</button>
    </div>`;

  const form = container.querySelector<HTMLFormElement>('[data-role="form"]')!;
  wireAppearance(form);
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    save(container, form);
  });

  const pwForm = container.querySelector<HTMLFormElement>('[data-role="pw-form"]')!;
  pwForm.addEventListener('submit', (e) => {
    e.preventDefault();
    void changePassword(pwForm);
  });

  container.querySelector<HTMLButtonElement>('[data-role="test-ai"]')!.addEventListener('click', () => testAi(container));

  container.querySelector<HTMLButtonElement>('[data-role="weekly"]')?.addEventListener('click', () => weeklyReview(container));

  container.querySelector<HTMLButtonElement>('[data-role="egg"]')?.addEventListener('click', openEasterEgg);

  if (boot.user.role === 'admin') {
    await renderAdmin(container);
  }
}

/**
 * Easter egg: pop zoktay.jpg with confetti.
 *
 * The image lives at the web-server root, outside this repo, so it is simply
 * absent on a fresh checkout (and on the dev server). Degrade to a line of
 * text instead of a broken-image icon, same onerror trick the dashboard
 * favicons use.
 */
function openEasterEgg(): void {
  openModal({
    title: 'zoktay',
    cancelLabel: 'Close',
    confirmLabel: 'Nice',
    bodyHtml: `<img src="/zoktay.jpg" alt=""
      style="display:block;max-width:100%;max-height:60vh;margin:0 auto;border-radius:var(--radius)"
      onerror="this.insertAdjacentHTML('afterend','<p class=&quot;text-dim&quot; style=&quot;text-align:center&quot;>zoktay.jpg isn\'t in the web root on this machine.</p>');this.remove()">`,
  });
  confetti();
}

async function weeklyReview(container: HTMLElement): Promise<void> {
  const host = container.querySelector<HTMLElement>('[data-role="review"]')!;
  host.textContent = 'Thinking…';
  host.className = 'text-dim';
  try {
    const res = await apiGet<{ review: string }>('ai', 'weekly_review');
    host.className = 'md';
    host.innerHTML = markdown(res.review);
  } catch (e) {
    host.className = 'text-bad';
    host.textContent = e instanceof Error ? e.message : 'Failed';
  }
}

async function save(container: HTMLElement, form: HTMLFormElement): Promise<void> {
  const v = formValues(form);
  // Drop unchanged secret masks so the stored values survive (backend also guards this).
  if (v.github_token === SECRET_UNCHANGED) delete (v as Record<string, unknown>).github_token;
  if (v.claude_api_key === SECRET_UNCHANGED) delete (v as Record<string, unknown>).claude_api_key;
  if (v.lmstudio_api_key === SECRET_UNCHANGED) delete (v as Record<string, unknown>).lmstudio_api_key;
  try {
    await apiPost('settings', 'save', { settings: v });
    toast('Settings saved.', 'good');
    if (v.theme) applyTheme(v.theme);
    applyAppearance(lookFromForm(v));
    // AI config may have changed, re-check so chat/brief appear or vanish now.
    await refreshAiAvailability(false);
  } catch (e) {
    toast(e instanceof Error ? e.message : 'Save failed', 'bad');
  }
}

async function testAi(container: HTMLElement): Promise<void> {
  const result = container.querySelector<HTMLElement>('[data-role="ai-result"]')!;
  result.textContent = 'Testing…';
  result.className = 'text-dim';
  try {
    // Save first so the just-typed provider/key/model are what we test.
    const form = container.querySelector<HTMLFormElement>('[data-role="form"]')!;
    await save(container, form);
    const res = await apiPost<{ ok: boolean; model?: string | null }>('settings', 'test_ai', {});
    result.textContent = '✓ Connected' + (res.model ? ` (${res.model})` : '') + '.';
    result.className = 'text-good';
  } catch (e) {
    result.textContent = '✕ ' + (e instanceof Error ? e.message : 'Failed');
    result.className = 'text-bad';
  }
}

/* --------------------------------------------------------------- admin panel */

async function changePassword(form: HTMLFormElement): Promise<void> {
  const v = formValues(form);
  if (v.next !== v.again) {
    toast('The two new passwords do not match.', 'bad');
    return;
  }
  const btn = form.querySelector<HTMLButtonElement>('button[type="submit"]')!;
  btn.disabled = true;
  try {
    await apiPost('auth', 'change_password', { current: v.current, next: v.next });
    form.reset();
    toast('Password changed.', 'good');
  } catch (e) {
    toast(e instanceof Error ? e.message : 'Could not change password', 'bad');
  } finally {
    btn.disabled = false;
  }
}

async function renderAdmin(container: HTMLElement): Promise<void> {
  const host = container.querySelector<HTMLElement>('[data-role="admin"]')!;
  let users: AdminUser[];
  try {
    users = await apiGet<AdminUser[]>('users', 'list');
  } catch {
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
        <p class="text-dim" style="margin-top:10px">New accounts are added by hand. Hash a password with
          <code>php tools/hashpw.php "pw"</code> and insert a <code>users</code> row.</p>
      </section>`;

    host.querySelectorAll<HTMLButtonElement>('[data-uid]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        try {
          await apiPost('users', 'set_active', { id: Number(btn.dataset.uid), active: Number(btn.dataset.active) });
          const u = users.find((x) => x.id === Number(btn.dataset.uid));
          if (u) u.is_active = Number(btn.dataset.active);
          draw();
        } catch (e) {
          toast(e instanceof Error ? e.message : 'Failed', 'bad');
        }
      });
    });
  };
  draw();
}

/* ------------------------------------------------------------- appearance */

function lookFromForm(v: Record<string, string>): Appearance {
  return {
    accent: v.ui_accent,
    wallpaper: v.ui_wallpaper,
    wallpaper_url: v.ui_wallpaper_url ?? '',
    transparency: v.ui_transparency,
  };
}

/**
 * Live preview for the Appearance card. The hidden inputs carry the choices
 * into the normal Save; nothing is cached until Save succeeds, so leaving
 * without saving reverts on the next reload.
 */
function wireAppearance(form: HTMLFormElement): void {
  const section = form.querySelector<HTMLElement>('[data-role="appearance"]');
  if (!section) return;
  const field = (name: string) => form.querySelector<HTMLInputElement>(`[name="${name}"]`)!;
  const preview = () => {
    const v = formValues(form);
    applyTheme(v.theme, false);
    applyAppearance(lookFromForm(v), false);
  };

  section.addEventListener('click', (e) => {
    const pick = (e.target as HTMLElement).closest<HTMLElement>('[data-pick]');
    if (!pick) return;
    const key = pick.dataset.pick!;
    field(key).value = pick.dataset.value!;
    section.querySelectorAll<HTMLElement>(`[data-pick="${key}"]`).forEach((b) => {
      b.classList.toggle('on', b === pick);
      b.setAttribute('aria-pressed', String(b === pick));
    });
    if (key === 'ui_wallpaper') {
      const urlRow = section.querySelector<HTMLElement>('[data-role="wp-url"]')!;
      urlRow.hidden = pick.dataset.value !== 'custom';
      if (!urlRow.hidden) urlRow.querySelector('input')?.focus();
    }
    preview();
  });

  section.querySelector<HTMLInputElement>('[data-role="reduce"]')?.addEventListener('change', (e) => {
    field('ui_transparency').value = (e.target as HTMLInputElement).checked ? 'reduced' : 'full';
    preview();
  });

  let timer = 0;
  field('ui_wallpaper_url').addEventListener('input', () => {
    clearTimeout(timer);
    timer = window.setTimeout(() => {
      const url = field('ui_wallpaper_url').value.trim();
      const thumb = section.querySelector<HTMLElement>('.wp-thumb[data-value="custom"]');
      if (thumb) thumb.style.backgroundImage = /^https?:\/\//i.test(url) ? cssUrl(url) : '';
      preview();
    }, 350);
  });
}
