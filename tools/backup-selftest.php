<?php
/**
 * inphub: check the backup format against itself, with no server and no database.
 *
 * The exporter's shapes and the importer's shapes are the contract inphub lite
 * reads, so the thing worth testing is that a document shaped like
 * backup_build()'s output survives backup_parse() unchanged. There is no test
 * framework here; run it with:
 *
 *   php tools/backup-selftest.php
 */

declare(strict_types=1);

require_once __DIR__ . '/../lib/backup.php';

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

/* ---------------------------------------------------- datetime conversion */

check('datetime out', backup_datetime_out('2026-09-20 21:39:12'), '2026-09-20T21:39:12');
check('datetime in', backup_datetime_in('2026-09-20T21:39:12'), '2026-09-20 21:39:12');
check('datetime out keeps null', backup_datetime_out(null), null);
check('datetime in keeps null', backup_datetime_in(''), null);
// A file written by hand, or by an older build, may already use a space.
check('datetime in tolerates a space', backup_datetime_in('2026-09-20 21:39:12'), '2026-09-20 21:39:12');

/* ------------------------------------------------------- row conversion */

// What PDO actually hands back: everything a string, datetimes with a space,
// JSON columns as text, and a user_id that must not travel.
$fromPdo = [
    'id' => '17', 'user_id' => '1', 'type' => 'expense', 'amount' => '42.50',
    'currency' => 'TRY', 'category_id' => '2', 'description' => 'Kahvaltı',
    'spent_at' => '2026-09-10', 'is_recurring' => '0', 'created_at' => '2026-09-20 21:39:12',
];
$out = backup_row_out('expenses', $fromPdo);
check('row_out drops user_id', array_key_exists('user_id', $out), false);
check('row_out ids are ints', $out['id'], 17);
check('row_out decimals are numbers', $out['amount'], 42.5);
check('row_out booleans are ints', $out['is_recurring'], 0);
check('row_out datetimes carry a T', $out['created_at'], '2026-09-20T21:39:12');
check('row_out keeps Turkish', $out['description'], 'Kahvaltı');

$back = backup_row_in('expenses', $out);
check('row_in restores the space', $back['created_at'], '2026-09-20 21:39:12');
check('row_in keeps the number', $back['amount'], 42.5);

$meta = backup_row_out('activity_log', ['id' => '3', 'user_id' => '1', 'type' => 'repos.synced',
    'summary' => 'Synced', 'actor' => 'system', 'metadata' => '{"count":4}', 'created_at' => '2026-09-20 10:00:00']);
check('row_out decodes JSON columns', $meta['metadata'], ['count' => 4]);
check('row_in re-encodes them', backup_row_in('activity_log', $meta)['metadata'], '{"count":4}');

/* ------------------------------------------------------------- parsing */

$doc = [
    'format' => BACKUP_FORMAT,
    'format_version' => BACKUP_FORMAT_VERSION,
    'app' => 'inphub-lite',
    'app_version' => '1.0.0',
    'exported_at' => '2026-09-21T17:40:00',
    'counts' => [],
    'data' => [
        'settings' => [
            ['key' => 'base_currency', 'value' => 'TRY'],
            ['key' => 'github_token', 'value' => 'ghp_secret'],
        ],
        'expense_categories' => [['id' => 1, 'name' => 'Food & Drink', 'color' => '#f97316',
            'icon' => '🍔', 'monthly_budget' => 200, 'created_at' => '2026-09-01T10:00:00']],
        'expenses' => [['id' => 5, 'type' => 'expense', 'amount' => 42.5, 'currency' => 'TRY',
            'category_id' => 1, 'description' => 'Kahvaltı', 'spent_at' => '2026-09-10',
            'is_recurring' => 0, 'created_at' => '2026-09-10T09:00:00', 'bogus_column' => 'x']],
        'todos' => [],
        'not_a_real_table' => [['a' => 1]],
    ],
];
$parsed = backup_parse(json_encode($doc));

check('parse counts expenses', $parsed['counts']['expenses'], 1);
check('parse drops an unknown column', array_key_exists('bogus_column', $parsed['rows']['expenses'][0]), false);
check('parse converts the datetime back', $parsed['rows']['expenses'][0]['created_at'], '2026-09-10 09:00:00');
check('parse warns about an unknown table', str_contains($parsed['warnings'][1] ?? '', 'not_a_real_table'), true);
// A secret in the file is ignored rather than written over the real one.
check('parse refuses a secret', count($parsed['rows']['settings']), 1);
check('parse keeps the non-secret setting', $parsed['rows']['settings'][0]['key'], 'base_currency');
check('parse reads the source app', $parsed['meta']['app'], 'inphub-lite');

/* ------------------------------------------------------------ rejections */

function rejects(string $what, string $json): void
{
    try {
        backup_parse($json);
        check($what, 'accepted', 'rejected');
    } catch (BackupError $e) {
        check($what, 'rejected', 'rejected');
    }
}

rejects('not JSON', 'hello');
rejects('not an inphub backup', json_encode(['format' => 'something-else']));
rejects('a newer format version', json_encode(['format' => BACKUP_FORMAT,
    'format_version' => 99, 'data' => []]));
rejects('no data section', json_encode(['format' => BACKUP_FORMAT, 'format_version' => 1]));
rejects('a table that is not a list', json_encode(['format' => BACKUP_FORMAT,
    'format_version' => 1, 'data' => ['todos' => 'nope']]));
rejects('a row with no title', json_encode(['format' => BACKUP_FORMAT,
    'format_version' => 1, 'data' => ['todos' => [['description' => 'orphan']]]]));

/* ----------------------------------------------------------- table lists */

// Every table the importer accepts must be one the exporter writes, or a
// restore would silently drop it.
$exported = array_merge(BACKUP_TABLES_SHARED, BACKUP_TABLES_INPHUB);
$importable = array_merge(array_keys(IMPORT_COLUMNS), ['settings']);
sort($exported);
sort($importable);
check('exporter and importer agree on the tables', $exported, $importable);
check('insert order covers every table', count(IMPORT_ORDER), count(IMPORT_COLUMNS));

echo "\n$pass passed, $fail failed\n";
exit($fail === 0 ? 0 : 1);
