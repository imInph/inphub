# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

`inphub` is a personal life-dashboard (expenses, GitHub repos, todos, habits, goals, notes, focus
sessions, activity history) with hand-created logins and an optional AI layer. The backend is
**ASP.NET Core (.NET 10, C#) in `server/`** on MySQL/MariaDB over **plain ADO.NET**
(MySqlConnector; no EF, no Dapper); the TypeScript frontend compiles to plain ES-module JS (no
React, no bundler). The owner develops and runs it locally on macOS (`cd server && dotnet run` →
`http://localhost:5080`, MySQL from XAMPP); there is no remote server, shipping means commit + push
to GitHub. It was PHP until v4.0 moved most of it and v4.1 moved the AI layer and the backup format,
so there is no PHP, Apache or bridge left. How it gets installed/run for others (the owner wants to
script it) is still open.

The original specification lives in `inphub-prompt.md` (kept locally, gitignored, not in the
public repo). **The database schema is `inphub.sql` and must
be matched exactly, never invent or alter tables/columns.** If a schema change is approved, put the
`CREATE`/`ALTER` in a dated `db/migrate-YYYY-MM-DD.sql` for existing databases AND mirror it in
`inphub.sql` for fresh installs (see `db/migrate-2026-07-19.sql` / `chat_sessions`).

The app version is `AppInfo.Version` in `server/Core/AppInfo.cs` (sidebar, login footer, the
backup file's `app_version`). Bump it together with `version` in `package.json`, the `vX.Y.Z` line
at the top of `README.md`, and the console stamp at the end of `init()` in `src/app.ts` (hardcoded
on purpose: it proves which `app.js` the browser actually loaded).

## Writing C# here (owner's rules)

The whole point of v4 is that the owner can open a file and follow it. Keep it **plain**: Minimal
APIs, static classes, SQL written out in full through `Db` (plain ADO.NET: `MySqlCommand` with
`@name` parameters taken from an anonymous object or a dictionary), a `switch` on the action. No
Entity Framework, no Dapper, no repository layers, no DI ceremony, no clever LINQ chains.
**Comments: one short line per method, nothing else** unless a line is truly baffling without one.
No XML-doc blocks, no section banners. One file per area, named after what it serves.

## Commands

- **Run the server:** `cd server && dotnet run` → `http://localhost:5080` (profile in
  `Properties/launchSettings.json`). `dotnet build` is the compile check; there is no C# test suite.
  Stop a stale instance with `pkill -f bin/Debug/net10.0/Inphub` before rebuilding.
- **Build frontend:** `npm run build`, `tsc` **and then** `tools/stamp-modules.mjs`. Never run
  bare `tsc`: the stamper rewrites every compiled import to `./ui.js?v=<build id>` and writes
  `public/assets/js/build-id.txt`, which `server/Pages/Index.cshtml.cs` reads for the entry
  `<script>` URL. Those two ids **must match**, if the entry is `app.js?v=A` while a module imports
  `./app.js?v=B`, the browser treats them as different modules and evaluates `app.js` twice; the
  second copy runs `init()` while `command-palette.js` is still mid-evaluation and throws
  `Cannot access 'chatEnabled' before initialization`, which kills the palette. And without any
  stamping at all, a fresh `app.js` can pair with a cached `ui.js`, where a missing export is an
  ES-module *link* error that stops the whole app from executing, silently. The index page
  carries a `window.__inphubLoaded` guard that surfaces exactly that failure.
- **Watch:** `npm run watch` (`tsc -w`).
- **Command-line modes** (run the tool, print, exit; the web server never starts; dispatched by
  `Tools/Cli.cs` at the top of `Program.cs`): `dotnet run -- hashpw "pw"` prints a bcrypt hash for
  an `INSERT INTO users`; `dotnet run -- backup-selftest` checks the backup format with no
  database; `dotnet run -- backup-dbtest` checks importing against `inphub_import_test` and
  refuses any other database. Run both backup checks after touching `Services/Backup.cs`.
- **No automated test framework.** Verification is manual against the running app. For backend
  changes, compare an action's JSON between the old and new build with `jq -S` against a throwaway
  database (import `inphub.sql` with the db name swapped, point the server at it with
  `Inphub__DbName=...`), never the owner's real `inphub` db. AI changes can be tested without a
  model by pointing LM Studio's base URL at a tiny fake `/v1/chat/completions` server that answers
  from a script and logs the prompts it received.

## Running locally

1. Import `inphub.sql` (phpMyAdmin or `mysql -u root < inphub.sql`). Seeds admin `admin` / `changeme`.
2. `cp server/appsettings.Local.example.json server/appsettings.Local.json` (DB creds and
   `DeveloperUser`; gitignored). Environment variables (`Inphub__DbName=...`) override it.
3. `npm install && npm run build` (only needed after editing `src/`; the built JS is committed).
4. `cd server && dotnet run`, open `http://localhost:5080` and log in.

The compiled JS in `public/assets/js/` (including `build-id.txt`) **is committed**, so a GitHub
download runs with no Node. It was gitignored before v2.1.2, and a fresh download rendered the
sidebar over a blank page, because the entry-module 404 fires no window `error` event, so the
banner stayed silent; the index page now checks for `app.js` server-side. **Every commit that
touches `src/` must include the rebuilt output from `npm run build`**; the build id is a content
hash, so an unchanged rebuild produces no diff. `server/appsettings.Local.json`,
`server/bin|obj/`, `node_modules/`, and the `inphub-*prompt*.md` notes are gitignored.
`server/.htaccess` denies Apache access to `server/` in case the folder still sits in htdocs, since
the Local file is plain JSON with the DB password.

## Architecture

### Request/response contract (critical, app-wide)
Every `/api/*` endpoint returns one envelope: success `{ "ok": true, "data": ... }`,
failure `{ "ok": false, "error": "..." }` with a matching HTTP status. The frontend `src/api.ts`
(which calls `/api/<name>?action=`) relies on this, never break the shape. In C#:
- `Api.Handle(handler)` / `Api.HandleAsync` (`server/Core/Api.cs`) read the input, enforce login
  (401), and turn the handler's return value into the envelope. `throw Api.Fail("msg", status)`
  is the error path (like PHP's `fail()`); any other exception becomes a 500 envelope. A handler
  that returns an `IResult` (downloads) is sent as-is.
- `Req.Action` is `?action=` or the body's `action` (default `list` for GET). Endpoints `switch`
  on it. `Input` merges query + JSON body (body wins) and converts values the forgiving way PHP
  did: `Str()` (trimmed or null), `Int()`, `IntOrNull()`, `NumOrNull()`, `Bool()`, and
  `StrIfSent()`/`IntIfSent()`/`NumIfSent()` for partial updates (key absent = keep current).
- `Api.FetchOwned(table, id, uid)` loads a row scoped to the owner (404 if foreign); the table is
  whitelisted, never interpolated from user input. `Api.ValidEnum()` sanitises ENUM values.

**JSON must stay shaped the way the old PHP returned it**, because the frontend was written
against it. `Db.Rows()` / `Db.Row()` return `Dictionary<string, object?>` rows with the column
names as keys and PDO's value shapes: `DECIMAL` as a **string** (`"12.50"`), `DATE` as
`"Y-m-d"`, `DATETIME`/`TIMESTAMP` as `"Y-m-d H:i:s"`, `TINYINT(1)` as `0/1` (the connection sets
`TreatTinyAsBoolean=false`). Never add a camelCase naming policy; response objects use snake_case
property names (`new { current_value = … }`). Where the PHP cast to float/int, use
`Stats.Number()` / `Convert.ToInt32()`. (XAMPP's PHP printed floats at 17 digits, .NET prints the
shortest form; same number, not a bug.) Dates: `DateTime.Now` / `AppInfo.Today()`, the Mac's
zone, which MySQL's `NOW()` also uses. (XAMPP's PHP ran on Europe/Berlin, an hour off.)

### Data isolation
This is multi-account. **Every query is scoped to the current user id** (`req.Uid`) and goes through
parameters only (`@uid`, no string-interpolated SQL,
ever; the only interpolations are whitelisted table/column names and clamped `LIMIT` ints). A user
only ever sees their own rows. Rows referenced by id from the client (e.g. `linked_todo_id`) are
ownership-checked via `FetchOwned()` before use.

### Auth (`server/Auth/AuthService.cs`)
ASP.NET cookie authentication (`inphub4_session`, claims `uid` + role) plus remember-me: a random
token whose **SHA-256 hash** is stored in `remember_tokens` (raw token only in an
httponly/SameSite=Lax cookie), rotated on each use by the middleware in `Program.cs`. The cookie
is `inphub4_remember`, **not** v3's `inphub_remember`: cookies ignore the port, so a leftover PHP
copy on :80 would otherwise rotate the server's token. Login is the Razor page
`Pages/Login.cshtml` (+ `/api/auth?action=login` for JSON), `/logout` ends both. Admin checks read
the role from the database, not the cookie. There is no registration, accounts are inserted by
hand. `CurrentUser()` never selects `password_hash`.

### First-login provisioning (`server/Auth/Provisioning.cs`)
`Provisioning.Run(uid)` seeds default settings / expense categories / habits the first time a
hand-added user logs in. **These defaults mirror the seed block in `inphub.sql` for user 1**, if you
change one, change both so a fresh account matches user 1.

### Settings & secrets (`server/Endpoints/SettingsApi.cs`)
Per-user key/value in the `settings` table (theme, currency, GitHub + AI config). Writable keys are
whitelisted (`AllowedKeys`). Secret keys (`github_token`, `claude_api_key`, `lmstudio_api_key`) are
masked on read (`Settings.MaskSecret()`); on save, a value equal to `Settings.SecretUnchanged`
means "keep the stored value" so the mask never overwrites the real secret. The whole request is
validated before anything is written. Saving `ai_enabled` to anything but `'1'` also deletes the
user's stored daily briefs.

### AI layer (`server/Services/Ai.cs`, `Chat.cs`, `ChatActions.cs`, `Brief.cs`, `QuickAdd.cs`, `RepoAnalysis.cs`, `Endpoints/AiApi.cs`), optional, provider-agnostic
Off by default. `Ai.Available(uid)` is the ONE canonical gate for every AI feature; `AiApi` applies
it (403) to every action except `status`, `test_connection` and `quick_add` (unknown actions still
404). `Ai.Generate(uid, system, prompt, maxTokens:, timeout:, model:, rawSystem:)` reads the user's
settings and dispatches to **Claude** (`/v1/messages`), **Ollama** (`/api/chat`) or **LM Studio**
(OpenAI-compatible `/v1/chat/completions`, no max_tokens so local reasoning models aren't cut off;
a leading `<think>…</think>` is stripped) over one static `HttpClient`; feature code never branches
on provider, and `Ai.ActiveModel(c)` is the one provider → model mapping. `model:` overrides the
model for that single call (the chat's per-session combo, fed by `Ai.ListModels()`); it must never
be written to settings.

`Ai.Generate()` prepends `Ai.LocalePreamble(uid)` to every system prompt, the user's currency (code
+ name, "never assume dollars") and today's date. It is the single place app-wide facts belong.
`rawSystem: true` skips it, and the three prompts that demand strict JSON back (`QuickAdd.ByModel`,
`RepoAnalysis.Analyze`, `Ai.TestConnection`) set it, because stray prose breaks their parsers.
**Never let a money figure reach a model without a currency**: use `Money.Text()`, which is also why
`activity_log` summaries carry units, the weekly review reads those rows back to the model.

**Model output is read with PHP's loose rules on purpose.** The prompts and the parser were tuned
against PHP arrays, so `Services/ModelJson.cs` reproduces them on `System.Text.Json.Nodes`:
`Text()` is `(string)`, `Int()`/`Number()` are `(int)`/`(float)` ("12abc" → 12), `IsNumeric()`,
`Truthy()` (PHP `empty()` in reverse, so `"append": "0"` is false), `IsScalar()`, `AsObject()` (a JSON
list seen as an object keyed "0", "1", …), and `At(node, "choices", "0", "message")` for reading a
provider response without throwing on an unexpected shape. Don't swap those for strict
deserialisation: a right answer under a slightly wrong shape has to keep working.

The chat feature uses a portable action protocol (a fenced ```json block of `{actions:[...]}`
validated against `ChatActions.Tools`) instead of native tool-calling, because Ollama tool-use is
inconsistent. Small local models need the mechanism spelled out, the prompt must say that
*emitting the block is* the action (wording like "only include it when you actually performed an
action" reads as "you cannot act" and they skip it), and it carries worked examples. **The prompts
are raw string literals copied verbatim from the tuned PHP; don't reword them casually.** Parsing is
deliberately liberal (`Chat.SplitActions()` → `Chat.NormaliseActions()` →
`ModelJson.ExtractBalanced()`): any fence tag or none (gemma emits ```tool_code), `{actions:[…]}` /
a lone `{tool,args}` / a bare array, and `tool|action|name` + `args|arguments|parameters` key
spellings. The chat snapshot is `Brief.Context(uid, true)`, the `true` adds the row **ids** the
action tools need (and recent notes / money entries, so the edit tools have something to address);
without them those tools cannot be used at all, and the prompt forbids guessing an id. The daily
brief passes `false` (ids are noise in prose a human reads).

`CHAT_ACTIONS` covers every area, not just todos (add/complete/update todo · add/log/unlog habit ·
add/progress/status goal · add/update note · add/update/delete expense · repo suggestion). Three
rules hold for all of them:
- **Exactly one item.** A name must pick out one row: in `ChatActions.Resolve()` an exact title that is
  also contained in other titles ("Email Ali" next to "Email Ali about rent") fails as ambiguous
  with every candidate id, and prompt rule 8 tells the model to ask instead of choosing. Ids skip
  the check; categories are exempt. The resolver also reads the key spellings models invent
  (`habit_name`, `task`, a numeric name) so a right answer under a wrong key still works.
- **Resolve, don't trust.** `ChatActions.Resolve(uid, kind, args)` finds the row by id **or** name
  (models send names however firmly the prompt says otherwise), always scoped to `user_id`, and an
  ambiguous name errors with the candidate ids rather than picking one. Table/column names come
  from the `Entities` map only, never from model output. `delete_expense` deliberately
  refuses a name and demands an id, so a fuzzy match can never delete the wrong row.
- **Fail loudly, in words the model can use.** Throw `ChatActionException` with the actual reason
  ("there is no task with id 999") instead of returning null. `Chat.Turn()` catches it, shows it,
  and `Chat.RecentText()` replays every outcome into the next turn's transcript as a
  `(system: result of those actions, …)` line, that feedback loop is what lets a model correct a
  wrong id instead of silently repeating it. `Chat.ActionResultsLine()` builds that line: successes
  carry the touched row as `[expense id 395]` (from the `ref` that `Done()` returns, never
  shown to the user) and failures carry the args that were sent. That is how "change that to 380"
  finds the row just created. Validate arguments with `Date()` (which also accepts
  "today"/"tomorrow"), `RequiredText()`/`OptionalText()`, `Amount()` rather than letting MySQL reject them.
- **One repair pass.** The reply prose is written before actions run, so when any action fails
  `Chat.Turn()` makes one more `Ai.Generate()` call with the results; its prose replaces the
  first reply (which claimed success) and it may retry **only the tools that failed**, so a
  succeeded `add_*` can never be duplicated. No second round. The chat snapshot lists money entries
  by `id DESC` (recently added), not `spent_at`: post-dated rows used to push today's entry out
  and the model guessed its id. An empty `{"actions": []}` block is still stripped from the reply.
- Every AI-initiated write logs an `activity_log` row with `actor='ai'`.

Chat conversations persist in `chat_sessions` (+ `session_id` on `chat_messages`), titled from the
first user message; legacy rows are backfilled into a `'default'` session. The system prompt is
built only in `Chat.SystemPrompt()` (single-user app facts, username injection, developer-mode
block for the username in `Inphub:DeveloperUser`, empty disables it; it lives in the gitignored
`appsettings.Local.json` so it stays out of the public repo).
Repo AI analysis is cached: within `RepoAnalysis.CooldownHours` it serves
existing `repo_suggestions` (freshness derived from `MAX(created_at)`, no schema column), and a
garbled model reply must never delete previous suggestions.

### Backup / restore (`server/Services/Backup.cs`, `Endpoints/Import.cs`, `Endpoints/Export.cs`)
`BACKUP-FORMAT.md` is the contract, and **an identical copy lives in the inphub-lite
repo**. Both apps read and write the same `.txt`, so a change here without the matching
change there breaks the migration path in one direction only, which is the hardest kind
to notice. Bump `format_version` when the shape changes.

All the parsing, validating and shape conversion is in `Backup.cs`, not the endpoints, so
`dotnet run -- backup-selftest` can exercise it with no web server and no database, and
`backup-dbtest` covers the writing against `inphub_import_test`. Run both after touching it.
`Backup.Apply()` is one transaction: children deleted before parents on a replace, parents
inserted before children always, ids kept on replace and remapped on merge. Merge reuses a
colliding row (category/habit/repo by name, habit_logs by day with max(count), activity by
created_at+type+summary, chat session by id, daily brief by date) instead of inserting it.

The conversions exist because the database hands back `DECIMAL` as strings (`Db.Clean()` keeps
PDO's shapes) and MySQL writes datetimes with a space, while the file uses JSON numbers and
`YYYY-MM-DDTHH:mm:ss`. Mixing the two datetime forms in one table breaks `ORDER BY created_at`
outright, because a space is `0x20` and a `T` is `0x54`. The file is 4-space-indented with letters
and emoji written raw (`Backup.ToFileText()` undoes .NET's `\uD83C\uDF54` pair escaping).
`github_token`, `claude_api_key` and `lmstudio_api_key` are never written to a file.

### Activity log
`Activity.Log(...)` (`server/Core/Activity.cs`) records meaningful mutations (actor `user`/`ai`/`system`). Money summaries always
carry units via `Money.Text()` (`"130.00 TRY"`).
The dashboard, daily brief, and weekly review read from this timeline.

### GitHub sync (`server/Endpoints/SyncRepos.cs` + `server/Services/GitHub.cs`)
Pulls repos via the GitHub REST API, upserts on `(user_id, full_name)`, fetches README excerpt +
license, then computes `staleness_days` and a 0–100 `health_score` (`GitHub.HealthScore()`: README /
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

### Global search (`server/Endpoints/Search.cs`)
Six groups, all scoped to the user. Escape the user's text with `LikeEscape()` and
carry `ESCAPE '!'` on **every** `LIKE`: unescaped, `%` matches everything, and backslash escaping
breaks under `NO_BACKSLASH_ESCAPES`. `LIMIT` is an interpolated clamped int and each group
fetches limit+1 to know whether more exist. Always end `ORDER BY` with `id DESC` or tied rows
reshuffle between keystrokes. The collation (`utf8mb4_unicode_ci`) already matches `İSTANBUL` ↔
`istanbul` ↔ `ıstanbul`, do not "fix" it to `utf8mb4_turkish_ci`, and never re-filter results
client-side, since JS `toLowerCase()` gets Turkish wrong where the DB gets it right.

### Google suggestions (`server/Endpoints/Suggest.cs` + `src/web-search.ts`)
The dashboard bar (`src/dash-search.ts`: a Google group, then "In inphub" from search) and
the palette's Google group both use `fetchSuggestions()` in `web-search.ts`, which also holds the
shared `RESULT_VIEWS` / search types. Suggestions are proxied server-side because Google's suggest
endpoint sends no CORS headers. A slow or failing Google is **never** an error: the endpoint answers
`{ items: [] }` and the UI just shows fewer rows, so keep its short HTTP timeout (3 s).

**Entry animations on containers use fill mode `backwards`, never `both`** (`.view`, dashboard
widgets): a filled opacity/transform animation keeps the element isolated after it ends, so
`backdrop-filter` on any glass inside it stops at that ancestor and blurs nothing behind the view.
An element with its own `backdrop-filter` isolates its contents the same way, so a dimmed overlay
(`.modal-backdrop`, `.palette`) puts its tint + blur on a `::before` layer, never on the element
that contains the glass box.

### Insights (`server/Endpoints/Insights.cs` + `src/insights.ts`)
One `?action=summary&period=` call feeds the whole view; nothing is stored. It reuses
`Money.Window()`, the name is historical, the maths is generic, so Insights and Money share one
period vocabulary. Two details to preserve: `WEEKDAY()` is 0=Monday (unlike `DAYOFWEEK()`, which
starts Sunday) and the frontend derives its labels by walking a known Monday so they stay
localised; and every series is zero-filled by `Stats.SeriesFill()` (the same one the Money chart
uses), so a chart draws a timeline instead of a list of days that happened to have data.
Chart colours are read from the CSS custom properties at draw time, so charts follow the
light/dark switch; every chart instance is destroyed before a redraw.

### Dashboard widgets (`src/widgets.ts`, `src/dashboard.ts`, `src/widget-picker.ts`)
Every widget is an entry in `WIDGETS` (widgets.ts), and its id **must also be in
`Appearance.DashboardWidgets` in `server/Core/Appearance.cs`**: `NormaliseLayout()` drops unknown ids on
save, so a TS-only widget can never be kept. The user's layout is the `dashboard_widgets` setting
(`[{id, size:'normal'|'wide'}]`, enabled widgets only, in order); unset means every widget in
default order. All widgets render from the one `stats?action=dashboard` payload; the few with
live behaviour get `mount()` after insertion (the clock uses one module-wide interval that looks
nodes up each tick, never captured ones). Masonry packing is `masonry()` in dashboard.ts: a 4px
`grid-auto-rows` grid where each widget spans rows from its `.widget-inner` height, then a second
pass stretches a widget down into any hole a Wide widget left. The `ResizeObserver` is module-level
and disconnected on every render. `ROW_UNIT` must equal `grid-auto-rows` in app.css. The Customize
sheet's lists use `data-role="pick-*"` because `data-role="widgets"`/`"shortcuts"` already exist in
the dashboard DOM.

### Appearance ("Glass" design system)
`<html>` carries `data-theme`, `data-accent`, `data-wallpaper`, `data-glass` (full|reduced) and
`data-logo` (accent|wallpaper: where the sidebar/login `.logo` badge gets its gradient; plain and
custom wallpapers have no palette, so the Settings toggle locks to accent there and `SettingsApi`
/ `Appearance.For()` force `ui_logo_tint` to `accent`), plus `--wp-image` for a custom wallpaper. Settings keys
`ui_accent` / `ui_wallpaper` / `ui_wallpaper_url` / `ui_transparency` / `ui_logo_tint` are
whitelisted and validated in `SettingsApi` against the lists in `server/Core/Appearance.cs` and
`Appearance.IsHttpUrl()`; `Appearance.For()` gives the index page the server values, and a stored
URL only reaches CSS through `Appearance.CssUrl()` (C#) / `cssUrl()` (app.ts). Like the theme, the
last saved look is cached in `localStorage['inphub.appearance']` and applied by the pre-paint
scripts in `Pages/Index.cshtml` and `Pages/Login.cshtml`; always go through `applyTheme()` /
`applyAppearance()` in app.ts, which keep that cache in sync (Settings previews call them with
`remember=false`). In app.css, keep every v2 token name (`--bg`, `--bg-elev`, `--card`, `--border`,
`--text-dim`, `--accent`, …): inline styles use them and the charts read `--accent/--good/--warn/--bad/
--text-dim/--border` at draw time, so those must stay plain colours, never `color-mix()`. Glass
surfaces take their colour from `--glass-bg(-strong)` and blur from `--glass-blur`, which the
reduced-transparency blocks swap for opaque values, so never hardcode a translucent background
on a new panel. Only `<html>` paints `--bg`: a body background would cover the `z-index:-1`
wallpaper. The page title lives in the topbar (`#page-title`, set by `activate()`), so views do not
render their own `<h2>`.

### Frontend (`src/`)
`app.ts` is the SPA shell (hash routing, lazy per-view data load, theme, clock, keyboard shortcuts,
mobile drawer nav). Each view module (`todos.ts`, `expenses.ts`, …) exposes a render entry point
mounted into its `#view-<id>` section in `server/Pages/Index.cshtml`. `ui.ts` holds toasts/modals/
formatting and `markdown()`. Chart.js, marked (+ marked-footnote) and DOMPurify are vendored in
`public/assets/vendor/` (committed, loaded by `defer` tags in `Pages/Index.cshtml`, used as
globals; refresh them with `npm install && npm run vendor`, then update the file names there).

`markdown(src, {embeds, tasks})` is marked (GFM, breaks, footnotes) → DOMPurify → a DOM pass. Its
output renders notes, chat, the brief, the weekly review and **GitHub READMEs**, so keep the
sanitiser strict: `ALLOW_DATA_ATTR: false` (a `data-action` in content would fire a view's
`onAction()` handler), `SANITIZE_NAMED_PROPS` (ids get `user-content-`, no shadowing `#toasts`),
no style/forms/iframes, and classes filtered to `SAFE_CLASS` (raw `class="palette"` would be a
full-screen overlay). The only iframes are players `buildEmbed()` assembles from an id parsed out
of a bare YouTube/Vimeo/Spotify/SoundCloud link. `#anchor` links are intercepted and scrolled
within their `.md` block, because a hash change is a route change. Task checkboxes are marked
with a per-page class so only real `- [ ]` items can toggle; `toggleMarkdownTask()` edits the n-th
marker outside code fences and refuses when the rendered and source counts differ.

Conventions that prevent recurring bugs:
- **View containers are persistent nodes whose `innerHTML` is swapped on every render.** Wire
  delegated clicks through `onAction()` in `ui.ts`, it is idempotent (WeakMap-backed; re-calling
  replaces the handler). Never add a raw `addEventListener` to a `#view-*` container from a render
  function, and never capture child nodes across renders (query the live container instead, see
  `focus.ts`).
- **Topbar/drawer chrome (theme button, hamburger, nav backdrop) is wired through inline `onclick`
  attributes in `Pages/Index.cshtml`** calling `window.inphubToggleTheme` / `window.inphubDrawer`, which
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
- **Dates:** the server compares in *local* time (`AppInfo.Today()`). Use `localDate()` /
  `localDateTime()` / `todayStr()` from `ui.ts`; never `toISOString()` (UTC, wrong day near
  midnight).
- All user data interpolated into HTML goes through `escapeHtml()` (or `markdown()`).
- Theme: `data-theme` on `<html>`, cached in `localStorage['inphub.theme']` with pre-paint scripts
  in the Index and Login pages; the `settings` table stays the source of truth.
- AI visibility: `refreshAiAvailability()` in `app.ts` re-checks `ai?action=status` and
  shows/hides every AI entry point (chat button, palette entry, brief), Settings calls it after a
  save so toggling AI needs no reload.

## Layout
`server/` the ASP.NET app: `Program.cs` wiring · `Core/` Db, Api, Input, Settings, Money,
Appearance, Activity · `Auth/` login, remember-me, provisioning · `Endpoints/` one file per
`/api/<name>` · `Services/` Ai, Chat, ChatActions, Brief, QuickAdd, RepoAnalysis, ModelJson, Backup,
GitHub · `Tools/` command-line modes · `Pages/` Index + Login (Razor). `public/` web root (compiled
assets, css, icons; served by the server as static files) · `src/` TS source · `db/`
`migrate-*.sql` · `tools/` the build-id stamper and the vendor copy script.
