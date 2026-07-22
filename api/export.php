<?php
/**
 * inphub — data export (browser-navigated download, not JSON-enveloped).
 *
 *   GET ?action=json          everything the user owns, as one JSON file
 *   GET ?action=expenses_csv  the expenses ledger as CSV
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
