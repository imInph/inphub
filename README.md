# inphub

v3.0.0, MIT licensed.

A dashboard I built for myself to keep track of my own stuff in one place: money,
tasks, habits, goals, notes, focus sessions, my GitHub repos, and a log of what I
changed. There's an optional AI chat on top of it (Claude, or Ollama / LM Studio
running locally) but it's off by default and everything works without it.

It's PHP 8 and MySQL on the backend with no framework, and TypeScript on the
frontend compiled to plain ES modules. No React, no bundler. It runs on XAMPP on
my own machine, not on a server.

Some stuff you might want to know if you look around:

- The dashboard is all widgets now. The button next to the Google search bar
  opens a popup where you can turn widgets on and off, drag them into whatever
  order you want and make some of them wide. They fill in the gaps by themselves
  so there are no weird empty spots. My site shortcuts are in a bar on the right
  (on a phone it moves to the top) and you edit those in the same popup.
- Settings has an Appearance section: dark or light, an accent color, and a
  wallpaper (a few built in ones, or paste a link to your own picture). The
  inphub logo can follow either the accent color or the wallpaper's colors. The
  panels are see-through like the new iOS look, so if that's too much or your
  laptop starts lagging, turn on Reduce transparency.
- Press `k` (or Ctrl/Cmd+K) to search across tasks, money, notes, habits, goals
  and repos, then Enter to jump to whatever you picked. `?` shows the shortcuts.
- The Insights tab has charts that span the different sections: spend by weekday,
  how consistent I've been with habits, focus minutes and tasks finished over
  time, and which hours of the day I actually do things.
- Notes support basically all of markdown now, the GitHub kind: tables,
  checklists you can tick straight from the note, footnotes, images. If you put
  a YouTube, Vimeo, Spotify or SoundCloud link on its own line it turns into a
  player. The markdown libraries are saved in `public/assets/vendor/`, so it
  still doesn't load anything from a CDN.

## What you need

- PHP 8.2 or newer with PDO MySQL, cURL and mbstring. XAMPP includes all of them.
- MySQL or MariaDB.
- Node 18+, but only if you change the TypeScript. The compiled JS is already in
  the repo, so you don't need it just to run the app.

## Setting it up

```bash
# 1. Database. This also creates the admin user with password "changeme".
mysql -u root < inphub.sql

# 2. Config. Just DB credentials. The defaults work on a stock XAMPP.
cp config/config.example.php config/config.php

# 3. Frontend. Only if you're editing src/, the built JS is already there.
npm install
npm run build        # or npm run watch while you're editing
```

Then go to http://localhost/inphub/public/ and log in as `admin` / `changeme`.
Change that password straight away, it's written down in this file.

Use `npm run build`, not plain `tsc`. The build also runs
`tools/stamp-modules.mjs`, which adds a version to every compiled import and
writes `public/assets/js/build-id.txt` for `index.php` to read. Skip it and the
browser can end up loading a new `app.js` next to an old cached `ui.js`, which
throws a module error and stops the whole app from starting without explaining
itself. I lost an hour to that one.

The compiled JS in `public/assets/js/` is committed on purpose. Before v2.1.2 it
wasn't, so a download from GitHub showed the sidebar and then just a blank page,
because there was no JS to run. If you change anything in `src/`, run the build
and commit what it outputs along with your change.

## Changing your password

Settings, then the Password box. Needs the current one, and a new one of 8
characters or more. Other devices you stayed logged in on get signed out.

## Copying it to the XAMPP machine

The whole folder goes into `htdocs`:

1. If you changed anything in `src/`, run `npm run build` first.
2. Copy the `inphub/` folder into `C:\xampp\htdocs\`. You can skip `node_modules/`.
3. Import `inphub.sql` there and copy `config/config.example.php` to
   `config/config.php`.
4. Open http://localhost/inphub/public/.

Paths are all relative or `__DIR__`-based and filenames are lowercase, so it
works on Windows without changes.

## Upgrading an older copy

If your database is from before v2.0.0, run the migration once. If you're already
on 2.0.0 or newer you don't have to do anything, the newer settings (LM Studio,
widgets, appearance) just use their defaults until you change them.

```bash
mysql -u root inphub < db/migrate-2026-09-12.sql
```

It uses `INSERT IGNORE`, so running it twice is fine and it won't overwrite
anything you've already set. A fresh install gets all of this from `inphub.sql`
and shouldn't run it.

## Adding another user

There's no sign-up page. You hash a password and insert a row yourself:

```bash
php tools/hashpw.php "theirPassword"
```

```sql
INSERT INTO users (username, password_hash, display_name, role, is_active)
VALUES ('someone', '<paste-hash>', 'Some One', 'user', 1);
```

The first time they log in, the app fills in their default settings, expense
categories and habits to match what user 1 gets. Admins can also switch accounts
on and off under Settings, Accounts.

## The AI part

Off unless you turn it on. In Settings, AI assistant, pick a provider:

- Claude: paste an Anthropic API key. Default model is `claude-sonnet-5`.
- Ollama: point it at your local instance (`http://localhost:11434` by default)
  and a model you've pulled.
- LM Studio: start the server in LM Studio first (Developer tab, or
  `lms server start`), then point it at `http://localhost:1234` and type in the
  name of a model you've downloaded. Leave the API key empty unless you turned
  auth on in LM Studio. If LM Studio is on a different computer than inphub, you
  also have to switch on "Serve on Local Network" or it just won't connect.

There's a Test connection button. Anything the AI changes gets written to the
activity log with `actor = ai`, so you can see what it did.

It used to guess when I was vague, like completing a random "Email Ali" task when
I had two of them, or saying it logged something when it actually failed. Now if
it's not sure which thing you mean it asks first, and if an action fails it gets
one more try to fix it or ask you, instead of pretending it worked.

Smaller local models needed the instructions spelled out more than Claude did
before they could use the actions reliably, and the reply parser accepts a few
different JSON shapes because they don't all format it the same way. Thinking
models work too, the thinking part just gets thrown away and the app only reads
the actual answer.

If you want the chat's developer mode for your own account, add
`'developer_user' => 'yourname'` to `config/config.php`. Empty means nobody gets
it, which is the default.

## Commands

| Command | What it does |
| --- | --- |
| `npm run build` | Compiles `src/*.ts` into `public/assets/js/` and stamps the build id |
| `npm run watch` | Recompiles while you edit |
| `npm run vendor` | Copies marked, DOMPurify and the footnote plugin into `public/assets/vendor/`. Only needed if you update them |
| `php -l <file>` | Syntax-checks one PHP file. There are no tests. |
| `php tools/hashpw.php "pw"` | Prints a bcrypt hash for a new user |

## Layout

```
config/   DB credentials (config.php is git-ignored)
db/       PDO connection and the dated migration files
lib/      shared backend: auth, helpers, provisioning, activity log, github, ai
api/      the JSON endpoints, all behind a login and scoped to one user
public/   web root: app shell, login, css, icons, compiled JS, vendored libraries
src/      TypeScript source
tools/    hashpw, the build-id stamper and the vendor copy script
```

Every `/api/*` endpoint replies with the same envelope, `{ "ok": true, "data": ... }`
or `{ "ok": false, "error": "..." }`, and every query is filtered by the logged-in
user's id.

## About security

- Passwords go through `password_hash()` (bcrypt). Sessions are cookies, with a
  remember-me token that's stored hashed and rotated each time it's used.
- Queries use prepared statements, so user input never gets concatenated into SQL.
- The GitHub token and AI API keys are per-user, kept in the database, shown in
  password fields and masked when read back.
- Markdown (notes, AI replies, GitHub READMEs) goes through DOMPurify before it
  ends up on the page, so HTML in a note can't run scripts. Video embeds are
  built from the video id, not from whatever the link says.

This is meant for localhost and I haven't hardened it for the internet. There's
no rate limiting on the login form and no CSRF tokens. Because the folder sits
inside `htdocs`, files outside `public/` (`inphub.sql`, `db/*.sql`,
`tools/hashpw.php`) can be fetched over HTTP unless you point the document root
at `public/` or block them. Don't put it on a public server as it is.

There are no automated tests. I check things by hand against a running XAMPP.

## License

[MIT](LICENSE). Do what you want with it, no warranty.
