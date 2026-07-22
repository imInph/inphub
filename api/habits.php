<?php
/**
 * inphub — habits: manage + daily logging + streaks.
 *
 *   GET  ?action=list                      habits with today state, streaks, recent logs
 *   POST ?action=create { name, ... }
 *   POST ?action=update { id, ... }
 *   POST ?action=delete { id }
 *   POST ?action=log    { id, date?, note? }   toggle a day (unique per day)
 */

require_once __DIR__ . '/_bootstrap.php';

api_handle(function (): void {
    $uid   = current_user_id();
    $input = request_input();

    switch (action($input)) {
        case 'list': {
            $stmt = db()->prepare('SELECT * FROM habits WHERE user_id = ? ORDER BY sort_order ASC, id ASC');
            $stmt->execute([$uid]);
            $habits = $stmt->fetchAll();

            // Pull the last 140 days of logs once, group by habit.
            $logStmt = db()->prepare(
                'SELECT habit_id, logged_date, count FROM habit_logs
                 WHERE user_id = ? AND logged_date >= (CURRENT_DATE - INTERVAL 140 DAY)
                 ORDER BY logged_date ASC'
            );
            $logStmt->execute([$uid]);
            $byHabit = [];
            foreach ($logStmt->fetchAll() as $log) {
                $byHabit[(int) $log['habit_id']][] = $log;
            }

            $today = today();
            foreach ($habits as &$h) {
                $logs = $byHabit[(int) $h['id']] ?? [];
                $dates = array_map(fn($l) => $l['logged_date'], $logs);
                $h['logs']          = $logs;
                $h['logged_today']  = in_array($today, $dates, true);
                [$cur, $best]       = streaks($dates);
                $h['current_streak'] = $cur;
                $h['best_streak']    = $best;
            }
            unset($h);
            ok($habits);
            break;
        }

        case 'create': {
            $name = str_or_null(input_get($input, 'name'));
            if ($name === null) {
                fail('Habit name is required.', 422);
            }
            $stmt = db()->prepare(
                'INSERT INTO habits (user_id, name, description, frequency, target_per_period, color, icon, sort_order)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
            );
            $stmt->execute([
                $uid,
                $name,
                str_or_null(input_get($input, 'description')),
                valid_enum(input_get($input, 'frequency'), ['daily', 'weekly'], 'daily'),
                max(1, (int) input_get($input, 'target_per_period', 1)),
                str_or_null(input_get($input, 'color')) ?? '#4f8cff',
                str_or_null(input_get($input, 'icon')),
                (int) input_get($input, 'sort_order', 0),
            ]);
            ok(['id' => (int) db()->lastInsertId()]);
            break;
        }

        case 'update': {
            $h = fetch_owned('habits', (int) input_get($input, 'id'), $uid);
            $stmt = db()->prepare(
                'UPDATE habits SET name=?, description=?, frequency=?, target_per_period=?, color=?, icon=?, is_active=?, sort_order=?
                 WHERE id=? AND user_id=?'
            );
            $stmt->execute([
                str_or_null(input_get($input, 'name', $h['name'])) ?? $h['name'],
                array_key_exists('description', $input) ? str_or_null($input['description']) : $h['description'],
                valid_enum(input_get($input, 'frequency', $h['frequency']), ['daily', 'weekly'], $h['frequency']),
                max(1, (int) input_get($input, 'target_per_period', $h['target_per_period'])),
                str_or_null(input_get($input, 'color', $h['color'])) ?? $h['color'],
                array_key_exists('icon', $input) ? str_or_null($input['icon']) : $h['icon'],
                (int) (bool) input_get($input, 'is_active', $h['is_active']),
                (int) input_get($input, 'sort_order', $h['sort_order']),
                (int) $h['id'],
                $uid,
            ]);
            ok(['id' => (int) $h['id']]);
            break;
        }

        case 'delete': {
            $h = fetch_owned('habits', (int) input_get($input, 'id'), $uid);
            $del = db()->prepare('DELETE FROM habits WHERE id=? AND user_id=?');
            $del->execute([(int) $h['id'], $uid]);
            ok(['deleted' => (int) $h['id']]);
            break;
        }

        case 'log': {
            $h    = fetch_owned('habits', (int) input_get($input, 'id'), $uid);
            $date = str_or_null(input_get($input, 'date')) ?? today();

            // Toggle: if already logged that day, remove it; otherwise insert.
            $check = db()->prepare('SELECT id FROM habit_logs WHERE habit_id=? AND logged_date=?');
            $check->execute([(int) $h['id'], $date]);
            $existing = $check->fetchColumn();

            if ($existing !== false) {
                $del = db()->prepare('DELETE FROM habit_logs WHERE id=?');
                $del->execute([(int) $existing]);
                ok(['logged' => false, 'date' => $date]);
            } else {
                $ins = db()->prepare(
                    'INSERT INTO habit_logs (user_id, habit_id, logged_date, count, note) VALUES (?, ?, ?, 1, ?)'
                );
                $ins->execute([$uid, (int) $h['id'], $date, str_or_null(input_get($input, 'note'))]);
                log_activity($uid, 'habit.logged', 'habit', (int) $h['id'], 'Logged habit: ' . $h['name'], 'user');
                ok(['logged' => true, 'date' => $date]);
            }
            break;
        }

        default:
            fail('Unknown action.', 404);
    }
});

/**
 * Given an ascending list of YYYY-MM-DD strings, return [currentStreak, bestStreak]
 * as consecutive-day runs. Current streak counts back from today (or yesterday).
 */
function streaks(array $dates): array
{
    if (count($dates) === 0) {
        return [0, 0];
    }
    $set = array_flip($dates);

    // Best streak: longest consecutive run anywhere.
    $best = 0;
    foreach (array_keys($set) as $d) {
        $prev = date('Y-m-d', strtotime($d . ' -1 day'));
        if (!isset($set[$prev])) {
            // Start of a run — count forward.
            $len = 1;
            $cur = $d;
            while (isset($set[date('Y-m-d', strtotime($cur . ' +1 day'))])) {
                $cur = date('Y-m-d', strtotime($cur . ' +1 day'));
                $len++;
            }
            $best = max($best, $len);
        }
    }

    // Current streak: from today (or yesterday if today not yet logged) backwards.
    $current = 0;
    $cursor = today();
    if (!isset($set[$cursor])) {
        $cursor = date('Y-m-d', strtotime('-1 day'));
    }
    while (isset($set[$cursor])) {
        $current++;
        $cursor = date('Y-m-d', strtotime($cursor . ' -1 day'));
    }

    return [$current, $best];
}
