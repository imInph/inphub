<?php
/**
 * inphub — data export (browser-navigated download, not JSON-enveloped).
 *
 *   GET ?action=json          everything the user owns, as one JSON file
 *   GET ?action=expenses_csv  the expenses ledger as CSV
 *   GET ?action=todos_txt     the to-do list as a numbered plain-text file
 *
 * Unlike the /api/* JSON endpoints this streams a file with a download header,
 * so it uses the page-style auth guard (redirect to login) rather than 401.
 */

declare(strict_types=1);

require_once __DIR__ . '/../db/database.php';
require_once __DIR__ . '/../lib/helpers.php';
require_once __DIR__ . '/../lib/auth.php';

auth_boot();
require_login_page();

$uid    = current_user_id();
$action = $_GET['action'] ?? 'json';
$stamp  = date('Y-m-d');

if ($action === 'expenses_csv') {
    $stmt = db()->prepare(
        'SELECT e.spent_at, e.type, e.amount, e.currency, c.name AS category,
                e.description, e.payment_method, e.is_recurring
         FROM expenses e LEFT JOIN expense_categories c ON c.id = e.category_id
         WHERE e.user_id = ? ORDER BY e.spent_at DESC, e.id DESC'
    );
    $stmt->execute([$uid]);

    header('Content-Type: text/csv; charset=utf-8');
    header('Content-Disposition: attachment; filename="inphub-expenses-' . $stamp . '.csv"');
    $out = fopen('php://output', 'w');
    fputcsv($out, ['date', 'type', 'amount', 'currency', 'category', 'description', 'payment_method', 'is_recurring']);
    foreach ($stmt->fetchAll() as $row) {
        fputcsv($out, $row);
    }
    fclose($out);
    exit;
}

if (in_array($action, ['todos_txt', 'todos_md', 'todos_csv'], true)) {
    // Optional status filter; 'open' means the not-done/not-archived tasks.
    $rows = todos_for_export($uid, $_GET['status'] ?? 'open');

    if ($action === 'todos_csv') {
        header('Content-Type: text/csv; charset=utf-8');
        header('Content-Disposition: attachment; filename="inphub-todos-' . $stamp . '.csv"');
        $out = fopen('php://output', 'w');
        fputcsv($out, ['number', 'title', 'status', 'completed_at']);
        $n = 0;
        foreach ($rows as $row) {
            fputcsv($out, [++$n, $row['title'], $row['status'], $row['completed_at'] ?? '']);
        }
        fclose($out);
        exit;
    }

    if ($action === 'todos_md') {
        $lines = ['# To-Do — ' . $stamp, ''];
        $n = 0;
        foreach ($rows as $row) {
            $box  = $row['status'] === 'done' ? '[x]' : '[ ]';
            $done = !empty($row['completed_at']) ? ' _(completed ' . substr((string) $row['completed_at'], 0, 10) . ')_' : '';
            $lines[] = (++$n) . '. ' . $box . ' ' . $row['title'] . ' — ' . $row['status'] . $done;
        }
        header('Content-Type: text/markdown; charset=utf-8');
        header('Content-Disposition: attachment; filename="inphub-todos-' . $stamp . '.md"');
        echo implode("\r\n", $lines) . "\r\n";
        exit;
    }

    // Default: plain-text numbered list (titles only).
    $lines = [];
    $n = 0;
    foreach ($rows as $row) {
        $lines[] = (++$n) . '. ' . $row['title'];
    }
    header('Content-Type: text/plain; charset=utf-8');
    header('Content-Disposition: attachment; filename="inphub-todos-' . $stamp . '.txt"');
    echo implode("\r\n", $lines) . ($lines ? "\r\n" : '');
    exit;
}

// Default: full JSON export.
$tables = [
    'todos', 'expense_categories', 'expenses', 'repos', 'repo_suggestions',
    'habits', 'habit_logs', 'goals', 'notes', 'focus_sessions', 'activity_log',
    'daily_briefs', 'chat_messages', 'settings',
];
$data = ['exported_at' => date('c'), 'user_id' => $uid];
foreach ($tables as $table) {
    // $table comes only from the whitelist above — never from user input.
    $stmt = db()->prepare("SELECT * FROM `$table` WHERE user_id = ?");
    $stmt->execute([$uid]);
    $data[$table] = $stmt->fetchAll();
}

header('Content-Type: application/json; charset=utf-8');
header('Content-Disposition: attachment; filename="inphub-export-' . $stamp . '.json"');
echo json_encode($data, JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
exit;

/**
 * The user's todos for export, filtered by status ('open' = todo+in_progress,
 * a specific status, or anything else = all), ordered like the app's list.
 *
 * @return array<int,array{title:string,status:string,completed_at:?string}>
 */
function todos_for_export(int $uid, string $filter): array
{
    $order = "ORDER BY (due_date IS NULL), due_date ASC, FIELD(priority,'urgent','high','medium','low'), id ASC";
    if ($filter === 'open') {
        $stmt = db()->prepare("SELECT title, status, completed_at FROM todos
            WHERE user_id = ? AND status IN ('todo','in_progress') $order");
        $stmt->execute([$uid]);
    } elseif (in_array($filter, ['todo', 'in_progress', 'done', 'archived'], true)) {
        $stmt = db()->prepare("SELECT title, status, completed_at FROM todos
            WHERE user_id = ? AND status = ? $order");
        $stmt->execute([$uid, $filter]);
    } else {
        $stmt = db()->prepare('SELECT title, status, completed_at FROM todos WHERE user_id = ? ORDER BY id ASC');
        $stmt->execute([$uid]);
    }
    return $stmt->fetchAll();
}
