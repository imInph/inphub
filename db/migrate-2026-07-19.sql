-- inphub migration, 2026-07-19
-- Run once against an EXISTING database (phpMyAdmin or:
--   mysql -u root inphub < db/migrate-2026-07-19.sql
-- ). Fresh installs get this from inphub.sql and must NOT run it.

-- Chat history menu: one row per AI chat conversation (2.6).
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
