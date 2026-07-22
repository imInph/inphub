<?php
/**
 * inphub — first-login provisioning.
 *
 * Manually-added users only need one INSERT into `users`. On their first
 * login we seed the same sensible defaults that inphub.sql gives user 1:
 * settings, expense categories, and starter habits. Idempotent — each block
 * only seeds when that table is empty for the user.
 */

declare(strict_types=1);

require_once __DIR__ . '/../db/database.php';

/** Default per-user settings (mirrors the seed in inphub.sql). */
function default_settings(): array
{
    return [
        'theme'            => 'dark',
        'base_currency'    => 'TRY',
        'owner_name'       => '',
        'github_username'  => 'imInph',
        'github_token'     => '',
        'stale_repo_days'  => '60',
        'ai_enabled'       => '0',
        'ai_provider'      => 'claude',
        'claude_api_key'   => '',
        'claude_model'     => 'claude-sonnet-5',
        'ollama_base_url'  => 'http://127.0.0.1:11434',
        'ollama_model'     => 'llama3.1',
    ];
}

/** Default expense categories (mirrors the seed in inphub.sql). */
function default_categories(): array
{
    return [
        ['Food & Drink',   '#f97316', '🍔'],
        ['Transport',      '#3b82f6', '🚌'],
        ['Tech & Gadgets', '#8b5cf6', '💻'],
        ['Cubing',         '#22c55e', '🧩'],
        ['Games',          '#ec4899', '🎮'],
        ['Subscriptions',  '#eab308', '🔁'],
        ['Education',      '#14b8a6', '📚'],
        ['Other',          '#6b7280', '📦'],
    ];
}

/** Default starter habits (mirrors the seed in inphub.sql). */
function default_habits(): array
{
    return [
        ['Cube practice', 'Timed solves / algorithm drills', 'daily', 1, '#22c55e', '🧩', 1],
        ['Ship code',     'Commit something to a repo',       'daily', 1, '#8b5cf6', '💾', 2],
        ['Read',          'Read anything non-screen',         'daily', 1, '#14b8a6', '📖', 3],
        ['Move',          'Exercise / walk',                  'daily', 1, '#f97316', '🏃', 4],
    ];
}

/**
 * Seed defaults for a user when they are missing. Safe to call on every login.
 */
function provision_user(int $userId): void
{
    $pdo = db();

    // --- settings ---
    $count = $pdo->prepare('SELECT COUNT(*) FROM settings WHERE user_id = ?');
    $count->execute([$userId]);
    if ((int) $count->fetchColumn() === 0) {
        // Give owner_name a friendly default from the user's display name.
        $u = $pdo->prepare('SELECT display_name, username FROM users WHERE id = ?');
        $u->execute([$userId]);
        $row = $u->fetch();
        $ownerName = $row ? ($row['display_name'] ?: $row['username']) : '';

        $ins = $pdo->prepare(
            'INSERT INTO settings (user_id, setting_key, setting_value) VALUES (?, ?, ?)'
        );
        foreach (default_settings() as $key => $value) {
            if ($key === 'owner_name' && $value === '') {
                $value = $ownerName;
            }
            $ins->execute([$userId, $key, $value]);
        }
    }

    // --- expense categories ---
    $count = $pdo->prepare('SELECT COUNT(*) FROM expense_categories WHERE user_id = ?');
    $count->execute([$userId]);
    if ((int) $count->fetchColumn() === 0) {
        $ins = $pdo->prepare(
            'INSERT INTO expense_categories (user_id, name, color, icon) VALUES (?, ?, ?, ?)'
        );
        foreach (default_categories() as [$name, $color, $icon]) {
            $ins->execute([$userId, $name, $color, $icon]);
        }
    }

    // --- habits ---
    $count = $pdo->prepare('SELECT COUNT(*) FROM habits WHERE user_id = ?');
    $count->execute([$userId]);
    if ((int) $count->fetchColumn() === 0) {
        $ins = $pdo->prepare(
            'INSERT INTO habits
                (user_id, name, description, frequency, target_per_period, color, icon, sort_order)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
        );
        foreach (default_habits() as [$name, $desc, $freq, $target, $color, $icon, $sort]) {
            $ins->execute([$userId, $name, $desc, $freq, $target, $color, $icon, $sort]);
        }
    }
}
