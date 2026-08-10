# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

`inphub` is a personal life-dashboard (expenses, GitHub repos, todos, habits, goals, notes, focus
sessions, activity history) with hand-created logins and an optional AI layer. It runs locally on
XAMPP: Apache + PHP 8.2+ + MySQL/MariaDB. Plain PHP backend (no framework), TypeScript frontend
compiled to plain ES-module JS (no React, no bundler). Built on a dev machine, then the whole folder
is copied into `htdocs/inphub` on a Windows XAMPP laptop — so keep paths relative / `__DIR__`-based
and filenames lowercase. When deploying, `node_modules/` is skipped and the laptop's
`config/config.php` is never overwritten.

The original specification lives in `inphub-prompt.md` (kept locally, gitignored — not in the
public repo). **The database schema is `inphub.sql` and must
be matched exactly — never invent or alter tables/columns.** If a schema change is approved, put the
`CREATE`/`ALTER` in a dated `db/migrate-YYYY-MM-DD.sql` for existing databases AND mirror it in
`inphub.sql` for fresh installs (see `db/migrate-2026-07-19.sql` / `chat_sessions`).

The app version lives in one place: `const INPHUB_VERSION` in `lib/helpers.php` (shown in the
sidebar, login footer, and JSON export). Bump it together with `version` in `package.json` and the
`**vX.Y.Z**` badge at the top of `README.md`.

## Commands

- **Build frontend:** `npm run build` (runs `tsc`; compiles `src/*.ts` → `public/assets/js/`).
- **Watch:** `npm run watch` (`tsc -w`).
- **Lint PHP:** `php -l <file>` — there is no PHP test suite; syntax-check changed files this way.
- **Hash a password (to add a user by hand):** `php tools/hashpw.php "thePassword"` → paste the
  output into an `INSERT INTO users`.
- **No automated test framework.** Verification is manual against a running XAMPP instance.

## Running locally

1. Import `inphub.sql` (phpMyAdmin or `mysql -u root < inphub.sql`). Seeds admin `admin` / `changeme`.
2. `cp config/config.example.php config/config.php` (DB creds only; default XAMPP values work as-is).
3. `npm install && npm run build`.
4. Open `http://localhost/inphub/public/` and log in.

The compiled JS in `public/assets/js/` must exist for the app shell to function — always rebuild
after editing `src/`. `config/config.php`, `node_modules/`, and `public/assets/js/` are gitignored,
so a fresh checkout needs `npm run build` before anything past the login page works.

## Architecture

### Request/response contract (critical, app-wide)
Every `/api/*.php` endpoint returns one envelope: success `{ "ok": true, "data": ... }`, failure
`{ "ok": false, "error": "..." }` with a matching HTTP status. The frontend `src/api.ts` relies on
this — never break the shape. `api/_bootstrap.php` provides the shared machinery every endpoint uses:
- `api_handle(callable, requireAuth=true)` — starts session, enforces login, wraps the body in
  try/catch that emits the error envelope.
- `action($input)` / `method()` — endpoints dispatch on `?action=` (default `list` for GET).
- `fetch_owned($table, $id, $uid)` — loads a row scoped to the owner (404 if foreign); `$table` is
  whitelisted in `OWNED_TABLES`, never interpolated from user input.
- `valid_enum()` — sanitises ENUM columns coming from the client.
- `ok()` / `fail()` / `json_response()` live in `lib/helpers.php`.

**Gotcha:** `api_handle()` runs the request synchronously at its call site, and PHP does NOT hoist
top-level `const` (only `function`). Any `const` an endpoint's handler needs must be defined ABOVE
the `api_handle(...)` call, or it won't exist when the handler runs.

### Data isolation
This is multi-account. **Every query is scoped to `current_user_id()`** and mutations go through
prepared statements only (no string-interpolated SQL, ever). A user only ever sees their own rows.
Rows referenced by id from the client (e.g. `linked_todo_id`) are ownership-checked via
`fetch_owned()` before use.

### Auth (`lib/auth.php`)
Session-based. `auth_boot()` starts the session and, when there is none, silently re-establishes it
from a remember-me cookie: a random token whose **SHA-256 hash** is stored in `remember_tokens`
(raw token only in an httponly/SameSite=Lax cookie), rotated on each use. Guards: `require_login()`
(401 JSON, for API), `require_login_page()` (redirect, for HTML pages), `require_role('admin')`.
There is no registration — accounts are inserted by hand. `current_user()` never selects
`password_hash`.

### First-login provisioning (`lib/provision.php`)
`provision_user($id)` seeds default settings / expense categories / habits the first time a
hand-added user logs in. **These defaults mirror the seed block in `inphub.sql` for user 1** — if you
change one, change both so a fresh account matches user 1.

### Settings & secrets (`api/settings.php`)
Per-user key/value in the `settings` table (theme, currency, GitHub + AI config). Writable keys are
whitelisted (`ALLOWED_SETTING_KEYS`). Secret keys (`github_token`, `claude_api_key`) are masked on
read (`mask_secret()`); on save, a value equal to the `SECRET_UNCHANGED` sentinel means "keep the
stored value" so the mask never overwrites the real secret. Saving `ai_enabled = '0'` also deletes
the user's stored daily briefs.

### AI layer (`lib/ai.php` + `api/ai.php`) — optional, provider-agnostic
Off by default. `ai_available($uid)` is the ONE canonical gate for every AI feature; in `api/ai.php`
`ai_gate()` applies it (403) to every action except `status` and `quick_add`. `ai_generate($uid,
$system, $prompt, $opts)` reads the user's settings and dispatches to **Claude** (`/v1/messages`) or
**Ollama** (`/api/chat`) over cURL — feature code never branches on provider. `$opts['model']`
overrides the model for that single call (used by the chat's per-session model combo, fed by
`ai_list_models()`); it must never be written to settings. The chat feature uses a portable action
protocol (a fenced ```json block of `{actions:[...]}` validated against the `CHAT_ACTIONS`
whitelist) instead of native tool-calling, because Ollama tool-use is inconsistent. Every
AI-initiated write logs an `activity_log` row with `actor='ai'`.

Chat conversations persist in `chat_sessions` (+ `session_id` on `chat_messages`), titled from the
first user message; legacy rows are backfilled into a `'default'` session. The system prompt is
built only in `chat_system_prompt()` (single-user app facts, username injection, developer-mode
block for the username in `config/config.php`'s `developer_user` — read via `app_config()`, empty
disables it; the key is deliberately in the gitignored config so it stays out of the public repo).
Repo AI analysis is cached: within `AI_ANALYZE_COOLDOWN_HOURS` it serves
existing `repo_suggestions` (freshness derived from `MAX(created_at)` — no schema column), and a
garbled model reply must never delete previous suggestions.

### Activity log
`log_activity(...)` in `lib/activity.php` records meaningful mutations (actor `user`/`ai`/`system`).
The dashboard, daily brief, and weekly review read from this timeline.

### GitHub sync (`api/sync_repos.php` + `lib/github.php`)
Pulls repos via the GitHub REST API, upserts on `(user_id, full_name)`, fetches README excerpt +
license, then computes `staleness_days` and a 0–100 `health_score` (`repo_health_score()`: README /
LICENSE / description / push recency / low issue backlog).

### Frontend (`src/`)
`app.ts` is the SPA shell (hash routing, lazy per-view data load, theme, clock, keyboard shortcuts,
mobile drawer nav). Each view module (`todos.ts`, `expenses.ts`, …) exposes a render entry point
mounted into its `#view-<id>` section in `public/index.php`. `ui.ts` holds toasts/modals/
safe-markdown/formatting. Chart.js is loaded from CDN (expense charts only) and used as a global.

Conventions that prevent recurring bugs:
- **View containers are persistent nodes whose `innerHTML` is swapped on every render.** Wire
  delegated clicks through `onAction()` in `ui.ts` — it is idempotent (WeakMap-backed; re-calling
  replaces the handler). Never add a raw `addEventListener` to a `#view-*` container from a render
  function, and never capture child nodes across renders (query the live container instead — see
  `focus.ts`).
- **Topbar/drawer chrome (theme button, hamburger, nav backdrop) is wired through inline `onclick`
  attributes in `index.php`** calling `window.inphubToggleTheme` / `window.inphubDrawer`, which
  `app.ts` `init()` exposes. This is deliberate and must stay: in the owner's environment (Firefox,
  desktop + mobile) BOTH direct `addEventListener` bindings AND a document-level delegated click
  listener silently never fired for these buttons — likely an extension wrapping `addEventListener` —
  while inline DOM-level-0 handlers are immune. New global chrome should follow the same pattern.
  Keep `cursor: pointer` on `#nav-backdrop` (iOS Safari tap-delivery quirk for plain `<div>`s).
- **Dates:** the server compares in *local* time (`date('Y-m-d')`). Use `localDate()` /
  `localDateTime()` / `todayStr()` from `ui.ts`; never `toISOString()` (UTC — wrong day near
  midnight).
- All user data interpolated into HTML goes through `escapeHtml()` (or `safeMarkdown()`).
- Theme: `data-theme` on `<html>`, cached in `localStorage['inphub.theme']` with pre-paint scripts
  in `index.php` and `login.php`; the `settings` table stays the source of truth.
- AI visibility: `refreshAiAvailability()` in `app.ts` re-checks `ai?action=status` and
  shows/hides every AI entry point (chat button, palette entry, brief) — Settings calls it after a
  save so toggling AI needs no reload.

## Layout
`config/` DB creds · `db/database.php` PDO singleton + `migrate-*.sql` · `lib/` shared backend ·
`api/` JSON endpoints (all guarded) · `public/` web root (shell, login, compiled assets) · `src/`
TS source · `tools/` CLI helpers.
