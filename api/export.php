<?php
/**
 * inphub: data export (browser-navigated download, not JSON-enveloped).
 *
 *   GET ?action=backup        everything the user owns, in the shared backup
 *                             format that inphub lite also reads and writes
 *                             (see BACKUP-FORMAT.md). ?action=json is the same
 *                             thing under its old name, so existing links keep
 *                             working.
 *   GET ?action=expenses_csv  the expenses ledger as CSV
 *   GET ?action=todos_md      the to-do list as Markdown
 *   GET ?action=todos_csv     the to-do list as CSV
 *   GET ?action=todos_json    the to-do list as JSON
 *
 * Unlike the /api/* JSON endpoints this streams a file with a download header,
 * so it uses the page-style auth guard (redirect to login) rather than 401.
 */

declare(strict_types=1);

require_once __DIR__ . '/../db/database.php';
require_once __DIR__ . '/../lib/helpers.php';
require_once __DIR__ . '/../lib/auth.php';
require_once __DIR__ . '/../lib/backup.php';

auth_boot();
require_login_page();

$uid    = current_user_id();
$action = $_GET['action'] ?? 'backup';
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

if (str_starts_with($action, 'todos_')) {
    $stmt = db()->prepare(
        'SELECT title, description, status, priority, project, tags, due_date,
                recurring, created_at, completed_at
         FROM todos WHERE user_id = ?
         ORDER BY (status="done"), sort_order ASC, (due_date IS NULL), due_date ASC, id DESC'
    );
    $stmt->execute([$uid]);
    $todos = $stmt->fetchAll();

    if ($action === 'todos_csv') {
        header('Content-Type: text/csv; charset=utf-8');
        header('Content-Disposition: attachment; filename="inphub-todos-' . $stamp . '.csv"');
        $out = fopen('php://output', 'w');
        fputcsv($out, ['title', 'description', 'status', 'priority', 'project', 'tags', 'due_date', 'recurring', 'created_at', 'completed_at']);
        foreach ($todos as $row) {
            fputcsv($out, $row);
        }
        fclose($out);
        exit;
    }

    if ($action === 'todos_json') {
        header('Content-Type: application/json; charset=utf-8');
        header('Content-Disposition: attachment; filename="inphub-todos-' . $stamp . '.json"');
        echo json_encode(['exported_at' => date('c'), 'todos' => $todos], JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
        exit;
    }

    // Default: Markdown checklist grouped by status.
    $groups = ['todo' => [], 'in_progress' => [], 'done' => [], 'archived' => []];
    foreach ($todos as $t) {
        $groups[$t['status']][] = $t;
    }
    $labels = ['todo' => 'To do', 'in_progress' => 'In progress', 'done' => 'Done', 'archived' => 'Archived'];

    $md = "# inphub — To-Do list ($stamp)\n";
    foreach ($groups as $status => $items) {
        if (!$items) {
            continue;
        }
        $md .= "\n## {$labels[$status]}\n\n";
        foreach ($items as $t) {
            $box  = $status === 'done' || $status === 'archived' ? 'x' : ' ';
            $meta = [];
            if ($t['priority'] !== 'medium') $meta[] = $t['priority'];
            if ($t['project'] !== null && $t['project'] !== '') $meta[] = $t['project'];
            if ($t['due_date'] !== null) $meta[] = 'due ' . $t['due_date'];
            if ($t['completed_at'] !== null) $meta[] = 'completed ' . substr($t['completed_at'], 0, 10);
            $md .= "- [$box] " . $t['title'] . ($meta ? ' _(' . implode(' · ', $meta) . ')_' : '') . "\n";
        }
    }

    header('Content-Type: text/markdown; charset=utf-8');
    header('Content-Disposition: attachment; filename="inphub-todos-' . $stamp . '.md"');
    echo $md;
    exit;
}

// Default: the shared backup format.
//
// This replaced a raw table dump that wrote user_id, MySQL's space-separated
// datetimes and PDO's stringified numbers straight into the file. None of that
// could be read by anything but the same database, which is exactly what made
// moving to inphub lite impossible. The shapes now come from lib/backup.php and
// are the ones BACKUP-FORMAT.md describes.
header('Content-Type: text/plain; charset=utf-8');
header('Content-Disposition: attachment; filename="' . backup_filename() . '"');
echo json_encode(backup_build($uid), JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
exit;
