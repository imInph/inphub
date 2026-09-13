# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

`inphub` is a personal life-dashboard (expenses, GitHub repos, todos, habits, goals, notes, focus
sessions, activity history) with hand-created logins and an optional AI layer. It runs locally on
XAMPP: Apache + PHP 8.2+ + MySQL/MariaDB. Plain PHP backend (no framework), TypeScript frontend
compiled to plain ES-module JS (no React, no bundler). Built on a dev machine, then the whole folder
is copied into `htdocs/inphub` on a Windows XAMPP laptop, so keep paths relative / `__DIR__`-based
and filenames lowercase. When deploying, `node_modules/` is skipped and the laptop's
`config/config.php` is never overwritten.

The original specification lives in `inphub-prompt.md` (kept locally, gitignored, not in the
public repo). **The database schema is `inphub.sql` and must
be matched exactly, never invent or alter tables/columns.** If a schema change is approved, put the
`CREATE`/`ALTER` in a dated `db/migrate-YYYY-MM-DD.sql` for existing databases AND mirror it in
`inphub.sql` for fresh installs (see `db/migrate-2026-07-19.sql` / `chat_sessions`).

The app version lives in one place: `const INPHUB_VERSION` in `lib/helpers.php` (shown in the
sidebar, login footer, and JSON export). Bump it together with `version` in `package.json`, the
`vX.Y.Z` line at the top of `README.md`, and the console stamp at the end of `init()` in
`src/app.ts` (hardcoded on purpose: it proves which `app.js` the browser actually loaded).

## Commands

- **Build frontend:** `npm run build`, `tsc` **and then** `tools/stamp-modules.mjs`. Never run
  bare `tsc`: the stamper rewrites every compiled import to `./ui.js?v=<build id>` and writes
  `public/assets/js/build-id.txt`, which `public/index.php` reads for the entry `<script>` URL.
  Those two ids **must match**, if the entry is `app.js?v=A` while a module imports
  `./app.js?v=B`, the browser treats them as different modules and evaluates `app.js` twice; the
  second copy runs `init()` while `command-palette.js` is still mid-evaluation and throws
  `Cannot access 'chatEnabled' before initialization`, which kills the palette. And without any
  stamping at all, a fresh `app.js` can pair with a cached `ui.js`, where a missing export is an
  ES-module *link* error that stops the whole app from executing, silently. `public/index.php`
  carries a `window.__inphubLoaded` guard that surfaces exactly that failure.
- **Watch:** `npm run watch` (`tsc -w`).
- **Lint PHP:** `php -l <file>`, there is no PHP test suite; syntax-check changed files this way.
- **Hash a password (to add a user by hand):** `php tools/hashpw.php "thePassword"` → paste the
  output into an `INSERT INTO users`.
- **No automated test framework.** Verification is manual against a running XAMPP instance.

## Running locally

1. Import `inphub.sql` (phpMyAdmin or `mysql -u root < inphub.sql`). Seeds admin `admin` / `changeme`.
2. `cp config/config.example.php config/config.php` (DB creds only; default XAMPP values work as-is).
3. `npm install && npm run build` (only needed after editing `src/`; the built JS is committed).
4. Open `http://localhost/inphub/public/` and log in.

The compiled JS in `public/assets/js/` (including `build-id.txt`) **is committed**, so a GitHub
download works when copied straight into `htdocs` with no Node. It was gitignored before v2.1.2,
and a fresh download rendered the PHP sidebar over a blank page, because the entry-module 404 fires
no window `error` event, so the index.php banner stayed silent. `index.php` now checks for `app.js`
server-side. **Every commit that touches `src/` must include the rebuilt output from
`npm run build`**; the build id is a content hash, so an unchanged rebuild produces no diff.
`config/config.php`, `node_modules/`, and the `inphub-*prompt*.md` notes are gitignored.

## Architecture

### Request/response contract (critical, app-wide)
Every `/api/*.php` endpoint returns one envelope: success `{ "ok": true, "data": ... }`, failure
`{ "ok": false, "error": "..." }` with a matching HTTP status. The frontend `src/api.ts` relies on
this, never break the shape. `api/_bootstrap.php` provides the shared machinery every endpoint uses:
- `api_handle(callable, requireAuth=true)`, starts session, enforces login, wraps the body in
  try/catch that emits the error envelope.
- `action($input)` / `method()`, endpoints dispatch on `?action=` (default `list` for GET).
- `fetch_owned($table, $id, $uid)`, loads a row scoped to the owner (404 if foreign); `$table` is
  whitelisted in `OWNED_TABLES`, never interpolated from user input.
- `valid_enum()`, sanitises ENUM columns coming from the client.
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
There is no registration, accounts are inserted by hand. `current_user()` never selects
`password_hash`.

### First-login provisioning (`lib/provision.php`)
`provision_user($id)` seeds default settings / expense categories / habits the first time a
hand-added user logs in. **These defaults mirror the seed block in `inphub.sql` for user 1**, if you
change one, change both so a fresh account matches user 1.

### Settings & secrets (`api/settings.php`)
Per-user key/value in the `settings` table (theme, currency, GitHub + AI config). Writable keys are
whitelisted (`ALLOWED_SETTING_KEYS`). Secret keys (`github_token`, `claude_api_key`) are masked on
read (`mask_secret()`); on save, a value equal to the `SECRET_UNCHANGED` sentinel means "keep the
stored value" so the mask never overwrites the real secret. Saving `ai_enabled = '0'` also deletes
the user's stored daily briefs.

### AI layer (`lib/ai.php` + `api/ai.php`), optional, provider-agnostic
Off by default. `ai_available($uid)` is the ONE canonical gate for every AI feature; in `api/ai.php`
`ai_gate()` applies it (403) to every action except `status` and `quick_add`. `ai_generate($uid,
$system, $prompt, $opts)` reads the user's settings and dispatches to **Claude** (`/v1/messages`),
**Ollama** (`/api/chat`) or **LM Studio** (OpenAI-compatible `/v1/chat/completions`) over cURL, feature
code never branches on provider; `ai_active_model($c)` is the one provider → model mapping. `$opts['model']`
overrides the model for that single call (used by the chat's per-session model combo, fed by
`ai_list_models()`); it must never be written to settings.

`ai_generate()` prepends `ai_locale_preamble($uid)` to every `$system`, the user's currency (code
+ name, "never assume dollars") and today's date. It is the single place app-wide facts belong.
`$opts['raw_system'] => true` skips it, and the three prompts that demand strict JSON back
(`quick_add_ai`, `analyze_repo`, `ai_test_connection`) set it, because stray prose breaks their
parsers. **Never let a money figure reach a model without a currency**: use `money_text()`
(`lib/helpers.php`), which is also why `activity_log` summaries carry units, the weekly review
reads those rows back to the model.

The chat feature uses a portable action protocol (a fenced ```json block of `{actions:[...]}`
validated against the `CHAT_ACTIONS` whitelist) instead of native tool-calling, because Ollama
tool-use is inconsistent. Small local models need the mechanism spelled out, the prompt must say
that *emitting the block is* the action (wording like "only include it when you actually performed
an action" reads as "you cannot act" and they skip it), and it carries worked examples. Parsing is
deliberately liberal (`split_actions()` → `normalise_chat_actions()` → `extract_balanced_json()`):
any fence tag or none (gemma emits ```tool_code), `{actions:[…]}` / a lone `{tool,args}` / a bare
array, and `tool|action|name` + `args|arguments|parameters` key spellings. The chat snapshot is
`brief_context($uid, true)`, the `true` adds the row **ids** the action tools need (and recent
notes / money entries, so the edit tools have something to address); without them those tools
cannot be used at all, and the prompt forbids guessing an id. The daily brief passes `false` (ids
are noise in prose a human reads).

`CHAT_ACTIONS` covers every area, not just todos (add/complete/update todo · add/log/unlog habit ·
add/progress/status goal · add/update note · add/update/delete expense · repo suggestion). Three
rules hold for all of them:
- **Resolve, don't trust.** `chat_resolve($uid, $kind, $args)` finds the row by id **or** name
  (models send names however firmly the prompt says otherwise), always scoped to `user_id`, and an
  ambiguous name errors with the candidate ids rather than picking one. Table/column names come
  from the `CHAT_ENTITIES` map only, never from model output. `delete_expense` deliberately
  refuses a name and demands an id, so a fuzzy match can never delete the wrong row.
- **Fail loudly, in words the model can use.** Throw `ChatActionError` via `fail_action()` with the
  actual reason ("there is no task with id 999") instead of returning null. `chat_turn()` catches
  it, shows it, and `recent_chat_text()` replays every outcome into the next turn's transcript as a
  `(system: result of those actions, …)` line, that feedback loop is what lets a model correct a
  wrong id instead of silently repeating it. Validate arguments with `chat_date()` (which also
  accepts "today"/"tomorrow"), `chat_text()`, `chat_amount()` rather than letting MySQL reject them.
- Every AI-initiated write logs an `activity_log` row with `actor='ai'`.

Chat conversations persist in `chat_sessions` (+ `session_id` on `chat_messages`), titled from the
first user message; legacy rows are backfilled into a `'default'` session. The system prompt is
built only in `chat_system_prompt()` (single-user app facts, username injection, developer-mode
block for the username in `config/config.php`'s `developer_user`, read via `app_config()`, empty
disables it; the key is deliberately in the gitignored config so it stays out of the public repo).
Repo AI analysis is cached: within `AI_ANALYZE_COOLDOWN_HOURS` it serves
existing `repo_suggestions` (freshness derived from `MAX(created_at)`, no schema column), and a
garbled model reply must never delete previous suggestions.

### Activity log
`log_activity(...)` in `lib/activity.php` records meaningful mutations (actor `user`/`ai`/`system`).
The dashboard, daily brief, and weekly review read from this timeline.

### GitHub sync (`api/sync_repos.php` + `lib/github.php`)
Pulls repos via the GitHub REST API, upserts on `(user_id, full_name)`, fetches README excerpt +
license, then computes `staleness_days` and a 0–100 `health_score` (`repo_health_score()`: README /
LICENSE / description / push recency / low issue backlog).

### Routing and deep links (`src/app.ts`)
Hash routes carry params: `#notes?focus=7`. `parseRoute()` splits them, `routeKey()` is what
`onRoute()` compares (the **whole** route, not the view id, otherwise `?focus=7` → `?focus=9` is
skipped as "same view"), and the boot normaliser compares the parsed **view id**, never the raw
hash, or a deep link is rewritten to `#notes` before anything renders. `go(view, params?)` builds
routes; results never navigate by raw string. Views read `currentParams()`, params are *read, not
consumed*, because a re-render (AI status landing at boot, any `inphub:data-changed`) replaces the
DOM and would drop the highlight; `activate()` clears them on the next real navigation.
`flashRow()`/`flashFocused()` in `ui.ts` highlight a `[data-row]` and only scroll when off-screen.
**When a view's own filter hides the focused row, widen it**, todos drops to "All", money to "All
time", otherwise a search jump looks like it did nothing.

### Global search (`api/search.php`)
Six groups, all scoped to `current_user_id()`. Escape the user's text with `like_escape()` and
carry `ESCAPE '!'` on **every** `LIKE`: unescaped, `%` matches everything, and backslash escaping
breaks under `NO_BACKSLASH_ESCAPES`. `LIMIT` is an interpolated clamped int (PDO runs with
`EMULATE_PREPARES => false`, so a bound LIMIT arrives quoted and MySQL rejects it) and each group
fetches limit+1 to know whether more exist. Always end `ORDER BY` with `id DESC` or tied rows
reshuffle between keystrokes. The collation (`utf8mb4_unicode_ci`) already matches `İSTANBUL` ↔
`istanbul` ↔ `ıstanbul`, do not "fix" it to `utf8mb4_turkish_ci`, and never re-filter results
client-side, since JS `toLowerCase()` gets Turkish wrong where the DB gets it right.

### Insights (`api/insights.php` + `src/insights.ts`)
One `?action=summary&period=` call feeds the whole view; nothing is stored. It reuses
`money_window()`, the name is historical, the maths is generic, so Insights and Money share one
period vocabulary. Two details to preserve: `WEEKDAY()` is 0=Monday (unlike `DAYOFWEEK()`, which
starts Sunday) and the frontend derives its labels by walking a known Monday so they stay
localised; and `insights_fill()` zero-fills each series exactly like `expense_series_fill()` in
stats.php, so a chart draws a timeline instead of a list of days that happened to have data.
Chart colours are read from the CSS custom properties at draw time, so charts follow the
light/dark switch; every chart instance is destroyed before a redraw.

### Frontend (`src/`)
`app.ts` is the SPA shell (hash routing, lazy per-view data load, theme, clock, keyboard shortcuts,
mobile drawer nav). Each view module (`todos.ts`, `expenses.ts`, …) exposes a render entry point
mounted into its `#view-<id>` section in `public/index.php`. `ui.ts` holds toasts/modals/
safe-markdown/formatting. Chart.js is loaded from CDN (expense charts only) and used as a global.

Conventions that prevent recurring bugs:
- **View containers are persistent nodes whose `innerHTML` is swapped on every render.** Wire
  delegated clicks through `onAction()` in `ui.ts`, it is idempotent (WeakMap-backed; re-calling
  replaces the handler). Never add a raw `addEventListener` to a `#view-*` container from a render
  function, and never capture child nodes across renders (query the live container instead, see
  `focus.ts`).
- **Topbar/drawer chrome (theme button, hamburger, nav backdrop) is wired through inline `onclick`
  attributes in `index.php`** calling `window.inphubToggleTheme` / `window.inphubDrawer`, which
  `app.ts` `init()` exposes. This is deliberate and must stay: in the owner's environment (Firefox,
  desktop + mobile) BOTH direct `addEventListener` bindings AND a document-level delegated click
  listener silently never fired for these buttons, likely an extension wrapping `addEventListener`,
  while inline DOM-level-0 handlers are immune. New global chrome should follow the same pattern.
  Keep `cursor: pointer` on `#nav-backdrop` (iOS Safari tap-delivery quirk for plain `<div>`s).
- **Keys:** the palette owns `k` and `Ctrl/Cmd+K`; `app.ts` owns `g`+letter, `/`, `?`, `n`, `j`/`k`
  row navigation, `x`, and `Escape`. `app.ts:onKey` hard-rejects every modifier, so a new `Cmd+…`
  binding belongs in the palette's listener. The palette registers its handler through
  `addEventListener` **and** the DOM level-0 `document.onkeydown` slot, stamping the event so
  whichever fires second is a no-op, same reason as the inline-onclick note above, plus Firefox
  refuses to give a page `Ctrl/Cmd+K` at all (hence bare `k`).
- **Dates:** the server compares in *local* time (`date('Y-m-d')`). Use `localDate()` /
  `localDateTime()` / `todayStr()` from `ui.ts`; never `toISOString()` (UTC, wrong day near
  midnight).
- All user data interpolated into HTML goes through `escapeHtml()` (or `safeMarkdown()`).
- Theme: `data-theme` on `<html>`, cached in `localStorage['inphub.theme']` with pre-paint scripts
  in `index.php` and `login.php`; the `settings` table stays the source of truth.
- AI visibility: `refreshAiAvailability()` in `app.ts` re-checks `ai?action=status` and
  shows/hides every AI entry point (chat button, palette entry, brief), Settings calls it after a
  save so toggling AI needs no reload.

## Layout
`config/` DB creds · `db/database.php` PDO singleton + `migrate-*.sql` · `lib/` shared backend ·
`api/` JSON endpoints (all guarded) · `public/` web root (shell, login, compiled assets) · `src/`
TS source · `tools/` CLI helpers.
