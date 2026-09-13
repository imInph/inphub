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

    // config.php is git-ignored, so a fresh clone or release zip does not have
    // it. Without this check PHP dies with a raw fatal whose stack trace can
    // include the password someone just typed into the login form.
    $configFile = __DIR__ . '/../config/config.php';
    if (!is_file($configFile)) {
        db_setup_error(
            'config/config.php is missing.',
            'Copy config/config.example.php to config/config.php. On a stock XAMPP the defaults work without editing it.'
        );
    }
    $cfg = require $configFile;

    $dsn = sprintf(
        'mysql:host=%s;dbname=%s;charset=%s',
        $cfg['db_host'],
        $cfg['db_name'],
        $cfg['db_charset']
    );

    try {
        $pdo = new PDO($dsn, $cfg['db_user'], $cfg['db_pass'], [
            PDO::ATTR_ERRMODE            => PDO::ERRMODE_EXCEPTION,
            PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
            PDO::ATTR_EMULATE_PREPARES   => false,
        ]);
    } catch (PDOException $e) {
        // Usually MySQL is not started in XAMPP, or inphub.sql was never imported.
        db_setup_error(
            'Could not connect to the database: ' . $e->getMessage(),
            'Check that MySQL is running in the XAMPP control panel, that inphub.sql has been imported, '
            . 'and that the credentials in config/config.php are right.'
        );
    }

    return $pdo;
}

/**
 * Stop with a readable setup error instead of a PHP stack trace. API requests
 * get the usual JSON error envelope, pages get a small HTML page. Deliberately
 * depends on nothing else in lib/, since it runs before the app is usable.
 */
function db_setup_error(string $problem, string $fix): never
{
    $isApi = basename(dirname((string) ($_SERVER['SCRIPT_FILENAME'] ?? ''))) === 'api';

    if (PHP_SAPI === 'cli') {
        fwrite(STDERR, "inphub: {$problem}\n{$fix}\n");
        exit(1);
    }
    if (!headers_sent()) {
        http_response_code(503);
    }
    if ($isApi) {
        if (!headers_sent()) {
            header('Content-Type: application/json; charset=utf-8');
        }
        echo json_encode(['ok' => false, 'error' => $problem . ' ' . $fix], JSON_UNESCAPED_UNICODE);
        exit;
    }

    $p = htmlspecialchars($problem, ENT_QUOTES, 'UTF-8');
    $f = htmlspecialchars($fix, ENT_QUOTES, 'UTF-8');
    echo <<<HTML
<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>inphub setup problem</title>
<style>
  body { font: 16px/1.5 system-ui, sans-serif; margin: 0; padding: 48px 20px; background: #f4f4f5; color: #18181b; }
  main { max-width: 560px; margin: 0 auto; background: #fff; border: 1px solid #e4e4e7; border-radius: 12px; padding: 24px 28px; }
  h1 { font-size: 1.15rem; margin: 0 0 12px; }
  p { margin: 0 0 10px; }
  .problem { color: #b91c1c; overflow-wrap: anywhere; }
</style></head>
<body><main>
  <h1>inphub isn't set up yet</h1>
  <p class="problem">{$p}</p>
  <p>{$f}</p>
</main></body>
</html>
HTML;
    exit;
}
