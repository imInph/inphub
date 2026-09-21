<?php
/**
 * inphub: exercise the import against a real database.
 *
 * backup-selftest.php covers the parsing with no database at all. This covers
 * the half that actually writes: the delete order, the id remapping, the merge
 * collision rules and the rollback.
 *
 * It runs against its own throwaway database and never opens the real one, so
 * it cannot touch your data:
 *
 *   mysql -u root -e "CREATE DATABASE inphub_import_test"
 *   mysql -u root inphub_import_test < inphub.sql
 *   php tools/backup-dbtest.php
 */

declare(strict_types=1);

require_once __DIR__ . '/../lib/backup.php';

const TEST_DB = 'inphub_import_test';

$pdo = new PDO('mysql:host=localhost;dbname=' . TEST_DB . ';charset=utf8mb4', 'root', '', [
    PDO::ATTR_ERRMODE            => PDO::ERRMODE_EXCEPTION,
    PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
    PDO::ATTR_EMULATE_PREPARES   => false,
]);

// A guard rather than a comment: this must never run against the real database.
$name = $pdo->query('SELECT DATABASE()')->fetchColumn();
if ($name !== TEST_DB) {
    fwrite(STDERR, "refusing to run against '$name'\n");
    exit(1);
}

$pass = 0;
$fail = 0;

function check(string $what, $got, $want): void
{
    global $pass, $fail;
    if ($got === $want) {
        $pass++;
        echo "ok   $what\n";
    } else {
        $fail++;
        echo "FAIL $what\n     got  " . var_export($got, true) . "\n     want " . var_export($want, true) . "\n";
    }
}

function one(PDO $pdo, string $sql, array $p = [])
{
    $s = $pdo->prepare($sql);
    $s->execute($p);
    return $s->fetchColumn();
}

/** A file with a parent, two children, a foreign key and a habit log. */
function sample(array $overrides = []): string
{
    $doc = [
        'format' => BACKUP_FORMAT,
        'format_version' => BACKUP_FORMAT_VERSION,
        'app' => 'inphub-lite',
        'app_version' => '1.0.0',
        'exported_at' => '2026-09-21T20:00:00',
        'counts' => [],
        'data' => [
            'settings' => [['key' => 'base_currency', 'value' => 'TRY']],
            'expense_categories' => [
                ['id' => 40, 'name' => 'Imported Food', 'color' => '#f97316', 'icon' => '🍔',
                 'monthly_budget' => 200, 'created_at' => '2026-01-02T08:00:00'],
            ],
            'todos' => [
                ['id' => 70, 'title' => 'Imported task', 'status' => 'todo', 'priority' => 'high',
                 'sort_order' => 0, 'created_by' => 'ai', 'created_at' => '2026-09-01T12:00:00',
                 'updated_at' => '2026-09-01T12:00:00', 'completed_at' => null],
            ],
            'habits' => [
                ['id' => 90, 'name' => 'Imported habit', 'frequency' => 'daily', 'target_per_period' => 3,
                 'color' => '#22c55e', 'is_active' => 1, 'sort_order' => 1, 'created_at' => '2026-01-01T00:00:00'],
            ],
            'habit_logs' => [
                ['id' => 91, 'habit_id' => 90, 'logged_date' => '2026-09-10', 'count' => 2,
                 'note' => null, 'created_at' => '2026-09-10T20:00:00'],
            ],
            'expenses' => [
                ['id' => 50, 'type' => 'expense', 'amount' => 42.5, 'currency' => 'TRY',
                 'category_id' => 40, 'description' => 'Kahvaltı', 'spent_at' => '2026-09-10',
                 'is_recurring' => 0, 'created_by' => 'user', 'created_at' => '2026-09-10T09:15:00'],
            ],
            'focus_sessions' => [
                ['id' => 60, 'label' => 'Imported focus', 'linked_todo_id' => 70,
                 'duration_minutes' => 25, 'started_at' => '2026-09-10T09:00:00',
                 'ended_at' => '2026-09-10T09:25:00', 'completed' => 1, 'created_at' => '2026-09-10T09:25:00'],
            ],
            'activity_log' => [
                ['id' => 80, 'type' => 'repos.synced', 'entity_type' => 'repo', 'entity_id' => null,
                 'summary' => 'Synced 4 repositories', 'actor' => 'system',
                 'metadata' => ['count' => 4], 'created_at' => '2026-09-20T21:39:12'],
            ],
            'goals' => [], 'notes' => [], 'repos' => [],
        ],
    ];
    foreach ($overrides as $table => $rows) {
        $doc['data'][$table] = $rows;
    }
    return json_encode($doc);
}

$uid = 1;

/* ------------------------------------------------------- replace keeps ids */

$written = backup_apply($pdo, $uid, backup_parse(sample()), 'replace');

check('replace wrote the expense', (int) one($pdo, 'SELECT COUNT(*) FROM expenses WHERE user_id=?', [$uid]), 1);
check('replace kept the category id', (int) one($pdo, 'SELECT id FROM expense_categories WHERE name=?', ['Imported Food']), 40);
check('replace kept the todo id', (int) one($pdo, 'SELECT id FROM todos WHERE title=?', ['Imported task']), 70);
check('the foreign key still points at it',
    (int) one($pdo, 'SELECT category_id FROM expenses WHERE id=?', [50]), 40);
check('focus session still points at its todo',
    (int) one($pdo, 'SELECT linked_todo_id FROM focus_sessions WHERE id=?', [60]), 70);
check('datetime landed as MySQL wrote it',
    one($pdo, 'SELECT created_at FROM expenses WHERE id=?', [50]), '2026-09-10 09:15:00');
check('amount is a real decimal', (float) one($pdo, 'SELECT amount FROM expenses WHERE id=?', [50]), 42.50);
check('Turkish survived the round trip',
    one($pdo, 'SELECT description FROM expenses WHERE id=?', [50]), 'Kahvaltı');
check("inphub's own 'ai' author survived",
    one($pdo, 'SELECT created_by FROM todos WHERE id=?', [70]), 'ai');
check('JSON column re-encoded',
    json_decode((string) one($pdo, 'SELECT metadata FROM activity_log WHERE id=?', [80]), true), ['count' => 4]);
check('the seeded categories were cleared first',
    (int) one($pdo, 'SELECT COUNT(*) FROM expense_categories WHERE user_id=?', [$uid]), 1);
check('settings were written', one($pdo, 'SELECT setting_value FROM settings WHERE user_id=? AND setting_key=?',
    [$uid, 'base_currency']), 'TRY');

/* --------------------------------------------- replace twice is idempotent */

backup_apply($pdo, $uid, backup_parse(sample()), 'replace');
check('a second replace does not duplicate',
    (int) one($pdo, 'SELECT COUNT(*) FROM expenses WHERE user_id=?', [$uid]), 1);

/* ------------------------------------------------------------ merge rules */

// Same file again, merged: the category collides by name and is reused, so the
// expense must attach to the EXISTING category, not a second one.
backup_apply($pdo, $uid, backup_parse(sample()), 'merge');
check('merge reused the category rather than making a second',
    (int) one($pdo, 'SELECT COUNT(*) FROM expense_categories WHERE user_id=? AND name=?', [$uid, 'Imported Food']), 1);
check('merge added the expense with a new id',
    (int) one($pdo, 'SELECT COUNT(*) FROM expenses WHERE user_id=?', [$uid]), 2);
check('the new expense points at the existing category',
    (int) one($pdo, 'SELECT COUNT(DISTINCT category_id) FROM expenses WHERE user_id=?', [$uid]), 1);
check('merge deduped the activity row',
    (int) one($pdo, 'SELECT COUNT(*) FROM activity_log WHERE user_id=? AND type=?', [$uid, 'repos.synced']), 1);
check('merge reused the habit rather than doubling it',
    (int) one($pdo, 'SELECT COUNT(*) FROM habits WHERE user_id=? AND name=?', [$uid, 'Imported habit']), 1);
check('habit_logs collided rather than inserting twice',
    (int) one($pdo, 'SELECT COUNT(*) FROM habit_logs WHERE user_id=?', [$uid]), 1);
check('habit_logs kept max(count), not the sum',
    (int) one($pdo, 'SELECT count FROM habit_logs WHERE user_id=?', [$uid]), 2);

// A higher count in a later file wins; a lower one does not lower it.
$higher = sample(['habit_logs' => [['id' => 91, 'habit_id' => 90, 'logged_date' => '2026-09-10',
    'count' => 5, 'note' => null, 'created_at' => '2026-09-10T20:00:00']]]);
backup_apply($pdo, $uid, backup_parse($higher), 'merge');
check('a higher count wins', (int) one($pdo, 'SELECT count FROM habit_logs WHERE user_id=?', [$uid]), 5);
$lower = sample(['habit_logs' => [['id' => 91, 'habit_id' => 90, 'logged_date' => '2026-09-10',
    'count' => 1, 'note' => null, 'created_at' => '2026-09-10T20:00:00']]]);
backup_apply($pdo, $uid, backup_parse($lower), 'merge');
check('a lower count does not lower it', (int) one($pdo, 'SELECT count FROM habit_logs WHERE user_id=?', [$uid]), 5);
check('and no extra habits appeared along the way',
    (int) one($pdo, 'SELECT COUNT(*) FROM habits WHERE user_id=?', [$uid]), 1);

/* ---------------------------------------------------------------- rollback */

// A row that violates a column constraint mid-import must leave nothing behind.
$before = (int) one($pdo, 'SELECT COUNT(*) FROM notes WHERE user_id=?', [$uid]);
$broken = sample(['notes' => [
    ['id' => 1, 'title' => 'fine', 'content' => 'ok', 'pinned' => 0,
     'created_at' => '2026-09-01T10:00:00', 'updated_at' => '2026-09-01T10:00:00'],
    ['id' => 2, 'title' => str_repeat('x', 900), 'content' => 'too long a title', 'pinned' => 0,
     'created_at' => '2026-09-01T10:00:00', 'updated_at' => '2026-09-01T10:00:00'],
]]);
$pdo->exec("SET SESSION sql_mode='STRICT_ALL_TABLES'");
try {
    backup_apply($pdo, $uid, backup_parse($broken), 'merge');
    check('a bad row aborts the import', 'completed', 'threw');
} catch (Throwable $e) {
    check('a bad row aborts the import', 'threw', 'threw');
}
check('and rolls back the good row with it',
    (int) one($pdo, 'SELECT COUNT(*) FROM notes WHERE user_id=?', [$uid]), $before);

echo "\n$pass passed, $fail failed\n";
exit($fail === 0 ? 0 : 1);
