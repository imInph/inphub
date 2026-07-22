<?php
/**
 * inphub — todos CRUD.
 *
 *   GET  ?action=list[&status=&project=]
 *   GET  ?action=history                 todos bucketed by ISO week (Mon–Sun)
 *   POST ?action=create   { title, description?, status?, priority?, project?, tags?, due_date?, recurring? }
 *   POST ?action=update   { id, ...fields }
 *   POST ?action=complete { id }
 *   POST ?action=reorder  { order: [ids in new order] }
 *   POST ?action=delete   { id }
 */

require_once __DIR__ . '/_bootstrap.php';

api_handle(function (): void {
    $uid   = current_user_id();
    $input = request_input();

    switch (action($input)) {
        case 'list': {
            $sql    = 'SELECT * FROM todos WHERE user_id = ?';
            $params = [$uid];
            if ($status = str_or_null(input_get($input, 'status'))) {
                $sql .= ' AND status = ?';
                $params[] = $status;
            }
            if ($project = str_or_null(input_get($input, 'project'))) {
                $sql .= ' AND project = ?';
                $params[] = $project;
            }
            $sql .= ' ORDER BY sort_order ASC, (due_date IS NULL), due_date ASC, id DESC';
            $stmt = db()->prepare($sql);
            $stmt->execute($params);
            ok($stmt->fetchAll());
            break;
        }

        case 'history':
            ok(todos_history($uid));
            break;

        case 'create': {
            $title = str_or_null(input_get($input, 'title'));
            if ($title === null) {
                fail('Title is required.', 422);
            }
            $createdBy = input_get($input, 'created_by') === 'ai' ? 'ai' : 'user';
            $stmt = db()->prepare(
                'INSERT INTO todos
                    (user_id, title, description, status, priority, project, tags, due_date, recurring, sort_order, created_by)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
            );
            $stmt->execute([
                $uid,
                $title,
                str_or_null(input_get($input, 'description')),
                valid_enum(input_get($input, 'status'), ['todo', 'in_progress', 'done', 'archived'], 'todo'),
                valid_enum(input_get($input, 'priority'), ['low', 'medium', 'high', 'urgent'], 'medium'),
                str_or_null(input_get($input, 'project')),
                str_or_null(input_get($input, 'tags')),
                str_or_null(input_get($input, 'due_date')),
                str_or_null(input_get($input, 'recurring')),
                (int) input_get($input, 'sort_order', 0),
                $createdBy,
            ]);
            $id = (int) db()->lastInsertId();
            log_activity($uid, 'todo.created', 'todo', $id, 'Added todo: ' . $title, $createdBy === 'ai' ? 'ai' : 'user');
            ok(['id' => $id]);
            break;
        }

        case 'update': {
            $todo = fetch_owned('todos', (int) input_get($input, 'id'), $uid);
            $fields = [
                'title'       => str_or_null(input_get($input, 'title', $todo['title'])) ?? $todo['title'],
                'description' => array_key_exists('description', $input) ? str_or_null($input['description']) : $todo['description'],
                'status'      => valid_enum(input_get($input, 'status', $todo['status']), ['todo', 'in_progress', 'done', 'archived'], $todo['status']),
                'priority'    => valid_enum(input_get($input, 'priority', $todo['priority']), ['low', 'medium', 'high', 'urgent'], $todo['priority']),
                'project'     => array_key_exists('project', $input) ? str_or_null($input['project']) : $todo['project'],
                'tags'        => array_key_exists('tags', $input) ? str_or_null($input['tags']) : $todo['tags'],
                'due_date'    => array_key_exists('due_date', $input) ? str_or_null($input['due_date']) : $todo['due_date'],
                'recurring'   => array_key_exists('recurring', $input) ? str_or_null($input['recurring']) : $todo['recurring'],
            ];
            $stmt = db()->prepare(
                'UPDATE todos SET title=?, description=?, status=?, priority=?, project=?, tags=?, due_date=?, recurring=?
                 WHERE id=? AND user_id=?'
            );
            $stmt->execute([...array_values($fields), (int) $todo['id'], $uid]);
            log_activity($uid, 'todo.updated', 'todo', (int) $todo['id'], 'Updated todo: ' . $fields['title']);
            ok(['id' => (int) $todo['id']]);
            break;
        }

        case 'complete': {
            $todo = fetch_owned('todos', (int) input_get($input, 'id'), $uid);
            $stmt = db()->prepare(
                "UPDATE todos SET status='done', completed_at=NOW() WHERE id=? AND user_id=?"
            );
            $stmt->execute([(int) $todo['id'], $uid]);
            log_activity($uid, 'todo.completed', 'todo', (int) $todo['id'], 'Completed: ' . $todo['title']);

            // Regenerate recurring todos as a fresh open copy with the next due date.
            $newId = null;
            if (!empty($todo['recurring'])) {
                $newId = regenerate_recurring_todo($uid, $todo);
            }
            ok(['id' => (int) $todo['id'], 'regenerated' => $newId]);
            break;
        }

        case 'reorder': {
            $order = input_get($input, 'order', []);
            if (!is_array($order)) {
                fail('order must be an array of ids.', 422);
            }
            $stmt = db()->prepare('UPDATE todos SET sort_order=? WHERE id=? AND user_id=?');
            foreach (array_values($order) as $pos => $id) {
                $stmt->execute([$pos, (int) $id, $uid]);
            }
            ok(['reordered' => count($order)]);
            break;
        }

        case 'delete': {
            $todo = fetch_owned('todos', (int) input_get($input, 'id'), $uid);
            $del = db()->prepare('DELETE FROM todos WHERE id=? AND user_id=?');
            $del->execute([(int) $todo['id'], $uid]);
            log_activity($uid, 'todo.deleted', 'todo', (int) $todo['id'], 'Deleted todo: ' . $todo['title']);
            ok(['deleted' => (int) $todo['id']]);
            break;
        }

        default:
            fail('Unknown action.', 404);
    }
});

/**
 * Todos bucketed by ISO week (Monday–Sunday), newest week first, over the last
 * 8 weeks. Nothing is deleted or moved in the DB — this is a display bucketing:
 *  - a completed task appears in the week it was completed;
 *  - an open task appears in the CURRENT week (active — "carried" if it began
 *    earlier) AND stays visible in the past week it was created.
 */
function todos_history(int $uid): array
{
    $weeksBack     = 8;
    $today         = new DateTimeImmutable('today');
    $dow           = (int) $today->format('N');               // 1=Mon … 7=Sun
    $currentMonday = $today->modify('-' . ($dow - 1) . ' days');
    $windowStart   = $currentMonday->modify('-' . (($weeksBack - 1) * 7) . ' days');
    $curKey        = $currentMonday->format('Y-m-d');

    // Prepare empty buckets, current week first.
    $buckets = [];
    for ($i = 0; $i < $weeksBack; $i++) {
        $mon = $currentMonday->modify('-' . ($i * 7) . ' days');
        $buckets[$mon->format('Y-m-d')] = [
            'week_start' => $mon->format('Y-m-d'),
            'week_end'   => $mon->modify('+6 days')->format('Y-m-d'),
            'items'      => [],
            '_ids'       => [],
        ];
    }

    $stmt = db()->prepare(
        "SELECT id, title, status, priority, created_at, completed_at, due_date
         FROM todos
         WHERE user_id = ?
           AND ( status IN ('todo','in_progress')
                 OR (completed_at IS NOT NULL AND completed_at >= ?)
                 OR created_at >= ? )
         ORDER BY created_at ASC"
    );
    $ws = $windowStart->format('Y-m-d 00:00:00');
    $stmt->execute([$uid, $ws, $ws]);

    foreach ($stmt->fetchAll() as $r) {
        if ($r['status'] === 'archived') {
            continue;
        }
        if ($r['status'] === 'done') {
            $k = week_monday_key((string) $r['completed_at']);
            if ($k !== null && isset($buckets[$k])) {
                history_add($buckets[$k], $r, 'done');
            }
            continue;
        }
        // Open task: always active in the current week…
        $createdKey = week_monday_key((string) $r['created_at']);
        history_add($buckets[$curKey], $r, $createdKey === $curKey ? 'open' : 'carried');
        // …and still visible in the past week it originated in.
        if ($createdKey !== null && $createdKey !== $curKey && isset($buckets[$createdKey])) {
            history_add($buckets[$createdKey], $r, 'open');
        }
    }

    $weeks = [];
    foreach ($buckets as $key => $b) {
        unset($b['_ids']);
        if ($b['items'] || $key === $curKey) {
            $weeks[] = $b;
        }
    }
    return ['weeks' => $weeks, 'current_week_start' => $curKey];
}

/** Monday (Y-m-d) of the ISO week containing a datetime string, or null. */
function week_monday_key(string $datetime): ?string
{
    $date = substr(trim($datetime), 0, 10);
    if ($date === '') {
        return null;
    }
    $d = DateTimeImmutable::createFromFormat('Y-m-d', $date);
    if ($d === false) {
        return null;
    }
    $dow = (int) $d->format('N');
    return $d->modify('-' . ($dow - 1) . ' days')->format('Y-m-d');
}

/** Append a todo to a week bucket once (deduped by id). */
function history_add(array &$bucket, array $r, string $state): void
{
    $id = (int) $r['id'];
    if (isset($bucket['_ids'][$id])) {
        return;
    }
    $bucket['_ids'][$id] = true;
    $bucket['items'][] = [
        'id'           => $id,
        'title'        => $r['title'],
        'status'       => $r['status'],
        'priority'     => $r['priority'],
        'completed_at' => $r['completed_at'],
        'created_at'   => $r['created_at'],
        'state'        => $state, // done | open | carried
    ];
}

/** Advance a recurring todo's due date and insert a fresh open copy. */
function regenerate_recurring_todo(int $uid, array $todo): int
{
    $base = $todo['due_date'] ?: today();
    $interval = match ($todo['recurring']) {
        'daily'   => '+1 day',
        'weekly'  => '+1 week',
        'monthly' => '+1 month',
        default   => null,
    };
    if ($interval === null) {
        return 0;
    }
    $nextDue = date('Y-m-d', strtotime($base . ' ' . $interval));

    $stmt = db()->prepare(
        'INSERT INTO todos
            (user_id, title, description, status, priority, project, tags, due_date, recurring, sort_order, created_by)
         VALUES (?, ?, ?, "todo", ?, ?, ?, ?, ?, ?, ?)'
    );
    $stmt->execute([
        $uid,
        $todo['title'],
        $todo['description'],
        $todo['priority'],
        $todo['project'],
        $todo['tags'],
        $nextDue,
        $todo['recurring'],
        (int) $todo['sort_order'],
        $todo['created_by'],
    ]);
    return (int) db()->lastInsertId();
}
