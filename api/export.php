<?php
/**
 * inphub: data export (browser-navigated download, not JSON-enveloped).
 *
 *   GET ?action=backup        everything the user owns, in the shared backup
 *                             format that inphub lite also reads and writes
 *                             (see BACKUP-FORMAT.md). ?action=json is the same
 *                             thing under its old name, so existing links keep
 *                             working.
 *
 * v4: only the backup lives here. The CSV and Markdown exports moved to the
 * ASP.NET server (server/Endpoints/Export.cs), which forwards backup and json
 * to this file through its bridge.
 */

declare(strict_types=1);

require_once __DIR__ . '/../db/database.php';
require_once __DIR__ . '/../lib/helpers.php';
require_once __DIR__ . '/../lib/auth.php';
require_once __DIR__ . '/../lib/backup.php';

auth_boot();
require_login_page();

$uid = current_user_id();

// The shared backup format.
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
