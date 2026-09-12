<?php
/**
 * inphub: dashboard aggregates + expense chart data.
 *
 *   GET ?action=dashboard
 *   GET ?action=expenses[&period=month|last_month|3m|6m|year|all]
 *       totals + donut (by category) + line (over time) + budgets
 *       (legacy &month=YYYY-MM still works; ?period= wins when both are sent)
 */

require_once __DIR__ . '/_bootstrap.php';

api_handle(function (): void {
    $uid   = current_user_id();
    $input = request_input();

    switch (action($input)) {
        case 'dashboard':
            ok(dashboard_payload($uid));
            break;

        case 'expenses':
            ok(expense_charts($uid, money_window($input)));
            break;

        default:
            fail('Unknown action.', 404);
    }
});

function dashboard_payload(int $uid): array
{
    $pdo   = db();
    $month = date('Y-m');

    // Today / overdue todos (not done/archived).
    $todos = $pdo->prepare(
        "SELECT * FROM todos
         WHERE user_id=? AND status IN ('todo','in_progress')
           AND (due_date IS NULL OR due_date <= CURRENT_DATE)
         ORDER BY (due_date IS NULL), due_date ASC, FIELD(priority,'urgent','high','medium','low') LIMIT 12"
    );
    $todos->execute([$uid]);

    // Habits + whether logged today.
    $habits = $pdo->prepare(
        "SELECT h.*, (SELECT COUNT(*) FROM habit_logs hl WHERE hl.habit_id=h.id AND hl.logged_date=CURRENT_DATE) AS logged_today
         FROM habits h WHERE h.user_id=? AND h.is_active=1 ORDER BY h.sort_order ASC"
    );
    $habits->execute([$uid]);

    // Money this month.
    $money = $pdo->prepare(
        "SELECT
            COALESCE(SUM(CASE WHEN type='expense' THEN amount END),0) AS spent,
            COALESCE(SUM(CASE WHEN type='income'  THEN amount END),0) AS income
         FROM expenses WHERE user_id=? AND DATE_FORMAT(spent_at,'%Y-%m')=?"
    );
    $money->execute([$uid, $month]);
    $moneyRow = $money->fetch();

    $topCats = $pdo->prepare(
        "SELECT c.name, c.color, c.icon, c.monthly_budget, COALESCE(SUM(e.amount),0) AS total
         FROM expense_categories c
         LEFT JOIN expenses e ON e.category_id=c.id AND e.user_id=c.user_id AND e.type='expense' AND DATE_FORMAT(e.spent_at,'%Y-%m')=?
         WHERE c.user_id=?
         GROUP BY c.id HAVING total > 0 ORDER BY total DESC LIMIT 5"
    );
    $topCats->execute([$month, $uid]);

    // Repo health: stale count + most neglected.
    $staleDays = (int) (get_setting($uid, 'stale_repo_days', '60') ?: 60);
    $staleCount = $pdo->prepare('SELECT COUNT(*) FROM repos WHERE user_id=? AND staleness_days >= ?');
    $staleCount->execute([$uid, $staleDays]);
    $neglected = $pdo->prepare('SELECT name, full_name, staleness_days, health_score FROM repos WHERE user_id=? ORDER BY (staleness_days IS NULL), staleness_days DESC LIMIT 1');
    $neglected->execute([$uid]);

    // Active goals.
    $goals = $pdo->prepare("SELECT * FROM goals WHERE user_id=? AND status='active' ORDER BY (target_date IS NULL), target_date ASC LIMIT 6");
    $goals->execute([$uid]);

    // Recent activity.
    $activity = $pdo->prepare('SELECT * FROM activity_log WHERE user_id=? ORDER BY created_at DESC, id DESC LIMIT 8');
    $activity->execute([$uid]);

    $shortcuts = json_decode((string) get_setting($uid, 'dashboard_shortcuts', '[]'), true);
    if (!is_array($shortcuts)) {
        $shortcuts = [];
    }

    // Focus was the only feature with no dashboard presence at all.
    $focus = $pdo->prepare(
        "SELECT
            COALESCE(SUM(CASE WHEN DATE(started_at)=CURRENT_DATE THEN duration_minutes END),0) AS today,
            COALESCE(SUM(CASE WHEN started_at >= (CURRENT_DATE - INTERVAL 6 DAY) THEN duration_minutes END),0) AS week
         FROM focus_sessions WHERE user_id=?"
    );
    $focus->execute([$uid]);
    $focusRow = $focus->fetch();

    $lastFocus = $pdo->prepare(
        'SELECT f.label, f.duration_minutes, f.started_at, t.title AS todo_title
         FROM focus_sessions f
         LEFT JOIN todos t ON t.id = f.linked_todo_id AND t.user_id = f.user_id
         WHERE f.user_id=? ORDER BY f.started_at DESC LIMIT 1'
    );
    $lastFocus->execute([$uid]);

    return [
        'owner_name'  => (string) (get_setting($uid, 'owner_name', '') ?: (current_user()['display_name'] ?? '')),
        'currency'    => default_currency($uid),
        'ai_enabled'  => (get_setting($uid, 'ai_enabled', '0') === '1'),
        'shortcuts'   => array_values($shortcuts),
        'todos'       => $todos->fetchAll(),
        'habits'      => $habits->fetchAll(),
        'money'       => [
            'spent'         => (float) $moneyRow['spent'],
            'income'        => (float) $moneyRow['income'],
            'top_categories' => $topCats->fetchAll(),
            'month'         => $month,
        ],
        'repos'       => [
            'stale_count'    => (int) $staleCount->fetchColumn(),
            'most_neglected' => $neglected->fetch() ?: null,
        ],
        'goals'       => $goals->fetchAll(),
        'focus'       => [
            'today_minutes' => (int) $focusRow['today'],
            'week_minutes'  => (int) $focusRow['week'],
            'last'          => $lastFocus->fetch() ?: null,
        ],
        'activity'    => $activity->fetchAll(),
    ];
}

/**
 * Chart + summary data for the Money view, scoped to one window.
 *
 * $win comes from money_window(), ['period','from','to','label'], with null
 * bounds for 'all'. Everything except `budgets` and `all_time` follows it:
 * budgets are inherently monthly and the net is inherently all-time, so both
 * ignore the selector by design.
 */
function expense_charts(int $uid, array $win): array
{
    $pdo    = db();
    $from   = $win['from'];
    $to     = $win['to'];
    $ranged = $from !== null;

    // Shared window predicate. Column names are literals from this file, never
    // user input; the bounds are always bound params. 'all' drops the clause.
    $clause = static function (string $column) use ($ranged): string {
        return $ranged ? " AND $column >= ? AND $column <= ?" : '';
    };
    $bounds = $ranged ? [$from, $to] : [];

    // Donut: totals by category (expenses only).
    $byCat = $pdo->prepare(
        "SELECT c.name, c.color, COALESCE(SUM(e.amount),0) AS total
         FROM expense_categories c
         LEFT JOIN expenses e ON e.category_id=c.id AND e.user_id=c.user_id AND e.type='expense'"
        . $clause('e.spent_at') .
        " WHERE c.user_id=?
         GROUP BY c.id HAVING total > 0 ORDER BY total DESC"
    );
    $byCat->execute(array_merge($bounds, [$uid]));

    // Uncategorised expenses.
    $uncat = $pdo->prepare(
        "SELECT COALESCE(SUM(amount),0) FROM expenses
         WHERE user_id=? AND type='expense' AND category_id IS NULL" . $clause('spent_at')
    );
    $uncat->execute(array_merge([$uid], $bounds));

    // Income/expense totals for the selected window.
    $totals = $pdo->prepare(
        "SELECT COALESCE(SUM(CASE WHEN type='expense' THEN amount END),0) AS expense,
                COALESCE(SUM(CASE WHEN type='income'  THEN amount END),0) AS income
         FROM expenses WHERE user_id=?" . $clause('spent_at')
    );
    $totals->execute(array_merge([$uid], $bounds));
    $totalRow = $totals->fetch();

    // All-time totals, never windowed. This is what "current net" is built on:
    // the money in your pocket does not reset when a month does.
    $lifetime = $pdo->prepare(
        "SELECT COALESCE(SUM(CASE WHEN type='expense' THEN amount END),0) AS expense,
                COALESCE(SUM(CASE WHEN type='income'  THEN amount END),0) AS income
         FROM expenses WHERE user_id=?"
    );
    $lifetime->execute([$uid]);
    $lifeRow = $lifetime->fetch();
    $opening = starting_balance($uid);

    // Line: daily buckets for short windows, monthly once a day-per-point
    // would be unreadable. 'all' is always monthly.
    $spanDays    = $ranged ? (int) floor((strtotime($to) - strtotime($from)) / 86400) + 1 : PHP_INT_MAX;
    $granularity = $spanDays <= 62 ? 'day' : 'month';

    $select = $granularity === 'day' ? 'spent_at' : "DATE_FORMAT(spent_at,'%Y-%m')";
    $series = $pdo->prepare(
        "SELECT $select AS d, COALESCE(SUM(amount),0) AS total
         FROM expenses WHERE user_id=? AND type='expense'" . $clause('spent_at') .
        " GROUP BY d ORDER BY d ASC"
    );
    $series->execute(array_merge([$uid], $bounds));

    $map = [];
    foreach ($series->fetchAll() as $row) {
        $map[(string) $row['d']] = (float) $row['total'];
    }

    // Budgets always describe the current calendar month, whatever the
    // selector says, so the card can be trusted at a glance.
    $budgetMonth = date('Y-m');
    $budgets = $pdo->prepare(
        "SELECT c.name, c.color, c.monthly_budget,
                COALESCE(SUM(CASE WHEN e.type='expense' THEN e.amount END),0) AS spent
         FROM expense_categories c
         LEFT JOIN expenses e ON e.category_id=c.id AND e.user_id=c.user_id
                             AND e.spent_at >= ? AND e.spent_at <= ?
         WHERE c.user_id=? AND c.monthly_budget IS NOT NULL
         GROUP BY c.id ORDER BY c.name ASC"
    );
    $budgets->execute([
        date('Y-m-01'),
        date('Y-m-d', strtotime('last day of this month')),
        $uid,
    ]);

    $categories = $byCat->fetchAll();
    $uncatTotal = (float) $uncat->fetchColumn();
    if ($uncatTotal > 0) {
        $categories[] = ['name' => 'Uncategorised', 'color' => '#6b7280', 'total' => $uncatTotal];
    }

    $expense = (float) $totalRow['expense'];
    $income  = (float) $totalRow['income'];
    $lifeExp = (float) $lifeRow['expense'];
    $lifeInc = (float) $lifeRow['income'];

    return [
        'period'      => $win['period'],
        'label'       => $win['label'],
        'from'        => $from,
        'to'          => $to,
        'currency'    => default_currency($uid),
        'granularity' => $granularity,
        'budget_month' => $budgetMonth,
        'totals'      => [
            'expense' => $expense,
            'income'  => $income,
            'net'     => $income - $expense,
        ],
        'all_time'    => [
            'expense'          => $lifeExp,
            'income'           => $lifeInc,
            'starting_balance' => $opening,
            'current_net'      => $opening + $lifeInc - $lifeExp,
        ],
        'by_category' => $categories,
        'over_time'   => expense_series_fill($map, $granularity, $from, $to),
        'budgets'     => $budgets->fetchAll(),
    ];
}

/**
 * Zero-fill a spending series so the chart draws a timeline rather than a list
 * of days that happened to have spending.
 *
 * Fills to whichever is later, today or the newest entry, capped at the window
 * end, spent_at accepts future dates (post-dated rent), and a fill that
 * stopped at today would draw a line that disagrees with the totals above it.
 */
function expense_series_fill(array $map, string $granularity, ?string $from, ?string $to): array
{
    $keys = array_keys($map);
    if ($from === null && !$keys) {
        return [];
    }

    $monthly = $granularity === 'month';
    $today   = $monthly ? date('Y-m') : date('Y-m-d');

    $start = $from !== null
        ? ($monthly ? substr($from, 0, 7) : $from)
        : (string) min($keys);

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
    $cur  = $monthly ? $start . '-01' : $start;
    $last = $monthly ? $end . '-01' : $end;

    for ($ts = strtotime($cur), $stop = strtotime($last); $ts <= $stop; $ts = strtotime($step, $ts)) {
        $key   = $monthly ? date('Y-m', $ts) : date('Y-m-d', $ts);
        $out[] = ['d' => $key, 'total' => $map[$key] ?? 0.0];
    }
    return $out;
}
