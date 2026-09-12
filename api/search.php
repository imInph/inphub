<?php
/**
 * inphub: global search across everything the user owns.
 *
 *   GET ?action=search&q=<term>[&limit=5]
 *
 * One endpoint behind the command palette. Returns grouped results, each item
 * carrying the hash route that focuses it:
 *
 *   { q, total, truncated, groups: [ { type, label, items: [
 *       { id, label, sub, meta, amount?, currency? } ] } ] }
 *
 * Items deliberately carry no href: the client maps `type` to a view and
 * builds the route through go(), so a result can never navigate to an
 * unvalidated destination and route shape stays out of the backend.
 *
 * Groups come back in a fixed, useful order and empty groups are dropped.
 */

require_once __DIR__ . '/_bootstrap.php';

/** Queries shorter than this return nothing, one letter matches everything. */
const SEARCH_MIN_CHARS = 2;

/** Default rows per group. */
const SEARCH_DEFAULT_LIMIT = 5;

api_handle(function (): void {
    $uid   = current_user_id();
    $input = request_input();

    // GET defaults to 'list' in action(); treat it as a search too so the
    // endpoint works whichever the client sends.
    $act = action($input);
    if ($act !== 'search' && $act !== 'list') {
        fail('Unknown action.', 404);
    }

    $q     = trim((string) (str_or_null(input_get($input, 'q')) ?? ''));
    $limit = clamp_int((int) input_get($input, 'limit', SEARCH_DEFAULT_LIMIT), 1, 20);

    if (mb_strlen($q) < SEARCH_MIN_CHARS) {
        ok(['q' => $q, 'total' => 0, 'truncated' => false, 'groups' => []]);
    }

    $groups = array_values(array_filter([
        search_todos($uid, $q, $limit),
        search_expenses($uid, $q, $limit),
        search_notes($uid, $q, $limit),
        search_habits($uid, $q, $limit),
        search_goals($uid, $q, $limit),
        search_repos($uid, $q, $limit),
    ], static fn(array $g): bool => $g['items'] !== []));

    $total = 0;
    $truncated = false;
    foreach ($groups as $g) {
        $total += count($g['items']);
        $truncated = $truncated || $g['truncated'];
    }

    ok(['q' => $q, 'total' => $total, 'truncated' => $truncated, 'groups' => $groups]);
});

/* ------------------------------------------------------------------ helpers */

/**
 * Neutralise LIKE metacharacters in the user's text.
 *
 * The query is data, not a pattern: unescaped, "50%" matches every row holding
 * "50" and "a_b" matches "axb". Escaping with `!` rather than the default
 * backslash keeps the behaviour identical regardless of the server's sql_mode
 *, under NO_BACKSLASH_ESCAPES a backslash would stop escaping. Every LIKE
 * below therefore carries ESCAPE '!'; omitting it on one silently reverts that
 * clause to backslash semantics.
 */
function like_escape(string $q): string
{
    return str_replace(['!', '%', '_'], ['!!', '!%', '!_'], $q);
}

/** A "contains" needle. */
function like_contains(string $q): string
{
    return '%' . like_escape($q) . '%';
}

/** A "starts with" needle, used only to rank exact-ish matches first. */
function like_prefix(string $q): string
{
    return like_escape($q) . '%';
}

/**
 * Run one group's query and shape it.
 *
 * The caller's $sql carries a `{limit}` placeholder, which is replaced with
 * limit+1: fetching one extra row tells us whether there are genuinely more
 * results (rather than guessing from "we filled the limit"), and the extra is
 * dropped before returning. The value is a clamped int interpolated into the
 * SQL because PDO runs with EMULATE_PREPARES off, so a bound LIMIT would
 * arrive quoted and MySQL would reject it, same approach as api/activity.php.
 */
function search_group(string $type, string $label, string $sql, array $params, int $limit, callable $shape): array
{
    $stmt = db()->prepare(str_replace('{limit}', (string) ($limit + 1), $sql));
    $stmt->execute($params);
    $rows = $stmt->fetchAll();

    $truncated = count($rows) > $limit;
    if ($truncated) {
        $rows = array_slice($rows, 0, $limit);
    }

    $items = [];
    foreach ($rows as $row) {
        $items[] = $shape($row);
    }
    return ['type' => $type, 'label' => $label, 'items' => $items, 'truncated' => $truncated];
}

/** Collapse whitespace and clip, for note bodies and long descriptions. */
function search_snippet(?string $text, int $length = 90): string
{
    $text = trim((string) preg_replace('/\s+/', ' ', (string) $text));
    return mb_strlen($text) > $length ? mb_substr($text, 0, $length - 1) . '…' : $text;
}

/* ------------------------------------------------------------------- groups */

function search_todos(int $uid, string $q, int $limit): array
{
    return search_group('todo', 'Tasks',
        "SELECT id, title, description, project, tags, status, priority, due_date
         FROM todos
         WHERE user_id = ?
           AND (title LIKE ? ESCAPE '!' OR description LIKE ? ESCAPE '!' OR project LIKE ? ESCAPE '!' OR tags LIKE ? ESCAPE '!')
         ORDER BY (title LIKE ? ESCAPE '!') DESC,
                  (status IN ('done','archived')) ASC,
                  (due_date IS NULL) ASC, due_date ASC, id DESC
         LIMIT {limit}",
        [$uid, ...array_fill(0, 4, like_contains($q)), like_prefix($q)], $limit,
        static function (array $r): array {
            $bits = [];
            if ($r['project'] !== null && $r['project'] !== '') {
                $bits[] = '#' . $r['project'];
            }
            if ($r['status'] !== 'todo') {
                $bits[] = str_replace('_', ' ', (string) $r['status']);
            }
            if ($r['priority'] !== 'medium') {
                $bits[] = (string) $r['priority'];
            }
            return [
                'id'    => (int) $r['id'],
                'label' => (string) $r['title'],
                'sub'   => implode(' · ', $bits),
                'meta'  => $r['due_date'] !== null ? 'due ' . $r['due_date'] : '',
            ];
        });
}

function search_expenses(int $uid, string $q, int $limit): array
{
    return search_group('expense', 'Money',
        "SELECT e.id, e.description, e.amount, e.currency, e.type, e.spent_at, c.name AS category
         FROM expenses e
         LEFT JOIN expense_categories c ON c.id = e.category_id AND c.user_id = e.user_id
         WHERE e.user_id = ?
           AND (e.description LIKE ? ESCAPE '!' OR c.name LIKE ? ESCAPE '!' OR e.payment_method LIKE ? ESCAPE '!')
         ORDER BY (e.description LIKE ? ESCAPE '!') DESC, e.spent_at DESC, e.id DESC
         LIMIT {limit}",
        [$uid, ...array_fill(0, 3, like_contains($q)), like_prefix($q)], $limit,
        static function (array $r): array {
            $label = search_snippet($r['description']);
            if ($label === '') {
                $label = $r['category'] !== null ? (string) $r['category'] : 'Entry';
            }
            return [
                'id'       => (int) $r['id'],
                'label'    => $label,
                'sub'      => trim(($r['type'] === 'income' ? 'income' : 'expense')
                              . ($r['category'] !== null ? ' · ' . $r['category'] : '')),
                'meta'     => (string) $r['spent_at'],
                'amount'   => (float) $r['amount'],
                'currency' => (string) $r['currency'],
            ];
        });
}

function search_notes(int $uid, string $q, int $limit): array
{
    return search_group('note', 'Notes',
        "SELECT id, title, content, tags, pinned, updated_at
         FROM notes
         WHERE user_id = ?
           AND (title LIKE ? ESCAPE '!' OR content LIKE ? ESCAPE '!' OR tags LIKE ? ESCAPE '!')
         ORDER BY (title LIKE ? ESCAPE '!') DESC, pinned DESC, updated_at DESC, id DESC
         LIMIT {limit}",
        [$uid, ...array_fill(0, 3, like_contains($q)), like_prefix($q)], $limit,
        static function (array $r): array {
            $title = str_or_null($r['title']);
            return [
                'id'    => (int) $r['id'],
                'label' => $title ?? search_snippet($r['content'], 60),
                'sub'   => $title !== null ? search_snippet($r['content'], 70) : '',
                'meta'  => ((int) $r['pinned'] === 1 ? 'pinned · ' : '') . substr((string) $r['updated_at'], 0, 10),
            ];
        });
}

function search_habits(int $uid, string $q, int $limit): array
{
    return search_group('habit', 'Habits',
        "SELECT id, name, description, frequency, is_active
         FROM habits
         WHERE user_id = ? AND (name LIKE ? ESCAPE '!' OR description LIKE ? ESCAPE '!')
         ORDER BY (name LIKE ? ESCAPE '!') DESC, is_active DESC, sort_order ASC, id ASC
         LIMIT {limit}",
        [$uid, ...array_fill(0, 2, like_contains($q)), like_prefix($q)], $limit,
        static fn(array $r): array => [
            'id'    => (int) $r['id'],
            'label' => (string) $r['name'],
            'sub'   => search_snippet($r['description'], 70),
            'meta'  => (string) $r['frequency'] . ((int) $r['is_active'] === 1 ? '' : ' · paused'),
        ]);
}

function search_goals(int $uid, string $q, int $limit): array
{
    return search_group('goal', 'Goals',
        "SELECT id, title, description, category, current_value, target_value, unit, status
         FROM goals
         WHERE user_id = ? AND (title LIKE ? ESCAPE '!' OR description LIKE ? ESCAPE '!' OR category LIKE ? ESCAPE '!')
         ORDER BY (title LIKE ? ESCAPE '!') DESC, FIELD(status,'active','paused','completed'), id DESC
         LIMIT {limit}",
        [$uid, ...array_fill(0, 3, like_contains($q)), like_prefix($q)], $limit,
        static function (array $r): array {
            $progress = (string) (int) $r['current_value']
                . ($r['target_value'] !== null ? '/' . (int) $r['target_value'] : '')
                . ($r['unit'] !== null && $r['unit'] !== '' ? ' ' . $r['unit'] : '');
            return [
                'id'    => (int) $r['id'],
                'label' => (string) $r['title'],
                'sub'   => trim($progress . ($r['status'] !== 'active' ? ' · ' . $r['status'] : '')),
                'meta'  => (string) ($r['category'] ?? ''),
            ];
        });
}

function search_repos(int $uid, string $q, int $limit): array
{
    return search_group('repo', 'Repositories',
        "SELECT id, name, full_name, description, language, health_score, staleness_days
         FROM repos
         WHERE user_id = ? AND (name LIKE ? ESCAPE '!' OR full_name LIKE ? ESCAPE '!' OR description LIKE ? ESCAPE '!')
         ORDER BY (name LIKE ? ESCAPE '!') DESC, pinned DESC, name ASC, id DESC
         LIMIT {limit}",
        [$uid, ...array_fill(0, 3, like_contains($q)), like_prefix($q)], $limit,
        static fn(array $r): array => [
            'id'    => (int) $r['id'],
            'label' => (string) $r['full_name'],
            'sub'   => search_snippet($r['description'], 70),
            'meta'  => trim((string) ($r['language'] ?? '')
                       . ($r['health_score'] !== null ? ' · health ' . (int) $r['health_score'] : '')),
        ]);
}
