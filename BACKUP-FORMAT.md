# The inphub backup format

One file that **inphub** and **inphub lite** both write and both read. It is how
you move between them, and how you back either one up.

This file is identical in both repos. If you change it, change it in both, and
bump `format_version`.

## The file

UTF-8 JSON, saved as `inphub-backup-YYYY-MM-DD.txt`.

The `.txt` is deliberate. It is the same thing csTimer does, it survives being
pasted into a chat or an email that would block a `.json`, and it opens in
anything. Importers accept `.json` too; nothing reads the extension.

```json
{
  "format": "inphub-backup",
  "format_version": 1,
  "app": "inphub",
  "app_version": "3.2.0",
  "exported_at": "2026-09-21T17:40:00",
  "counts": { "todos": 412, "expenses": 3871 },
  "data": {
    "settings": [],
    "expense_categories": [],
    "expenses": [],
    "todos": [],
    "habits": [],
    "habit_logs": [],
    "goals": [],
    "notes": [],
    "focus_sessions": [],
    "repos": [],
    "activity_log": [],

    "repo_suggestions": [],
    "daily_briefs": [],
    "chat_sessions": [],
    "chat_messages": []
  }
}
```

Tables live under `data` and nowhere else, so `Object.keys(data)` is the table
list and an importer needs no separate whitelist that can drift from it.

`counts` is redundant with the arrays, which is the point: it is a cheap
integrity check and it lets a confirmation dialog show numbers without parsing
everything twice.

The last four tables are inphub's AI and chat history. lite has nowhere to put
them, so it skips them and says how many rows it skipped rather than dropping
them silently. Writing them keeps an inphub-to-inphub restore lossless.

## Rules both sides follow

**No `user_id`.** inphub strips it on export and stamps the importing account's
own id back on. lite has no such column. A user id that travelled between
installs would be meaningless at best.

**Datetimes are `YYYY-MM-DDTHH:mm:ss`, local wall clock, no `Z` and no offset.**
Dates are `YYYY-MM-DD`. MySQL writes datetimes with a space; the exporter
converts and the importer converts back. This matters more than it looks: mixing
the two forms in one table breaks sorting outright, because a space is `0x20` and
a `T` is `0x54`, so every space-form row sorts before every T-form row whatever
the date says. Local rather than UTC because inphub read `TIMESTAMP` columns in
server-local time and Insights buckets by `HOUR(created_at)`; shifting those by
an offset does not break the chart, it just makes it lie.

**Numbers are JSON numbers.** PDO with `EMULATE_PREPARES` off hands `DECIMAL` and
often `INT` back as strings, so inphub casts on the way out. An importer still
coerces on the way in, because an older file may carry `"42.50"`.

**Booleans are `0` or `1`**, as `TINYINT(1)` gave them to both frontends.

**`settings` is a list of `{"key": ..., "value": ...}`**, not MySQL rows. No
`id`, no `user_id`, no `updated_at`.

**Secrets are never exported.** `github_token`, `claude_api_key` and
`lmstudio_api_key` are omitted entirely. A backup is a file people email
themselves. Both apps tell you to re-enter them after an import.

**JSON columns are real JSON.** `activity_log.metadata` and `chat_messages.actions`
are objects or `null`, never a string holding JSON, which is how PDO returns them.

**`id` is written as it stands.** What happens to it is the importer's decision,
not the file's.

## Importing

Two modes, and no third. Ambiguity in a restore path is how people lose data.

**Replace** is the default and the right answer for "restore my backup" or "move
to the other app". It clears the destination first and inserts with the original
ids, which is the only way `activity_log.entity_id` and any bookmarked deep link
survive. In inphub it clears only the importing account's rows.

**Merge** keeps what is already there and never trusts an incoming id. It inserts
in dependency order and rewrites every foreign key through a remap as it goes:

```
expense_categories -> expenses
todos              -> focus_sessions
habits             -> habit_logs
repos              -> repo_suggestions
chat_sessions      -> chat_messages
goals, notes, settings, activity_log
```

Collisions are resolved, not inserted:

- `habit_logs` on `(habit_id, logged_date)` takes `max(count)`. Summing is the
  obvious choice and it is wrong, because importing the same file twice would
  double every day.
- `expense_categories` and `habits` on `name`, and `repos` on `full_name`, reuse
  the existing row's id rather than creating a second "Food & Drink". Habits are
  matched even though the schema has no unique key on them: without it, merging
  a backup doubles every habit, and the logs attach to the new copy so the rule
  above can never fire.
- `settings`: the incoming value wins for keys present, the rest are left alone.
- `activity_log` dedupes on `(created_at, type, summary)`, so a re-import does not
  triple the hours-of-day chart.

An import validates everything in memory and shows you the counts before it
writes. A structural problem (a table that is not a list, a row missing a required
field, a type that cannot be coerced) rejects the whole file. A soft one (an
unknown enum value, an unknown column, a missing optional) is a warning and the
import continues.

Both apps write everything in one transaction, so a failure leaves the database
exactly as it was.

## Version history

- **1** first shared format. inphub 3.2.0, inphub lite 1.0.0.
