<?php
/**
 * inphub — focus sessions (pomodoro / deep work).
 *
 * The timer runs client-side; on completion (or manual stop) the client posts
 * the finished session here.
 *
 *   GET  ?action=list                     recent sessions + today total + weekly bar
 *   POST ?action=log { label?, linked_todo_id?, duration_minutes, started_at?, ended_at?, completed? }
 */

require_once __DIR__ . '/_bootstrap.php';

api_handle(function (): void {
    $uid   = current_user_id();
    $input = request_input();

    switch (action($input)) {
        case 'list': {
            $recent = db()->prepare(
                'SELECT f.*, t.title AS todo_title
                 FROM focus_sessions f
                 LEFT JOIN todos t ON t.id = f.linked_todo_id
                 WHERE f.user_id = ?
                 ORDER BY f.started_at DESC LIMIT 30'
            );
            $recent->execute([$uid]);

            $todayTotal = db()->prepare(
                "SELECT COALESCE(SUM(duration_minutes),0) FROM focus_sessions
                 WHERE user_id=? AND completed=1 AND DATE(started_at)=CURRENT_DATE"
            );
            $todayTotal->execute([$uid]);

            // Minutes per day for the last 7 days (for the weekly bar).
            $weekly = db()->prepare(
                "SELECT DATE(started_at) AS d, COALESCE(SUM(duration_minutes),0) AS minutes
                 FROM focus_sessions
                 WHERE user_id=? AND completed=1 AND started_at >= (CURRENT_DATE - INTERVAL 6 DAY)
                 GROUP BY DATE(started_at)"
            );
            $weekly->execute([$uid]);
            $weekMap = [];
            foreach ($weekly->fetchAll() as $row) {
                $weekMap[$row['d']] = (int) $row['minutes'];
            }
            $week = [];
            for ($i = 6; $i >= 0; $i--) {
                $d = date('Y-m-d', strtotime("-$i day"));
                $week[] = ['date' => $d, 'minutes' => $weekMap[$d] ?? 0];
            }

            ok([
                'sessions'     => $recent->fetchAll(),
                'today_total'  => (int) $todayTotal->fetchColumn(),
                'weekly'       => $week,
            ]);
            break;
        }

        case 'log': {
            $duration = (int) input_get($input, 'duration_minutes', 0);
            if ($duration <= 0) {
                fail('duration_minutes must be positive.', 422);
            }
            $todoId = int_or_null(input_get($input, 'linked_todo_id'));
            if ($todoId !== null) {
                fetch_owned('todos', $todoId, $uid); // ensure ownership
            }
            $started = str_or_null(input_get($input, 'started_at')) ?? date('Y-m-d H:i:s');
            $ended   = str_or_null(input_get($input, 'ended_at')) ?? date('Y-m-d H:i:s');

            $stmt = db()->prepare(
                'INSERT INTO focus_sessions
                    (user_id, label, linked_todo_id, duration_minutes, started_at, ended_at, completed)
                 VALUES (?, ?, ?, ?, ?, ?, ?)'
            );
            $completed = (int) (bool) input_get($input, 'completed', 1);
            $stmt->execute([
                $uid,
                str_or_null(input_get($input, 'label')),
                $todoId,
                $duration,
                $started,
                $ended,
                $completed,
            ]);
            $id = (int) db()->lastInsertId();
            if ($completed) {
                log_activity($uid, 'focus.completed', 'focus', $id, "Focused $duration min" . ($input['label'] ?? '' ? ': ' . $input['label'] : ''));
            }
            ok(['id' => $id]);
            break;
        }

        default:
            fail('Unknown action.', 404);
    }
});
