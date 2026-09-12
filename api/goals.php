<?php
/**
 * inphub: goals CRUD + quick nudge.
 *
 *   GET  ?action=list
 *   POST ?action=create { title, ... }
 *   POST ?action=update { id, ... }
 *   POST ?action=nudge  { id, delta }     add delta to current_value
 *   POST ?action=delete { id }
 */

require_once __DIR__ . '/_bootstrap.php';

api_handle(function (): void {
    $uid   = current_user_id();
    $input = request_input();

    switch (action($input)) {
        case 'list': {
            $stmt = db()->prepare('SELECT * FROM goals WHERE user_id = ? ORDER BY status ASC, (target_date IS NULL), target_date ASC, id DESC');
            $stmt->execute([$uid]);
            ok($stmt->fetchAll());
            break;
        }

        case 'create': {
            $title = str_or_null(input_get($input, 'title'));
            if ($title === null) {
                fail('Goal title is required.', 422);
            }
            $stmt = db()->prepare(
                'INSERT INTO goals (user_id, title, description, category, target_value, current_value, unit, target_date, status)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
            );
            $stmt->execute([
                $uid,
                $title,
                str_or_null(input_get($input, 'description')),
                str_or_null(input_get($input, 'category')),
                int_or_null(input_get($input, 'target_value')),
                (int) input_get($input, 'current_value', 0),
                str_or_null(input_get($input, 'unit')),
                str_or_null(input_get($input, 'target_date')),
                valid_enum(input_get($input, 'status'), ['active', 'completed', 'paused'], 'active'),
            ]);
            $id = (int) db()->lastInsertId();
            log_activity($uid, 'goal.created', 'goal', $id, 'New goal: ' . $title);
            ok(['id' => $id]);
            break;
        }

        case 'update': {
            $g = fetch_owned('goals', (int) input_get($input, 'id'), $uid);
            $stmt = db()->prepare(
                'UPDATE goals SET title=?, description=?, category=?, target_value=?, current_value=?, unit=?, target_date=?, status=?
                 WHERE id=? AND user_id=?'
            );
            $stmt->execute([
                str_or_null(input_get($input, 'title', $g['title'])) ?? $g['title'],
                array_key_exists('description', $input) ? str_or_null($input['description']) : $g['description'],
                array_key_exists('category', $input) ? str_or_null($input['category']) : $g['category'],
                array_key_exists('target_value', $input) ? int_or_null($input['target_value']) : $g['target_value'],
                (int) input_get($input, 'current_value', $g['current_value']),
                array_key_exists('unit', $input) ? str_or_null($input['unit']) : $g['unit'],
                array_key_exists('target_date', $input) ? str_or_null($input['target_date']) : $g['target_date'],
                valid_enum(input_get($input, 'status', $g['status']), ['active', 'completed', 'paused'], $g['status']),
                (int) $g['id'],
                $uid,
            ]);
            ok(['id' => (int) $g['id']]);
            break;
        }

        case 'nudge': {
            $g     = fetch_owned('goals', (int) input_get($input, 'id'), $uid);
            $delta = (int) input_get($input, 'delta', 0);
            $newValue = max(0, (int) $g['current_value'] + $delta);
            $status   = $g['status'];
            if ($g['target_value'] !== null && $newValue >= (int) $g['target_value'] && $status === 'active') {
                $status = 'completed';
            }
            $stmt = db()->prepare('UPDATE goals SET current_value=?, status=? WHERE id=? AND user_id=?');
            $stmt->execute([$newValue, $status, (int) $g['id'], $uid]);
            log_activity($uid, 'goal.progress', 'goal', (int) $g['id'], $g['title'] . " → $newValue" . ($g['unit'] ? ' ' . $g['unit'] : ''));
            ok(['id' => (int) $g['id'], 'current_value' => $newValue, 'status' => $status]);
            break;
        }

        case 'delete': {
            $g = fetch_owned('goals', (int) input_get($input, 'id'), $uid);
            $del = db()->prepare('DELETE FROM goals WHERE id=? AND user_id=?');
            $del->execute([(int) $g['id'], $uid]);
            ok(['deleted' => (int) $g['id']]);
            break;
        }

        default:
            fail('Unknown action.', 404);
    }
});
