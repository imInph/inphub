-- ============================================================
--  inphub — personal daily-life dashboard
--  MySQL / MariaDB schema (XAMPP, phpMyAdmin)
--
--  Import via phpMyAdmin > Import, or:  mysql -u root < inphub.sql
--  Charset: utf8mb4 (full unicode, emoji-safe)
--
--  Accounts are created MANUALLY (no register page). A default
--  admin is seeded below:  username = admin  /  password = changeme
--  >>> CHANGE THE PASSWORD AFTER FIRST LOGIN. <<<
--  To add more users, use tools/hashpw.php to make a hash, then
--  INSERT into `users` (see the template at the bottom of this file).
-- ============================================================

CREATE DATABASE IF NOT EXISTS `inphub`
  CHARACTER SET utf8mb4
  COLLATE utf8mb4_unicode_ci;
USE `inphub`;

-- ------------------------------------------------------------
-- 1. users  — login accounts (created by hand via SQL)
-- ------------------------------------------------------------
CREATE TABLE `users` (
  `id`             INT AUTO_INCREMENT PRIMARY KEY,
  `username`       VARCHAR(50) NOT NULL,
  `password_hash`  VARCHAR(255) NOT NULL,          -- PHP password_hash() (bcrypt)
  `display_name`   VARCHAR(100) NULL,
  `role`           ENUM('admin','user') NOT NULL DEFAULT 'user',
  `is_active`      TINYINT(1) NOT NULL DEFAULT 1,
  `created_at`     TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `last_login_at`  TIMESTAMP NULL,
  UNIQUE KEY `uq_username` (`username`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ------------------------------------------------------------
-- 2. remember_tokens  — persistent "keep me logged in" cookies
-- ------------------------------------------------------------
CREATE TABLE `remember_tokens` (
  `id`          INT AUTO_INCREMENT PRIMARY KEY,
  `user_id`     INT NOT NULL,
  `token_hash`  VARCHAR(255) NOT NULL,             -- store a HASH of the cookie token, never raw
  `expires_at`  DATETIME NOT NULL,
  `user_agent`  VARCHAR(255) NULL,
  `created_at`  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX `idx_rt_user` (`user_id`),
  INDEX `idx_rt_hash` (`token_hash`),
  CONSTRAINT `fk_rt_user` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`)
    ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ------------------------------------------------------------
-- 3. todos
-- ------------------------------------------------------------
CREATE TABLE `todos` (
  `id`            INT AUTO_INCREMENT PRIMARY KEY,
  `user_id`       INT NOT NULL,
  `title`         VARCHAR(255) NOT NULL,
  `description`   TEXT NULL,
  `status`        ENUM('todo','in_progress','done','archived') NOT NULL DEFAULT 'todo',
  `priority`      ENUM('low','medium','high','urgent') NOT NULL DEFAULT 'medium',
  `project`       VARCHAR(100) NULL,
  `tags`          VARCHAR(255) NULL,
  `due_date`      DATE NULL,
  `recurring`     VARCHAR(20) NULL,               -- 'daily'|'weekly'|'monthly'|NULL
  `sort_order`    INT NOT NULL DEFAULT 0,
  `created_by`    ENUM('user','ai') NOT NULL DEFAULT 'user',
  `created_at`    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  `completed_at`  TIMESTAMP NULL,
  INDEX `idx_todos_user`   (`user_id`),
  INDEX `idx_todos_status` (`status`),
  INDEX `idx_todos_due`    (`due_date`),
  CONSTRAINT `fk_todos_user` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`)
    ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ------------------------------------------------------------
-- 4. expense_categories
-- ------------------------------------------------------------
CREATE TABLE `expense_categories` (
  `id`             INT AUTO_INCREMENT PRIMARY KEY,
  `user_id`        INT NOT NULL,
  `name`           VARCHAR(100) NOT NULL,
  `color`          VARCHAR(7)  NOT NULL DEFAULT '#6b7280',
  `icon`           VARCHAR(50) NULL,
  `monthly_budget` DECIMAL(12,2) NULL,
  `created_at`     TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY `uq_cat_user_name` (`user_id`,`name`),
  CONSTRAINT `fk_cat_user` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`)
    ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ------------------------------------------------------------
-- 5. expenses
-- ------------------------------------------------------------
CREATE TABLE `expenses` (
  `id`                 INT AUTO_INCREMENT PRIMARY KEY,
  `user_id`            INT NOT NULL,
  `type`               ENUM('expense','income') NOT NULL DEFAULT 'expense',
  `amount`             DECIMAL(12,2) NOT NULL,
  `currency`           VARCHAR(3) NOT NULL DEFAULT 'TRY',
  `category_id`        INT NULL,
  `description`        VARCHAR(255) NULL,
  `payment_method`     VARCHAR(50) NULL,
  `spent_at`           DATE NOT NULL,
  `is_recurring`       TINYINT(1) NOT NULL DEFAULT 0,
  `recurring_interval` VARCHAR(20) NULL,
  `created_by`         ENUM('user','ai') NOT NULL DEFAULT 'user',
  `created_at`         TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX `idx_exp_user` (`user_id`),
  INDEX `idx_exp_date` (`spent_at`),
  CONSTRAINT `fk_exp_user` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`)
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `fk_exp_cat` FOREIGN KEY (`category_id`) REFERENCES `expense_categories`(`id`)
    ON DELETE SET NULL ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ------------------------------------------------------------
-- 6. repos  — GitHub repositories synced from the API
-- ------------------------------------------------------------
CREATE TABLE `repos` (
  `id`              INT AUTO_INCREMENT PRIMARY KEY,
  `user_id`         INT NOT NULL,
  `github_id`       BIGINT NULL,
  `name`            VARCHAR(255) NOT NULL,
  `full_name`       VARCHAR(255) NOT NULL,          -- owner/repo
  `description`     TEXT NULL,
  `url`             VARCHAR(500) NULL,
  `language`        VARCHAR(100) NULL,
  `stars`           INT NOT NULL DEFAULT 0,
  `forks`           INT NOT NULL DEFAULT 0,
  `open_issues`     INT NOT NULL DEFAULT 0,
  `default_branch`  VARCHAR(100) NOT NULL DEFAULT 'main',
  `is_archived`     TINYINT(1) NOT NULL DEFAULT 0,
  `is_private`      TINYINT(1) NOT NULL DEFAULT 0,
  `has_readme`      TINYINT(1) NOT NULL DEFAULT 0,
  `has_license`     TINYINT(1) NOT NULL DEFAULT 0,
  `readme_excerpt`  MEDIUMTEXT NULL,                -- cached README text for AI analysis
  `health_score`    INT NULL,                       -- 0-100
  `staleness_days`  INT NULL,
  `last_pushed_at`  DATETIME NULL,
  `last_synced_at`  DATETIME NULL,
  `pinned`          TINYINT(1) NOT NULL DEFAULT 0,
  `created_at`      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY `uq_repo_user_fullname` (`user_id`,`full_name`),
  INDEX `idx_repos_stale` (`staleness_days`),
  CONSTRAINT `fk_repos_user` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`)
    ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ------------------------------------------------------------
-- 7. repo_suggestions  — AI-generated update/improvement ideas
-- ------------------------------------------------------------
CREATE TABLE `repo_suggestions` (
  `id`          INT AUTO_INCREMENT PRIMARY KEY,
  `user_id`     INT NOT NULL,
  `repo_id`     INT NOT NULL,
  `title`       VARCHAR(255) NOT NULL,
  `detail`      TEXT NULL,
  `category`    ENUM('feature','docs','refactor','testing','ci','security','other') NOT NULL DEFAULT 'other',
  `priority`    ENUM('low','medium','high') NOT NULL DEFAULT 'medium',
  `status`      ENUM('open','done','dismissed') NOT NULL DEFAULT 'open',
  `created_at`  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX `idx_sug_repo` (`repo_id`),
  CONSTRAINT `fk_sug_user` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`)
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `fk_sug_repo` FOREIGN KEY (`repo_id`) REFERENCES `repos`(`id`)
    ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ------------------------------------------------------------
-- 8. habits
-- ------------------------------------------------------------
CREATE TABLE `habits` (
  `id`                INT AUTO_INCREMENT PRIMARY KEY,
  `user_id`           INT NOT NULL,
  `name`              VARCHAR(255) NOT NULL,
  `description`       TEXT NULL,
  `frequency`         ENUM('daily','weekly') NOT NULL DEFAULT 'daily',
  `target_per_period` INT NOT NULL DEFAULT 1,
  `color`             VARCHAR(7) NOT NULL DEFAULT '#4f8cff',
  `icon`              VARCHAR(50) NULL,
  `is_active`         TINYINT(1) NOT NULL DEFAULT 1,
  `sort_order`        INT NOT NULL DEFAULT 0,
  `created_at`        TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX `idx_habits_user` (`user_id`),
  CONSTRAINT `fk_habits_user` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`)
    ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ------------------------------------------------------------
-- 9. habit_logs  — one row per habit per day done
-- ------------------------------------------------------------
CREATE TABLE `habit_logs` (
  `id`          INT AUTO_INCREMENT PRIMARY KEY,
  `user_id`     INT NOT NULL,
  `habit_id`    INT NOT NULL,
  `logged_date` DATE NOT NULL,
  `count`       INT NOT NULL DEFAULT 1,
  `note`        VARCHAR(255) NULL,
  `created_at`  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY `uq_habit_day` (`habit_id`,`logged_date`),
  INDEX `idx_hl_user` (`user_id`),
  CONSTRAINT `fk_hl_user` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`)
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `fk_hl_habit` FOREIGN KEY (`habit_id`) REFERENCES `habits`(`id`)
    ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ------------------------------------------------------------
-- 10. goals
-- ------------------------------------------------------------
CREATE TABLE `goals` (
  `id`            INT AUTO_INCREMENT PRIMARY KEY,
  `user_id`       INT NOT NULL,
  `title`         VARCHAR(255) NOT NULL,
  `description`   TEXT NULL,
  `category`      VARCHAR(100) NULL,
  `target_value`  INT NULL,
  `current_value` INT NOT NULL DEFAULT 0,
  `unit`          VARCHAR(50) NULL,
  `target_date`   DATE NULL,
  `status`        ENUM('active','completed','paused') NOT NULL DEFAULT 'active',
  `created_at`    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX `idx_goals_user` (`user_id`),
  CONSTRAINT `fk_goals_user` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`)
    ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ------------------------------------------------------------
-- 11. notes
-- ------------------------------------------------------------
CREATE TABLE `notes` (
  `id`          INT AUTO_INCREMENT PRIMARY KEY,
  `user_id`     INT NOT NULL,
  `title`       VARCHAR(255) NULL,
  `content`     MEDIUMTEXT NOT NULL,
  `tags`        VARCHAR(255) NULL,
  `pinned`      TINYINT(1) NOT NULL DEFAULT 0,
  `created_at`  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX `idx_notes_user` (`user_id`),
  CONSTRAINT `fk_notes_user` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`)
    ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ------------------------------------------------------------
-- 12. focus_sessions  — pomodoro / deep-work log
-- ------------------------------------------------------------
CREATE TABLE `focus_sessions` (
  `id`               INT AUTO_INCREMENT PRIMARY KEY,
  `user_id`          INT NOT NULL,
  `label`            VARCHAR(255) NULL,
  `linked_todo_id`   INT NULL,
  `duration_minutes` INT NOT NULL,
  `started_at`       DATETIME NOT NULL,
  `ended_at`         DATETIME NULL,
  `completed`        TINYINT(1) NOT NULL DEFAULT 0,
  `created_at`       TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX `idx_focus_user` (`user_id`),
  CONSTRAINT `fk_focus_user` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`)
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `fk_focus_todo` FOREIGN KEY (`linked_todo_id`) REFERENCES `todos`(`id`)
    ON DELETE SET NULL ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ------------------------------------------------------------
-- 13. activity_log  — history of everything
-- ------------------------------------------------------------
CREATE TABLE `activity_log` (
  `id`           INT AUTO_INCREMENT PRIMARY KEY,
  `user_id`      INT NOT NULL,
  `type`         VARCHAR(50) NOT NULL,
  `entity_type`  VARCHAR(50) NULL,
  `entity_id`    INT NULL,
  `summary`      VARCHAR(500) NOT NULL,
  `actor`        ENUM('user','ai','system') NOT NULL DEFAULT 'user',
  `metadata`     JSON NULL,
  `created_at`   TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX `idx_act_user`    (`user_id`),
  INDEX `idx_act_created` (`created_at`),
  CONSTRAINT `fk_act_user` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`)
    ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ------------------------------------------------------------
-- 14. daily_briefs  — cached AI morning brief (one per user per day)
-- ------------------------------------------------------------
CREATE TABLE `daily_briefs` (
  `id`          INT AUTO_INCREMENT PRIMARY KEY,
  `user_id`     INT NOT NULL,
  `brief_date`  DATE NOT NULL,
  `content`     MEDIUMTEXT NOT NULL,
  `provider`    VARCHAR(50) NULL,               -- 'claude' | 'ollama' | 'lmstudio'
  `model`       VARCHAR(100) NULL,
  `created_at`  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY `uq_brief_user_date` (`user_id`,`brief_date`),
  CONSTRAINT `fk_brief_user` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`)
    ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ------------------------------------------------------------
-- 15. chat_messages  — persistent AI chat history
-- ------------------------------------------------------------
CREATE TABLE `chat_messages` (
  `id`          INT AUTO_INCREMENT PRIMARY KEY,
  `user_id`     INT NOT NULL,
  `session_id`  VARCHAR(64) NOT NULL DEFAULT 'default',
  `role`        ENUM('user','assistant') NOT NULL,
  `content`     MEDIUMTEXT NOT NULL,
  `actions`     JSON NULL,                      -- record of any actions the AI executed
  `created_at`  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX `idx_chat_user_session` (`user_id`,`session_id`,`created_at`),
  CONSTRAINT `fk_chat_user` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`)
    ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ------------------------------------------------------------
-- 15b. chat_sessions  — one row per AI chat conversation
-- ------------------------------------------------------------
CREATE TABLE `chat_sessions` (
  `id`          INT AUTO_INCREMENT PRIMARY KEY,
  `user_id`     INT NOT NULL,
  `session_id`  VARCHAR(64) NOT NULL,
  `title`       VARCHAR(200) NOT NULL DEFAULT 'New chat',
  `created_at`  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY `uq_session` (`user_id`,`session_id`),
  CONSTRAINT `fk_chat_sessions_user` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`)
    ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ------------------------------------------------------------
-- 16. settings  — per-user key/value preferences (incl. AI config)
-- ------------------------------------------------------------
CREATE TABLE `settings` (
  `id`            INT AUTO_INCREMENT PRIMARY KEY,
  `user_id`       INT NOT NULL,
  `setting_key`   VARCHAR(100) NOT NULL,
  `setting_value` TEXT NULL,
  `updated_at`    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY `uq_setting_user_key` (`user_id`,`setting_key`),
  CONSTRAINT `fk_settings_user` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`)
    ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================================
--  SEED DATA  (default admin = user id 1)
-- ============================================================

-- Default admin.  username: admin   password: changeme   (CHANGE IT!)
INSERT INTO `users` (`id`,`username`,`password_hash`,`display_name`,`role`,`is_active`) VALUES
  (1, 'admin', '$2y$12$kYryWpgZ7wIQh44/q4.gUeDwurIhPywkjBfkLSZQN2ardmU.ZFIva', 'Admin', 'admin', 1);

INSERT INTO `expense_categories` (`user_id`,`name`,`color`,`icon`,`monthly_budget`) VALUES
  (1,'Food & Drink',   '#f97316', '🍔', NULL),
  (1,'Transport',      '#3b82f6', '🚌', NULL),
  (1,'Tech & Gadgets', '#8b5cf6', '💻', NULL),
  (1,'Cubing',         '#22c55e', '🧩', NULL),
  (1,'Games',          '#ec4899', '🎮', NULL),
  (1,'Subscriptions',  '#eab308', '🔁', NULL),
  (1,'Education',      '#14b8a6', '📚', NULL),
  (1,'Other',          '#6b7280', '📦', NULL);

INSERT INTO `habits` (`user_id`,`name`,`description`,`frequency`,`target_per_period`,`color`,`icon`,`sort_order`) VALUES
  (1,'Cube practice', 'Timed solves / algorithm drills', 'daily', 1, '#22c55e', '🧩', 1),
  (1,'Ship code',     'Commit something to a repo',       'daily', 1, '#8b5cf6', '💾', 2),
  (1,'Read',          'Read anything non-screen',         'daily', 1, '#14b8a6', '📖', 3),
  (1,'Move',          'Exercise / walk',                  'daily', 1, '#f97316', '🏃', 4);

-- Per-user settings (incl. AI provider config, all entered/edited in the UI later)
INSERT INTO `settings` (`user_id`,`setting_key`,`setting_value`) VALUES
  (1,'theme',            'dark'),
  (1,'base_currency',    'TRY'),
  (1,'starting_balance', '0'),                   -- opening wallet balance, may be negative
  (1,'owner_name',       ''),                    -- set in Settings UI
  (1,'github_username',  ''),                    -- set in Settings UI
  (1,'github_token',     ''),                    -- set in Settings UI
  (1,'stale_repo_days',  '60'),
  (1,'ai_enabled',       '0'),                   -- '0' off, '1' on
  (1,'ai_provider',      'claude'),              -- 'claude' | 'ollama' | 'lmstudio'
  (1,'claude_api_key',   ''),                    -- set in Settings UI
  (1,'claude_model',     'claude-sonnet-5'),
  (1,'ollama_base_url',  'http://127.0.0.1:11434'),
  (1,'ollama_model',     'llama3.1'),
  (1,'lmstudio_base_url', 'http://127.0.0.1:1234'),
  (1,'lmstudio_model',   ''),                    -- a model id from LM Studio
  (1,'lmstudio_api_key', '');                    -- optional, set in Settings UI

-- ============================================================
--  TEMPLATE — add another user by hand
--  1) run:  php tools/hashpw.php "theirPassword"   -> copy the hash
--  2) INSERT INTO `users` (`username`,`password_hash`,`display_name`,`role`)
--         VALUES ('someuser','<PASTE_HASH_HERE>','Their Name','user');
--     (defaults, categories, habits & settings auto-seed on their first login)
-- ============================================================
