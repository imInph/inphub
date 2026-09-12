<?php
/**
 * inphub: PDO singleton.
 *
 * Usage:  $pdo = db();
 * Every query in the app goes through this connection and uses
 * prepared statements (see lib/*). Exceptions are enabled so failures
 * bubble up to the per-endpoint try/catch that returns a JSON error.
 */

declare(strict_types=1);

function db(): PDO
{
    static $pdo = null;
    if ($pdo instanceof PDO) {
        return $pdo;
    }

    $cfg = require __DIR__ . '/../config/config.php';

    $dsn = sprintf(
        'mysql:host=%s;dbname=%s;charset=%s',
        $cfg['db_host'],
        $cfg['db_name'],
        $cfg['db_charset']
    );

    $pdo = new PDO($dsn, $cfg['db_user'], $cfg['db_pass'], [
        PDO::ATTR_ERRMODE            => PDO::ERRMODE_EXCEPTION,
        PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
        PDO::ATTR_EMULATE_PREPARES   => false,
    ]);

    return $pdo;
}
