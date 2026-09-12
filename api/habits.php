<?php
/**
 * inphub: habits: manage + daily logging + streaks.
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
                $logs   = $byHabit[(int) $h['id']] ?? [];
                $target = max(1, (int) $h['target_per_period']);
                // A day counts as "done" only once the target is met, so a 3x
                // habit tapped once shows as partial instead of complete.
                $dates  = [];
                $todayCount = 0;
                foreach ($logs as $l) {
                    if ((int) $l['count'] >= $target) {
                        $dates[] = $l['logged_date'];
                    }
                    if ($l['logged_date'] === $today) {
                        $todayCount = (int) $l['count'];
                    }
                }
                $h['logs']           = $logs;
                $h['target']         = $target;
                $h['today_count']    = $todayCount;
                $h['logged_today']   = $todayCount >= $target;
                [$cur, $best]        = streaks($dates, (string) $h['frequency']);
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
            $h      = fetch_owned('habits', (int) input_get($input, 'id'), $uid);
            $date   = str_or_null(input_get($input, 'date')) ?? today();
            $target = max(1, (int) $h['target_per_period']);

            // habit_logs.count is what makes target_per_period mean anything:
            // the unique key is (habit_id, logged_date), so a habit you want to
            // do 3x a day counts up within the single row for that day rather
            // than inserting three. Each tap advances the count; the tap after
            // the target is reached clears the day (so it stays a toggle).
            $check = db()->prepare('SELECT id, count FROM habit_logs WHERE habit_id=? AND logged_date=?');
            $check->execute([(int) $h['id'], $date]);
            $row = $check->fetch();

            if ($row === false) {
                $ins = db()->prepare(
                    'INSERT INTO habit_logs (user_id, habit_id, logged_date, count, note) VALUES (?, ?, ?, 1, ?)'
                );
                $ins->execute([$uid, (int) $h['id'], $date, str_or_null(input_get($input, 'note'))]);
                log_activity($uid, 'habit.logged', 'habit', (int) $h['id'],
                    'Logged habit: ' . $h['name'] . ($target > 1 ? " (1/$target)" : ''), 'user');
                ok(['logged' => true, 'count' => 1, 'target' => $target, 'date' => $date]);
            } elseif ((int) $row['count'] < $target) {
                $next = (int) $row['count'] + 1;
                $upd = db()->prepare('UPDATE habit_logs SET count=? WHERE id=?');
                $upd->execute([$next, (int) $row['id']]);
                log_activity($uid, 'habit.logged', 'habit', (int) $h['id'],
                    'Logged habit: ' . $h['name'] . " ($next/$target)", 'user');
                ok(['logged' => true, 'count' => $next, 'target' => $target, 'date' => $date]);
            } else {
                $del = db()->prepare('DELETE FROM habit_logs WHERE id=?');
                $del->execute([(int) $row['id']]);
                log_activity($uid, 'habit.unlogged', 'habit', (int) $h['id'],
                    'Cleared habit: ' . $h['name'] . ' on ' . $date, 'user');
                ok(['logged' => false, 'count' => 0, 'target' => $target, 'date' => $date]);
            }
            break;
        }

        default:
            fail('Unknown action.', 404);
    }
});

/**
 * Given an ascending list of YYYY-MM-DD strings, return [currentStreak, bestStreak].
 *
 * $frequency 'daily' counts consecutive days; 'weekly' counts consecutive
 * ISO weeks with at least one log. Without the weekly branch a once-a-week
 * habit read "current 1 / best 1" forever, which made the whole frequency
 * setting decorative.
 */
function streaks(array $dates, string $frequency = 'daily'): array
{
    if (count($dates) === 0) {
        return [0, 0];
    }
    if ($frequency === 'weekly') {
        return week_streaks($dates);
    }
    $set = array_flip($dates);

    // Best streak: longest consecutive run anywhere.
    $best = 0;
    foreach (array_keys($set) as $d) {
        $prev = date('Y-m-d', strtotime($d . ' -1 day'));
        if (!isset($set[$prev])) {
            // Start of a run, count forward.
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

/** Consecutive-ISO-week runs, for habits with frequency = 'weekly'. */
function week_streaks(array $dates): array
{
    $weeks = [];
    foreach ($dates as $d) {
        $weeks[date('o-W', strtotime($d))] = true;
    }

    $best = 0;
    foreach (array_keys($weeks) as $w) {
        $prev = shift_week($w, -1);
        if (isset($weeks[$prev])) {
            continue;   // not the start of a run
        }
        $len = 1;
        $cur = $w;
        while (isset($weeks[shift_week($cur, 1)])) {
            $cur = shift_week($cur, 1);
            $len++;
        }
        $best = max($best, $len);
    }

    $current = 0;
    $cursor  = date('o-W');
    if (!isset($weeks[$cursor])) {
        $cursor = shift_week($cursor, -1);   // this week not logged yet
    }
    while (isset($weeks[$cursor])) {
        $current++;
        $cursor = shift_week($cursor, -1);
    }
    return [$current, $best];
}

/** Move an "o-W" ISO week key by $delta weeks. */
function shift_week(string $key, int $delta): string
{
    [$year, $week] = array_map('intval', explode('-', $key));
    $ts = strtotime(sprintf('%04dW%02d', $year, $week) . ' ' . ($delta >= 0 ? '+' : '-') . abs($delta) . ' week');
    return date('o-W', $ts ?: time());
}
