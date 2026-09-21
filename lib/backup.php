<?php
/**
 * inphub: the shared backup format, reading and writing.
 *
 * BACKUP-FORMAT.md is the contract, and the copy in inphub-lite is identical.
 * Anything changed here has to change there too, or the two stop understanding
 * each other, which is the whole point of the file.
 *
 * Everything in here is about making MySQL's idea of a value and JavaScript's
 * idea of a value agree: PDO hands DECIMAL and INT back as strings, datetimes
 * come out with a space instead of a T, and JSON columns arrive as text.
 */

declare(strict_types=1);

require_once __DIR__ . '/helpers.php';

const BACKUP_FORMAT = 'inphub-backup';
const BACKUP_FORMAT_VERSION = 1;

/** Tables both apps share, in dependency order: parents before children. */
const BACKUP_TABLES_SHARED = [
    'settings',
    'expense_categories',
    'todos',
    'habits',
    'goals',
    'notes',
    'repos',
    'expenses',
    'habit_logs',
    'focus_sessions',
    'activity_log',
];

/** Tables only inphub has. lite skips them and says how many it skipped. */
const BACKUP_TABLES_INPHUB = [
    'repo_suggestions',
    'daily_briefs',
    'chat_sessions',
    'chat_messages',
];

/** Never leaves the machine. A backup is a file people email themselves. */
const BACKUP_SECRET_KEYS = ['github_token', 'claude_api_key', 'lmstudio_api_key'];

/** Columns that are datetimes, per table, normalised on the way out and in. */
const BACKUP_DATETIME_COLUMNS = [
    'todos'           => ['created_at', 'updated_at', 'completed_at'],
    'expenses'        => ['created_at'],
    'expense_categories' => ['created_at'],
    'repos'           => ['last_pushed_at', 'last_synced_at', 'created_at'],
    'habits'          => ['created_at'],
    'habit_logs'      => ['created_at'],
    'goals'           => ['created_at', 'updated_at'],
    'notes'           => ['created_at', 'updated_at'],
    'focus_sessions'  => ['started_at', 'ended_at', 'created_at'],
    'activity_log'    => ['created_at'],
    'repo_suggestions' => ['created_at'],
    'daily_briefs'    => ['created_at'],
    'chat_sessions'   => ['created_at', 'updated_at'],
    'chat_messages'   => ['created_at'],
];

/** Integer columns, so "17" never reaches a comparison as a string. */
const BACKUP_INT_COLUMNS = [
    'todos'           => ['id', 'sort_order'],
    'expense_categories' => ['id'],
    'expenses'        => ['id', 'category_id', 'is_recurring'],
    'repos'           => ['id', 'github_id', 'stars', 'forks', 'open_issues', 'is_archived',
                          'is_private', 'has_readme', 'has_license', 'health_score',
                          'staleness_days', 'pinned'],
    'habits'          => ['id', 'target_per_period', 'is_active', 'sort_order'],
    'habit_logs'      => ['id', 'habit_id', 'count'],
    'goals'           => ['id', 'target_value', 'current_value'],
    'notes'           => ['id', 'pinned'],
    'focus_sessions'  => ['id', 'linked_todo_id', 'duration_minutes', 'completed'],
    'activity_log'    => ['id', 'entity_id'],
    'repo_suggestions' => ['id', 'repo_id'],
    'daily_briefs'    => ['id'],
    'chat_sessions'   => ['id'],
    'chat_messages'   => ['id'],
];

/** Decimal columns, written as JSON numbers at 2dp. */
const BACKUP_DECIMAL_COLUMNS = [
    'expenses'           => ['amount'],
    'expense_categories' => ['monthly_budget'],
];

/** JSON columns, written as objects rather than strings holding JSON. */
const BACKUP_JSON_COLUMNS = [
    'activity_log'  => ['metadata'],
    'chat_messages' => ['actions'],
];

/** 'YYYY-MM-DD HH:MM:SS' to 'YYYY-MM-DDTHH:MM:SS'. Null stays null. */
function backup_datetime_out(?string $value): ?string
{
    if ($value === null || $value === '') {
        return null;
    }
    return str_replace(' ', 'T', substr($value, 0, 19));
}

/** The reverse, and tolerant of a file that already used a space. */
function backup_datetime_in($value): ?string
{
    if ($value === null || $value === '') {
        return null;
    }
    return str_replace('T', ' ', substr((string) $value, 0, 19));
}

/**
 * One row, MySQL shapes turned into JSON shapes.
 *
 * Applied on export. The importer does the reverse plus a coercion pass, since
 * a file may have been written by an older build or hand-edited.
 */
function backup_row_out(string $table, array $row): array
{
    unset($row['user_id']);

    foreach (BACKUP_DATETIME_COLUMNS[$table] ?? [] as $col) {
        if (array_key_exists($col, $row)) {
            $row[$col] = backup_datetime_out($row[$col] === null ? null : (string) $row[$col]);
        }
    }
    foreach (BACKUP_INT_COLUMNS[$table] ?? [] as $col) {
        if (array_key_exists($col, $row)) {
            $row[$col] = $row[$col] === null ? null : (int) $row[$col];
        }
    }
    foreach (BACKUP_DECIMAL_COLUMNS[$table] ?? [] as $col) {
        if (array_key_exists($col, $row)) {
            $row[$col] = $row[$col] === null ? null : round((float) $row[$col], 2);
        }
    }
    foreach (BACKUP_JSON_COLUMNS[$table] ?? [] as $col) {
        if (array_key_exists($col, $row) && is_string($row[$col])) {
            $decoded = json_decode($row[$col], true);
            $row[$col] = is_array($decoded) ? $decoded : null;
        }
    }
    return $row;
}

/**
 * Build the whole document for one account.
 *
 * settings become {key, value} pairs and the three secret keys are dropped
 * outright rather than masked: a mask that round-trips would overwrite the real
 * value on the way back in.
 */
function backup_build(int $uid): array
{
    $pdo  = db();
    $data = [];

    foreach (array_merge(BACKUP_TABLES_SHARED, BACKUP_TABLES_INPHUB) as $table) {
        // $table comes only from the two constants above, never from input.
        $stmt = $pdo->prepare("SELECT * FROM `$table` WHERE user_id = ?");
        $stmt->execute([$uid]);
        $rows = $stmt->fetchAll();

        if ($table === 'settings') {
            $out = [];
            foreach ($rows as $row) {
                if (in_array($row['setting_key'], BACKUP_SECRET_KEYS, true)) {
                    continue;
                }
                $out[] = ['key' => $row['setting_key'], 'value' => (string) $row['setting_value']];
            }
            $data[$table] = $out;
            continue;
        }

        $data[$table] = array_map(static fn (array $r): array => backup_row_out($table, $r), $rows);
    }

    $counts = [];
    foreach ($data as $table => $rows) {
        $counts[$table] = count($rows);
    }

    return [
        'format'         => BACKUP_FORMAT,
        'format_version' => BACKUP_FORMAT_VERSION,
        'app'            => 'inphub',
        'app_version'    => INPHUB_VERSION,
        'exported_at'    => date('Y-m-d\TH:i:s'),
        'counts'         => $counts,
        'data'           => $data,
    ];
}

/** A file that cannot be imported, with the status the endpoint should answer. */
class BackupError extends RuntimeException
{
    public int $status;

    public function __construct(string $message, int $status = 422)
    {
        parent::__construct($message);
        $this->status = $status;
    }
}

/** Columns we accept per table, so an unknown one is dropped rather than failing a query. */
const IMPORT_COLUMNS = [
    'expense_categories' => ['id', 'name', 'color', 'icon', 'monthly_budget', 'created_at'],
    'todos'          => ['id', 'title', 'description', 'status', 'priority', 'project', 'tags',
                         'due_date', 'recurring', 'sort_order', 'created_by', 'created_at',
                         'updated_at', 'completed_at'],
    'habits'         => ['id', 'name', 'description', 'frequency', 'target_per_period', 'color',
                         'icon', 'is_active', 'sort_order', 'created_at'],
    'goals'          => ['id', 'title', 'description', 'category', 'target_value', 'current_value',
                         'unit', 'target_date', 'status', 'created_at', 'updated_at'],
    'notes'          => ['id', 'title', 'content', 'tags', 'pinned', 'created_at', 'updated_at'],
    'repos'          => ['id', 'github_id', 'name', 'full_name', 'description', 'url', 'language',
                         'stars', 'forks', 'open_issues', 'default_branch', 'is_archived',
                         'is_private', 'has_readme', 'has_license', 'readme_excerpt',
                         'health_score', 'staleness_days', 'last_pushed_at', 'last_synced_at',
                         'pinned', 'created_at'],
    'expenses'       => ['id', 'type', 'amount', 'currency', 'category_id', 'description',
                         'payment_method', 'spent_at', 'is_recurring', 'recurring_interval',
                         'created_by', 'created_at'],
    'habit_logs'     => ['id', 'habit_id', 'logged_date', 'count', 'note', 'created_at'],
    'focus_sessions' => ['id', 'label', 'linked_todo_id', 'duration_minutes', 'started_at',
                         'ended_at', 'completed', 'created_at'],
    'activity_log'   => ['id', 'type', 'entity_type', 'entity_id', 'summary', 'actor', 'metadata',
                         'created_at'],
    'repo_suggestions' => ['id', 'repo_id', 'title', 'detail', 'category', 'priority', 'status',
                           'created_at'],
    'daily_briefs'   => ['id', 'brief_date', 'content', 'provider', 'model', 'created_at'],
    'chat_sessions'  => ['id', 'session_id', 'title', 'created_at', 'updated_at'],
    'chat_messages'  => ['id', 'session_id', 'role', 'content', 'actions', 'created_at'],
];

/** A row without these is structurally broken and rejects the file. */
const IMPORT_REQUIRED = [
    'expense_categories' => ['name'],
    'todos'          => ['title'],
    'habits'         => ['name'],
    'goals'          => ['title'],
    'notes'          => ['content'],
    'repos'          => ['name', 'full_name'],
    'expenses'       => ['amount', 'spent_at'],
    'habit_logs'     => ['habit_id', 'logged_date'],
    'focus_sessions' => ['duration_minutes', 'started_at'],
    'activity_log'   => ['type', 'summary'],
    'repo_suggestions' => ['repo_id', 'title'],
    'daily_briefs'   => ['brief_date', 'content'],
    'chat_sessions'  => ['session_id'],
    'chat_messages'  => ['role', 'content'],
];

/** parent table => [child table, fk column], for merge-mode remapping. */
const IMPORT_PARENTS = [
    'expenses'         => ['expense_categories', 'category_id'],
    'habit_logs'       => ['habits', 'habit_id'],
    'focus_sessions'   => ['todos', 'linked_todo_id'],
    'repo_suggestions' => ['repos', 'repo_id'],
];

/** Insert order: a parent is always in before anything pointing at it. */
const IMPORT_ORDER = [
    'expense_categories', 'todos', 'habits', 'goals', 'notes', 'repos', 'chat_sessions',
    'expenses', 'habit_logs', 'focus_sessions', 'repo_suggestions',
    'activity_log', 'daily_briefs', 'chat_messages',
];

/**
 * Read and check a file without touching the database.
 *
 * Throws BackupError on anything structural, so a caller can map it to a status
 * and a test can call it with no server, no session and no database.
 *
 * Returns ['counts' => [...], 'warnings' => [...], 'rows' => [...], 'meta' => [...]].
 * Throws on anything structural.
 */
function backup_parse(string $text): array
{
    $doc = json_decode(trim($text), true);
    if (!is_array($doc)) {
        throw new BackupError('That file is not valid JSON.');
    }
    if (($doc['format'] ?? null) !== BACKUP_FORMAT) {
        throw new BackupError('That is not an inphub backup file.');
    }
    $version = (int) ($doc['format_version'] ?? 0);
    if ($version > BACKUP_FORMAT_VERSION) {
        throw new BackupError("That backup was written by a newer version (format $version). Update inphub first.");
    }
    $data = $doc['data'] ?? null;
    if (!is_array($data)) {
        throw new BackupError('That backup has no data section.');
    }

    $warnings = [];
    $rows     = [];
    $counts   = [];

    foreach ($data as $table => $list) {
        if ($table === 'settings') {
            if (!is_array($list)) {
                throw new BackupError('settings is not a list.');
            }
            $out = [];
            foreach ($list as $row) {
                if (!is_array($row) || !isset($row['key'])) {
                    continue;
                }
                if (in_array($row['key'], BACKUP_SECRET_KEYS, true)) {
                    // Should never be in the file; drop it if someone added it by hand.
                    $warnings[] = "Ignored the stored value for {$row['key']}; re-enter it in Settings.";
                    continue;
                }
                $out[] = ['key' => (string) $row['key'], 'value' => (string) ($row['value'] ?? '')];
            }
            $rows['settings'] = $out;
            $counts['settings'] = count($out);
            continue;
        }

        if (!isset(IMPORT_COLUMNS[$table])) {
            $warnings[] = "Skipped an unknown table: $table.";
            continue;
        }
        if (!is_array($list)) {
            throw new BackupError("$table is not a list.");
        }

        $allowed = IMPORT_COLUMNS[$table];
        $clean   = [];
        foreach ($list as $i => $row) {
            if (!is_array($row)) {
                throw new BackupError("$table row $i is not an object.");
            }
            foreach (IMPORT_REQUIRED[$table] ?? [] as $req) {
                if (!array_key_exists($req, $row) || $row[$req] === null || $row[$req] === '') {
                    throw new BackupError("$table row $i has no $req.");
                }
            }
            $kept = [];
            foreach ($allowed as $col) {
                if (array_key_exists($col, $row)) {
                    $kept[$col] = $row[$col];
                }
            }
            $clean[] = backup_row_in($table, $kept);
        }
        $rows[$table]   = $clean;
        $counts[$table] = count($clean);
    }

    return [
        'counts'   => $counts,
        'warnings' => $warnings,
        'rows'     => $rows,
        'meta'     => [
            'app'         => (string) ($doc['app'] ?? 'unknown'),
            'app_version' => (string) ($doc['app_version'] ?? ''),
            'exported_at' => (string) ($doc['exported_at'] ?? ''),
        ],
    ];
}

/** JSON shapes back into MySQL shapes. The mirror of backup_row_out(). */
function backup_row_in(string $table, array $row): array
{
    foreach (BACKUP_DATETIME_COLUMNS[$table] ?? [] as $col) {
        if (array_key_exists($col, $row)) {
            $row[$col] = backup_datetime_in($row[$col]);
        }
    }
    foreach (BACKUP_INT_COLUMNS[$table] ?? [] as $col) {
        if (array_key_exists($col, $row)) {
            $row[$col] = ($row[$col] === null || $row[$col] === '') ? null : (int) $row[$col];
        }
    }
    foreach (BACKUP_DECIMAL_COLUMNS[$table] ?? [] as $col) {
        if (array_key_exists($col, $row)) {
            $row[$col] = ($row[$col] === null || $row[$col] === '') ? null : round((float) $row[$col], 2);
        }
    }
    foreach (BACKUP_JSON_COLUMNS[$table] ?? [] as $col) {
        if (array_key_exists($col, $row)) {
            $row[$col] = $row[$col] === null ? null
                : (is_string($row[$col]) ? $row[$col] : json_encode($row[$col], JSON_UNESCAPED_UNICODE));
        }
    }
    return $row;
}

/**
 * Write a parsed backup into one account, in a single transaction.
 *
 * Takes the connection rather than calling db(), so tools/backup-dbtest.php can
 * run it against a throwaway database instead of the real one. Returns the row
 * count written per table.
 */
function backup_apply(PDO $pdo, int $uid, array $parsed, string $mode): array
{
    $mode = $mode === 'merge' ? 'merge' : 'replace';

    $pdo->beginTransaction();
    try {
        if ($mode === 'replace') {
            // Children first, so nothing is left pointing at a deleted parent.
            foreach (array_reverse(IMPORT_ORDER) as $table) {
                $pdo->prepare("DELETE FROM `$table` WHERE user_id = ?")->execute([$uid]);
            }
            $pdo->prepare('DELETE FROM settings WHERE user_id = ? AND setting_key NOT IN (?, ?, ?)')
                ->execute(array_merge([$uid], BACKUP_SECRET_KEYS));
        }

        $remap   = [];
        $written = [];

        foreach (IMPORT_ORDER as $table) {
            $list = $parsed['rows'][$table] ?? [];
            if (!$list) {
                continue;
            }
            $written[$table] = backup_insert_table($pdo, $uid, $table, $list, $mode, $remap);
        }

        foreach ($parsed['rows']['settings'] ?? [] as $row) {
            $stmt = $pdo->prepare(
                'INSERT INTO settings (user_id, setting_key, setting_value) VALUES (?,?,?)
                 ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value)'
            );
            $stmt->execute([$uid, $row['key'], $row['value']]);
        }
        if (isset($parsed['rows']['settings'])) {
            $written['settings'] = count($parsed['rows']['settings']);
        }

        $pdo->commit();
        return $written;
    } catch (Throwable $e) {
        $pdo->rollBack();
        throw $e;
    }
}

/** Insert one table's rows, remapping ids in merge mode. Returns the count written. */
function backup_insert_table(PDO $pdo, int $uid, string $table, array $rows, string $mode, array &$remap): int
{
    $keepIds = $mode === 'replace';
    $parent  = IMPORT_PARENTS[$table] ?? null;
    $written = 0;

    foreach ($rows as $row) {
        $oldId = isset($row['id']) ? (int) $row['id'] : null;
        if (!$keepIds) {
            unset($row['id']);
        }

        // Point a child at wherever its parent actually landed.
        if ($parent !== null) {
            [$parentTable, $fk] = $parent;
            if (!empty($row[$fk])) {
                $row[$fk] = $remap[$parentTable][(int) $row[$fk]] ?? ($keepIds ? (int) $row[$fk] : null);
            }
        }

        $row['user_id'] = $uid;

        if ($mode === 'merge') {
            $existing = backup_find_existing($pdo, $uid, $table, $row);
            if ($existing !== null) {
                if ($oldId !== null) {
                    $remap[$table][$oldId] = $existing;
                }
                backup_merge_existing($pdo, $table, $existing, $row);
                continue;
            }
        }

        $cols = array_keys($row);
        $sql  = "INSERT INTO `$table` (`" . implode('`,`', $cols) . '`) VALUES ('
              . implode(',', array_fill(0, count($cols), '?')) . ')';
        $pdo->prepare($sql)->execute(array_values($row));

        $newId = (int) $pdo->lastInsertId();
        if ($oldId !== null) {
            $remap[$table][$oldId] = $newId;
        }
        $written++;
    }
    return $written;
}

/**
 * The row a merge would collide with, or null.
 *
 * Only the genuinely unique columns, plus the activity dedupe, which is what
 * stops a re-import tripling the hours-of-day chart.
 */
function backup_find_existing(PDO $pdo, int $uid, string $table, array $row): ?int
{
    $find = static function (string $sql, array $params) use ($pdo): ?int {
        $stmt = $pdo->prepare($sql);
        $stmt->execute($params);
        $id = $stmt->fetchColumn();
        return $id === false ? null : (int) $id;
    };

    switch ($table) {
        case 'expense_categories':
            return $find('SELECT id FROM expense_categories WHERE user_id=? AND name=?', [$uid, $row['name']]);
        // habits has no unique key in the schema, so MySQL would happily take a
        // second "Read". Merging a backup into an account that already has these
        // habits would then double them, and, worse, habit_logs would attach to
        // the new copy so the (habit_id, logged_date) dedupe below could never
        // fire. Matching on name is what makes that rule reachable at all.
        case 'habits':
            return $find('SELECT id FROM habits WHERE user_id=? AND name=?', [$uid, $row['name']]);
        case 'repos':
            return $find('SELECT id FROM repos WHERE user_id=? AND full_name=?', [$uid, $row['full_name']]);
        case 'habit_logs':
            return $find('SELECT id FROM habit_logs WHERE habit_id=? AND logged_date=?',
                [$row['habit_id'], $row['logged_date']]);
        case 'chat_sessions':
            return $find('SELECT id FROM chat_sessions WHERE user_id=? AND session_id=?', [$uid, $row['session_id']]);
        case 'activity_log':
            return $find('SELECT id FROM activity_log WHERE user_id=? AND created_at=? AND type=? AND summary=?',
                [$uid, $row['created_at'] ?? null, $row['type'], $row['summary']]);
        default:
            return null;
    }
}

/**
 * What to do with a collision. Almost always nothing: the existing row wins and
 * the remap points the children at it.
 *
 * habit_logs is the exception and takes max(count) rather than the sum. Summing
 * is the obvious choice and it is wrong: importing the same file twice would
 * double every day's count.
 */
function backup_merge_existing(PDO $pdo, string $table, int $existingId, array $row): void
{
    if ($table !== 'habit_logs') {
        return;
    }
    $pdo->prepare('UPDATE habit_logs SET count = GREATEST(count, ?) WHERE id = ?')
        ->execute([(int) ($row['count'] ?? 1), $existingId]);
}

/** The filename both apps use. */
function backup_filename(): string
{
    return 'inphub-backup-' . date('Y-m-d') . '.txt';
}
