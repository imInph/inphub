<?php
/**
 * inphub: todos CRUD.
 *
 *   GET  ?action=list[&status=&project=]
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
            // completed_at must track status, or a task un-checked from the UI
            // keeps its old timestamp and stays filed under "done" in that
            // week of the History fold forever.
            $stmt = db()->prepare(
                'UPDATE todos SET title=?, description=?, status=?, priority=?, project=?, tags=?, due_date=?, recurring=?,
                    completed_at = CASE WHEN ? = "done" THEN COALESCE(completed_at, NOW()) ELSE NULL END
                 WHERE id=? AND user_id=?'
            );
            $stmt->execute([...array_values($fields), $fields['status'], (int) $todo['id'], $uid]);
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
