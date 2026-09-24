<?php
/**
 * inphub: small shared helpers for the PHP that is left in v4 (AI + backup).
 *
 * Everything else moved to the ASP.NET server in server/; its counterparts of
 * the money, dashboard and appearance helpers live in server/Core/.
 */

declare(strict_types=1);

/** App version as the backup file records it; keep equal to AppInfo.Version in server/Core/AppInfo.cs. */
const INPHUB_VERSION = '4.0.0';

/**
 * Read a value from config/config.php (the gitignored, per-machine config).
 *
 * Returns $default when the key is absent, so an older config.php that predates
 * a newly added key keeps working untouched.
 */
function app_config(string $key, $default = null)
{
    static $cfg = null;
    if ($cfg === null) {
        $path = __DIR__ . '/../config/config.php';
        $cfg  = is_file($path) ? (array) require $path : [];
    }
    return $cfg[$key] ?? $default;
}

/**
 * Emit a JSON response using the app-wide envelope and stop.
 *
 * Success: { "ok": true,  "data": ... }
 * Failure: { "ok": false, "error": "..." }
 */
function json_response(bool $ok, $payload = null, int $status = 200): void
{
    http_response_code($status);
    header('Content-Type: application/json; charset=utf-8');
    if ($ok) {
        echo json_encode(['ok' => true, 'data' => $payload], JSON_UNESCAPED_UNICODE);
    } else {
        echo json_encode(['ok' => false, 'error' => (string) $payload], JSON_UNESCAPED_UNICODE);
    }
    exit;
}

/** Shorthand for a success response. */
function ok($data = null): void
{
    json_response(true, $data, 200);
}

/** Shorthand for an error response. */
function fail(string $message, int $status = 400): void
{
    json_response(false, $message, $status);
}

/**
 * Decode a JSON request body into an associative array.
 * Returns [] when the body is empty or not valid JSON.
 */
function read_json_body(): array
{
    $raw = file_get_contents('php://input');
    if ($raw === false || $raw === '') {
        return [];
    }
    $data = json_decode($raw, true);
    return is_array($data) ? $data : [];
}

/**
 * Merge query string + JSON body into one input bag.
 * JSON body wins on key collisions.
 */
function request_input(): array
{
    return array_merge($_GET, read_json_body());
}

/** Read a value from an input bag with a default. */
function input_get(array $bag, string $key, $default = null)
{
    return array_key_exists($key, $bag) ? $bag[$key] : $default;
}

/** Trimmed string field, or null when empty. */
function str_or_null($value): ?string
{
    if ($value === null) {
        return null;
    }
    $value = trim((string) $value);
    return $value === '' ? null : $value;
}

/** Today's date (server local) as YYYY-MM-DD. */
function today(): string
{
    return date('Y-m-d');
}

/**
 * All settings for a user as an associative key => value map.
 */
function all_settings(int $userId): array
{
    $stmt = db()->prepare('SELECT setting_key, setting_value FROM settings WHERE user_id = ?');
    $stmt->execute([$userId]);
    $out = [];
    foreach ($stmt->fetchAll() as $row) {
        $out[$row['setting_key']] = $row['setting_value'];
    }
    return $out;
}

/** Read a single setting value, or $default when unset. */
function get_setting(int $userId, string $key, $default = null)
{
    $stmt = db()->prepare('SELECT setting_value FROM settings WHERE user_id = ? AND setting_key = ?');
    $stmt->execute([$userId, $key]);
    $row = $stmt->fetch();
    return $row === false ? $default : $row['setting_value'];
}

/* ------------------------------------------------------------------ money */

/** The user's configured base currency (default TRY). */
function default_currency(int $userId): string
{
    return (string) (get_setting($userId, 'base_currency', 'TRY') ?: 'TRY');
}

/** Spelled-out names for the currencies most likely to be configured. */
const CURRENCY_NAMES = [
    'TRY' => 'Turkish lira',
    'USD' => 'US dollars',
    'EUR' => 'euro',
    'GBP' => 'pounds sterling',
    'CHF' => 'Swiss francs',
    'JPY' => 'Japanese yen',
    'CAD' => 'Canadian dollars',
    'AUD' => 'Australian dollars',
    'SEK' => 'Swedish krona',
    'RUB' => 'Russian rubles',
    'AZN' => 'Azerbaijani manat',
];

/** Human name for a currency code, falling back to the code itself. */
function currency_name(string $code): string
{
    $code = strtoupper(trim($code));
    return CURRENCY_NAMES[$code] ?? $code;
}

/**
 * Format an amount for a *machine* reader (the AI layer).
 *
 * Deliberately "2000.00 TRY": no thousands separator, so no locale can be
 * inferred from the punctuation, and the currency code is always attached.
 * The UI has its own Intl-based formatter in src/ui.ts, this is its backend
 * counterpart, and the reason the model used to read lira as dollars.
 */
function money_text($amount, string $currency): string
{
    return number_format((float) $amount, 2, '.', '') . ' ' . strtoupper(trim($currency));
}
