-- inphub migration, 2026-09-12
-- Run once against an EXISTING database (phpMyAdmin or:
--   mysql -u root inphub < db/migrate-2026-09-12.sql
-- ). Fresh installs get this from inphub.sql and must NOT run it.

-- v2.0.0, Money period selector, currency-aware AI prompts, global search.
--          (The 1.2.0 work was never released; it ships as part of 2.0.0.)
--
-- No tables or columns change: `settings` is key/value, so the new
-- `starting_balance` key is a data row, not a schema change. Seeding it is
-- optional (the app falls back to '0' when the key is absent) but keeps an
-- upgraded database identical to a fresh install.
--
-- INSERT IGNORE relies on uq_setting_user_key, so re-running is harmless and
-- an existing value is never overwritten. Applies to every account, not just
-- user 1.
INSERT IGNORE INTO `settings` (`user_id`,`setting_key`,`setting_value`)
SELECT `id`, 'starting_balance', '0' FROM `users`;

-- v2.0.0 adds no further keys and no structural change: global search reads
-- existing tables, and the focus/habit/todo fixes all use columns that were
-- already in the schema (habit_logs.count, focus_sessions.linked_todo_id,
-- todos.completed_at, repo_suggestions.status) but had no code writing them.
