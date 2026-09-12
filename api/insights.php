<?php
/**
 * inphub: cross-entity insights.
 *
 *   GET ?action=summary[&period=month|last_month|3m|6m|year|all]
 *
 * Everything here reads existing tables; nothing is stored. The window comes
 * from money_window() in lib/helpers.php, the name is historical, the maths
 * is generic (whole calendar months, inclusive bounds, null for 'all').
 *
 * Returns:
 *   { period, label, from, to, days, currency, granularity,
 *     totals:    { spend, income, tasks_done, focus_minutes, notes, habit_rate },
 *     weekday:   [ { dow, label_index, total, count } ],      spend per weekday
 *     habits:    [ { id, name, color, done_days, rate } ],    consistency
 *     focus:     [ { d, minutes } ],                          zero-filled series
 *     velocity:  [ { d, done } ],                             tasks completed
 *     hours:     [ { hour, count } ],                         when you act
 *     categories:[ { name, color, total } ] }                 where money went
 */

require_once __DIR__ . '/_bootstrap.php';

api_handle(function (): void {
    $uid   = current_user_id();
    $input = request_input();

    $act = action($input);
    if ($act !== 'summary' && $act !== 'list') {
        fail('Unknown action.', 404);
    }

    $win    = money_window($input);
    $from   = $win['from'];
    $to     = $win['to'];
    $ranged = $from !== null;
    $pdo    = db();

    // Shared window predicate. Column names are literals from this file, never
    // user input; bounds are always bound params. 'all' drops the clause.
    $clause = static function (string $column) use ($ranged): string {
        return $ranged ? " AND {$column} >= ? AND {$column} <= ?" : '';
    };
    $bounds     = $ranged ? [$from, $to] : [];
    $boundsTime = $ranged ? [$from . ' 00:00:00', $to . ' 23:59:59'] : [];

    /* ------------------------------------------------------------ headline */

    $money = $pdo->prepare(
        "SELECT COALESCE(SUM(CASE WHEN type='expense' THEN amount END),0) AS spend,
                COALESCE(SUM(CASE WHEN type='income'  THEN amount END),0) AS income
         FROM expenses WHERE user_id=?" . $clause('spent_at')
    );
    $money->execute(array_merge([$uid], $bounds));
    $moneyRow = $money->fetch();

    $tasks = $pdo->prepare(
        "SELECT COUNT(*) FROM todos WHERE user_id=? AND completed_at IS NOT NULL"
        . $clause('DATE(completed_at)')
    );
    $tasks->execute(array_merge([$uid], $bounds));

    $focusTotal = $pdo->prepare(
        "SELECT COALESCE(SUM(duration_minutes),0) FROM focus_sessions WHERE user_id=?"
        . $clause('DATE(started_at)')
    );
    $focusTotal->execute(array_merge([$uid], $bounds));

    $notes = $pdo->prepare(
        "SELECT COUNT(*) FROM notes WHERE user_id=?" . $clause('DATE(created_at)')
    );
    $notes->execute(array_merge([$uid], $bounds));

    /* ------------------------------------------- spend by day of the week */

    // WEEKDAY() is 0=Monday..6=Sunday, unlike DAYOFWEEK() which starts Sunday.
    $weekday = $pdo->prepare(
        "SELECT WEEKDAY(spent_at) AS dow, COALESCE(SUM(amount),0) AS total, COUNT(*) AS n
         FROM expenses WHERE user_id=? AND type='expense'" . $clause('spent_at') .
        " GROUP BY dow ORDER BY dow"
    );
    $weekday->execute(array_merge([$uid], $bounds));
    $byDow = [];
    foreach ($weekday->fetchAll() as $row) {
        $byDow[(int) $row['dow']] = ['total' => (float) $row['total'], 'count' => (int) $row['n']];
    }
    $weekdays = [];
    for ($i = 0; $i < 7; $i++) {
        $weekdays[] = [
            'dow'   => $i,
            'total' => $byDow[$i]['total'] ?? 0.0,
            'count' => $byDow[$i]['count'] ?? 0,
        ];
    }

    /* ------------------------------------------------- habit consistency */

    $habits = $pdo->prepare(
        "SELECT h.id, h.name, h.color, GREATEST(h.target_per_period, 1) AS target,
                COUNT(DISTINCT CASE WHEN hl.count >= GREATEST(h.target_per_period, 1)
                      THEN hl.logged_date END) AS done_days
         FROM habits h
         LEFT JOIN habit_logs hl
                ON hl.habit_id = h.id AND hl.user_id = h.user_id" . $clause('hl.logged_date') .
        " WHERE h.user_id=? AND h.is_active=1
         GROUP BY h.id ORDER BY done_days DESC, h.sort_order ASC"
    );
    $habits->execute(array_merge($bounds, [$uid]));
    $habitRows = $habits->fetchAll();

    // Days in the window, so "done_days" can become a rate. For 'all' we
    // measure from the first log there has ever been.
    if ($ranged) {
        $end  = min(strtotime($to), strtotime(today()));
        $days = max(1, (int) floor(($end - strtotime($from)) / 86400) + 1);
    } else {
        $firstStmt = $pdo->prepare('SELECT MIN(logged_date) FROM habit_logs WHERE user_id=?');
        $firstStmt->execute([$uid]);
        $first = $firstStmt->fetchColumn();
        $days  = $first ? max(1, (int) floor((strtotime(today()) - strtotime((string) $first)) / 86400) + 1) : 1;
    }

    $habitOut  = [];
    $rateTotal = 0.0;
    foreach ($habitRows as $row) {
        $rate = min(1.0, (int) $row['done_days'] / $days);
        $rateTotal += $rate;
        $habitOut[] = [
            'id'        => (int) $row['id'],
            'name'      => (string) $row['name'],
            'color'     => (string) ($row['color'] ?: '#4f8cff'),
            'done_days' => (int) $row['done_days'],
            'rate'      => round($rate, 4),
        ];
    }

    /* ----------------------------------------- focus + task-done series */

    $spanDays    = $ranged ? (int) floor((strtotime($to) - strtotime($from)) / 86400) + 1 : PHP_INT_MAX;
    $granularity = $spanDays <= 62 ? 'day' : 'month';
    $bucket      = $granularity === 'day' ? 'DATE(%s)' : "DATE_FORMAT(%s, '%%Y-%%m')";

    $focusSeries = $pdo->prepare(
        'SELECT ' . sprintf($bucket, 'started_at') . " AS d, COALESCE(SUM(duration_minutes),0) AS minutes
         FROM focus_sessions WHERE user_id=?" . $clause('DATE(started_at)') .
        ' GROUP BY d ORDER BY d'
    );
    $focusSeries->execute(array_merge([$uid], $bounds));

    $velocity = $pdo->prepare(
        'SELECT ' . sprintf($bucket, 'completed_at') . " AS d, COUNT(*) AS done
         FROM todos WHERE user_id=? AND completed_at IS NOT NULL" . $clause('DATE(completed_at)') .
        ' GROUP BY d ORDER BY d'
    );
    $velocity->execute(array_merge([$uid], $bounds));

    /* ----------------------------------------------- when you're active */

    $hours = $pdo->prepare(
        "SELECT HOUR(created_at) AS h, COUNT(*) AS n FROM activity_log
         WHERE user_id=?" . $clause('created_at') . ' GROUP BY h ORDER BY h'
    );
    $hours->execute(array_merge([$uid], $boundsTime));
    $byHour = [];
    foreach ($hours->fetchAll() as $row) {
        $byHour[(int) $row['h']] = (int) $row['n'];
    }
    $hourOut = [];
    for ($h = 0; $h < 24; $h++) {
        $hourOut[] = ['hour' => $h, 'count' => $byHour[$h] ?? 0];
    }

    /* ---------------------------------------------------- where money went */

    $cats = $pdo->prepare(
        "SELECT c.name, c.color, COALESCE(SUM(e.amount),0) AS total
         FROM expense_categories c
         LEFT JOIN expenses e ON e.category_id=c.id AND e.user_id=c.user_id AND e.type='expense'"
        . $clause('e.spent_at') .
        " WHERE c.user_id=?
         GROUP BY c.id HAVING total > 0 ORDER BY total DESC LIMIT 8"
    );
    $cats->execute(array_merge($bounds, [$uid]));

    ok([
        'period'      => $win['period'],
        'label'       => $win['label'],
        'from'        => $from,
        'to'          => $to,
        'days'        => $days,
        'currency'    => default_currency($uid),
        'granularity' => $granularity,
        'totals'      => [
            'spend'         => (float) $moneyRow['spend'],
            'income'        => (float) $moneyRow['income'],
            'tasks_done'    => (int) $tasks->fetchColumn(),
            'focus_minutes' => (int) $focusTotal->fetchColumn(),
            'notes'         => (int) $notes->fetchColumn(),
            'habit_rate'    => $habitOut ? round($rateTotal / count($habitOut), 4) : 0.0,
        ],
        'weekday'    => $weekdays,
        'habits'     => $habitOut,
        'focus'      => insights_fill($focusSeries->fetchAll(), 'minutes', $granularity, $from, $to),
        'velocity'   => insights_fill($velocity->fetchAll(), 'done', $granularity, $from, $to),
        'hours'      => $hourOut,
        'categories' => $cats->fetchAll(),
    ]);
});

/**
 * Zero-fill a bucketed series so a chart draws a timeline rather than a list of
 * days that happened to have data. Mirrors expense_series_fill() in stats.php;
 * fills to today, never past it.
 */
function insights_fill(array $rows, string $field, string $granularity, ?string $from, ?string $to): array
{
    $map = [];
    foreach ($rows as $row) {
        $map[(string) $row['d']] = (float) $row[$field];
    }
    $keys = array_keys($map);
    if ($from === null && !$keys) {
        return [];
    }

    $monthly = $granularity === 'month';
    $today   = $monthly ? date('Y-m') : date('Y-m-d');
    $start   = $from !== null ? ($monthly ? substr($from, 0, 7) : $from) : (string) min($keys);

    $end = $today;
    if ($keys && (string) max($keys) > $end) {
        $end = (string) max($keys);
    }
    if ($to !== null) {
        $cap = $monthly ? substr($to, 0, 7) : $to;
        if ($end > $cap) {
            $end = $cap;
        }
    }
    if ($end < $start) {
        $end = $start;
    }

    $out  = [];
    $step = $monthly ? '+1 month' : '+1 day';
    for (
        $ts = strtotime($monthly ? $start . '-01' : $start), $stop = strtotime($monthly ? $end . '-01' : $end);
        $ts <= $stop;
        $ts = strtotime($step, $ts)
    ) {
        $key   = $monthly ? date('Y-m', $ts) : date('Y-m-d', $ts);
        $out[] = ['d' => $key, 'value' => $map[$key] ?? 0.0];
    }
    return $out;
}
