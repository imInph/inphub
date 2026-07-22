# inphub

**v1.0.2**

A personal life-dashboard — expenses, GitHub repos, todos, habits, goals, notes, focus sessions,
and an activity history — behind a hand-provisioned login, with an **optional** AI layer (Claude or
a local Ollama). Plain PHP 8 backend (no framework), TypeScript frontend compiled to plain ES
modules (no React, no bundler). Runs locally on XAMPP.

## Requirements

- PHP 8.2+ with PDO MySQL and cURL (XAMPP bundles these)
- MySQL / MariaDB
- Node.js 18+ **on a dev machine** — only needed to compile the TypeScript once

## Setup (dev machine)

```bash
# 1. Database — imports schema + seeds admin imInph / changeme
mysql -u root < inphub.sql            # or import inphub.sql via phpMyAdmin

# 2. Config — DB creds only; default XAMPP values work as-is
cp config/config.example.php config/config.php

# 3. Frontend — compile src/*.ts → public/assets/js/*.js
npm install
npm run build                         # or: npm run watch  (recompiles on save)
```

Then open **http://localhost/inphub/public/** and log in with `imInph` / `changeme`.

> The compiled JS in `public/assets/js/` is **git-ignored / not committed** — you must run
> `npm run build` at least once before the app shell works. `login.php` is server-rendered, so
> logging in works even before the build, but the dashboard needs the compiled modules.

## Deploying to the XAMPP laptop

This project is designed to be **copied as a folder** into `htdocs/inphub`:

1. On the dev machine, run `npm run build` so `public/assets/js/` is populated.
2. Copy the whole `inphub/` folder into `C:\xampp\htdocs\` (you can skip `node_modules/`).
3. Import `inphub.sql` on the laptop and create `config/config.php` there.
4. Browse to `http://localhost/inphub/public/`.

All paths are relative / `__DIR__`-based and all filenames are lowercase, so the copy works
unchanged on Windows.

## Adding a user

There is no sign-up. Hash a password and insert a row:

```bash
php tools/hashpw.php "theirPassword"
```

```sql
INSERT INTO users (username, password_hash, display_name, role, is_active)
VALUES ('someone', '<paste-hash>', 'Some One', 'user', 1);
```

On first login the app seeds that user's default settings, expense categories, and habits
(mirroring what `inphub.sql` gives user 1). Admins can also activate/deactivate accounts from
**Settings → Accounts**.

## AI layer (optional)

Off by default. In **Settings → AI assistant**, enable it and choose a provider:

- **Claude** — paste an Anthropic API key; default model `claude-sonnet-5`.
- **Ollama** — point at a local instance (default `http://localhost:11434`) and a pulled model.

Use **Test connection** to verify. Every AI-initiated change is written to the activity log with
`actor = ai`.

## Commands

| Command | What it does |
| --- | --- |
| `npm run build` | Compile `src/*.ts` → `public/assets/js/` |
| `npm run watch` | Recompile on change |
| `php -l <file>` | Syntax-check a PHP file (no test suite) |
| `php tools/hashpw.php "pw"` | Print a bcrypt hash for a new user |

## Layout

```
config/   DB credentials (config.php is git-ignored)
db/       PDO singleton
lib/      shared backend (auth, helpers, provisioning, activity, github, ai)
api/      JSON endpoints — every one guarded + scoped to the logged-in user
public/   web root (app shell, login, compiled assets, css)
src/      TypeScript source
tools/    CLI helpers (hashpw)
```

Every `/api/*` endpoint returns one envelope — `{ "ok": true, "data": … }` on success,
`{ "ok": false, "error": "…" }` on failure — and scopes all queries to the logged-in user.

## Security notes

- Passwords are bcrypt (`password_hash`); sessions are cookie-based with a rotating,
  hashed remember-me token.
- All SQL uses prepared statements; no user input is ever interpolated into a query.
- Secrets (GitHub token, Claude key) are stored per-user, rendered in password fields, and
  **masked on read** — never echoed back in full.

There is **no automated test suite**; verification is manual against a running XAMPP instance.
