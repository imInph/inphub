<?php
/**
 * inphub — dashboard aggregates + expense chart data.
 *
 *   GET ?action=dashboard
 *   GET ?action=expenses[&month=YYYY-MM]     donut (by category) + line (over time) + budgets
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
            ok(expense_charts($uid, str_or_null(input_get($input, 'month')) ?? date('Y-m')));
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
         LEFT JOIN expenses e ON e.category_id=c.id AND e.type='expense' AND DATE_FORMAT(e.spent_at,'%Y-%m')=?
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

    return [
        'owner_name'  => (string) (get_setting($uid, 'owner_name', '') ?: (current_user()['display_name'] ?? '')),
        'currency'    => (string) (get_setting($uid, 'base_currency', 'TRY') ?: 'TRY'),
        'ai_enabled'  => (get_setting($uid, 'ai_enabled', '0') === '1'),
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
        'activity'    => $activity->fetchAll(),
    ];
}

function expense_charts(int $uid, string $month): array
{
    $pdo = db();

    // Donut: totals by category for the month (expenses only).
    $byCat = $pdo->prepare(
        "SELECT c.name, c.color, COALESCE(SUM(e.amount),0) AS total
         FROM expense_categories c
         LEFT JOIN expenses e ON e.category_id=c.id AND e.type='expense' AND DATE_FORMAT(e.spent_at,'%Y-%m')=?
         WHERE c.user_id=?
         GROUP BY c.id HAVING total > 0 ORDER BY total DESC"
    );
    $byCat->execute([$month, $uid]);

    // Uncategorised expenses.
    $uncat = $pdo->prepare(
        "SELECT COALESCE(SUM(amount),0) FROM expenses WHERE user_id=? AND type='expense' AND category_id IS NULL AND DATE_FORMAT(spent_at,'%Y-%m')=?"
    );
    $uncat->execute([$uid, $month]);

    // Line: daily expense totals across the month.
    $daily = $pdo->prepare(
        "SELECT spent_at AS d, COALESCE(SUM(amount),0) AS total
         FROM expenses WHERE user_id=? AND type='expense' AND DATE_FORMAT(spent_at,'%Y-%m')=?
         GROUP BY spent_at ORDER BY spent_at ASC"
    );
    $daily->execute([$uid, $month]);

    // Budgets vs spend per category.
    $budgets = $pdo->prepare(
        "SELECT c.name, c.color, c.monthly_budget,
                COALESCE(SUM(CASE WHEN e.type='expense' THEN e.amount END),0) AS spent
         FROM expense_categories c
         LEFT JOIN expenses e ON e.category_id=c.id AND DATE_FORMAT(e.spent_at,'%Y-%m')=?
         WHERE c.user_id=? AND c.monthly_budget IS NOT NULL
         GROUP BY c.id ORDER BY c.name ASC"
    );
    $budgets->execute([$month, $uid]);

    $categories = $byCat->fetchAll();
    $uncatTotal = (float) $uncat->fetchColumn();
    if ($uncatTotal > 0) {
        $categories[] = ['name' => 'Uncategorised', 'color' => '#6b7280', 'total' => $uncatTotal];
    }

    return [
        'month'      => $month,
        'by_category' => $categories,
        'over_time'   => $daily->fetchAll(),
        'budgets'     => $budgets->fetchAll(),
    ];
}
