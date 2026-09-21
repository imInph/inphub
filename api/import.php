<?php
/**
 * inphub: restore a backup, or pull one in from inphub lite.
 *
 *   POST ?action=inspect   parse + validate, report counts and warnings, write nothing
 *   POST ?action=apply     do it, in one transaction
 *
 * Both take {"file": "<the file's text>"} and the apply also takes
 * {"mode": "replace"|"merge"}.
 *
 * Nothing here touches the database until every row has been validated in
 * memory, and the write is one transaction, so a failure leaves the account
 * exactly as it was. See BACKUP-FORMAT.md for the file itself.
 */

declare(strict_types=1);

require_once __DIR__ . '/_bootstrap.php';
require_once __DIR__ . '/../lib/backup.php';
require_once __DIR__ . '/../lib/activity.php';

// The parsing, validating and shape-conversion all live in lib/backup.php so
// they can be exercised without a web server or a database. This file is only
// the part that writes.

api_handle(function (): void {
    $uid   = current_user_id();
    $input = request_input();
    $text  = (string) input_get($input, 'file', '');

    if (trim($text) === '') {
        fail('No file was given.', 422);
    }
    try {
    $parsed = backup_parse($text);

    } catch (BackupError $e) {
        fail($e->getMessage(), $e->status);
    }

    if (action($input) === 'inspect') {
        ok([
            'counts'   => $parsed['counts'],
            'warnings' => $parsed['warnings'],
            'meta'     => $parsed['meta'],
        ]);
        return;
    }

    $mode = input_get($input, 'mode') === 'merge' ? 'merge' : 'replace';

    try {
        $written = backup_apply(db(), $uid, $parsed, $mode);
    } catch (Throwable $e) {
        fail('Import failed, nothing was changed. ' . $e->getMessage(), 500);
    }

    log_activity($uid, 'data.imported', 'data', null,
        'Imported a backup (' . $mode . ')', 'system', ['counts' => $written]);

    ok(['mode' => $mode, 'written' => $written, 'warnings' => $parsed['warnings']]);
}, true);
