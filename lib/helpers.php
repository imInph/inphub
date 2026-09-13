<?php
/**
 * inphub: small shared helpers used by every API endpoint.
 */

declare(strict_types=1);

/** App version, bump on release. Shown in the sidebar, login page, and export dumps. */
const INPHUB_VERSION = '2.1.0';

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

/** Nullable positive int (e.g. an optional foreign key). */
function int_or_null($value): ?int
{
    if ($value === null || $value === '' ) {
        return null;
    }
    return (int) $value;
}

/** Nullable decimal, or null when empty. */
function num_or_null($value): ?float
{
    if ($value === null || $value === '') {
        return null;
    }
    return (float) $value;
}

/**
 * Mask a stored secret for display. Returns a non-reversible placeholder
 * so the UI can show "something is set" without leaking the value.
 * Empty stays empty so the UI knows the field is unset.
 */
function mask_secret(?string $value): string
{
    $value = (string) $value;
    if ($value === '') {
        return '';
    }
    return '••••••••';
}

/**
 * The sentinel the frontend sends back for a masked secret field it did not
 * change. When we see it on save, we keep the existing stored value.
 */
const SECRET_UNCHANGED = '••••••••';

/** Clamp an int into a range. */
function clamp_int(int $value, int $min, int $max): int
{
    return max($min, min($max, $value));
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

/** Upsert a single setting value for a user. */
function set_setting(int $userId, string $key, ?string $value): void
{
    $stmt = db()->prepare(
        'INSERT INTO settings (user_id, setting_key, setting_value) VALUES (?, ?, ?)
         ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value)'
    );
    $stmt->execute([$userId, $key, $value]);
}

/* ------------------------------------------------------------------ money */

/** The user's configured base currency (default TRY). */
function default_currency(int $userId): string
{
    return (string) (get_setting($userId, 'base_currency', 'TRY') ?: 'TRY');
}

/** The user's opening balance, added to the all-time net. May be negative. */
function starting_balance(int $userId): float
{
    return (float) get_setting($userId, 'starting_balance', '0');
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

/** Period keys the Money view can ask for. */
const MONEY_PERIODS = ['month', 'last_month', '3m', '6m', 'year', 'all'];

/**
 * Resolve a period key into an inclusive calendar window:
 * ['from' => 'YYYY-MM-DD'|null, 'to' => 'YYYY-MM-DD'|null, 'label' => string].
 * 'all' returns null bounds, callers must then omit the range predicate.
 *
 * Windows are whole calendar months (spent_at is a DATE, so inclusive bounds
 * are exact). Computed here in PHP and passed as bound params, so a request
 * never mixes PHP's clock with MySQL's CURRENT_DATE.
 *
 * Gotcha: only the relative-text forms ("first day of last month") are safe.
 * date('Y-m-01', strtotime('-1 month')) overflows on the 29th-31st, on
 * 2026-03-31 it yields 2026-03-01 instead of 2026-02-01.
 */
function money_period_range(string $period, ?int $now = null): array
{
    $now     = $now ?? time();
    $endThis = date('Y-m-d', strtotime('last day of this month', $now));

    switch ($period) {
        case 'last_month':
            return [
                'from'  => date('Y-m-d', strtotime('first day of last month', $now)),
                'to'    => date('Y-m-d', strtotime('last day of last month', $now)),
                'label' => 'Last month',
            ];
        case '3m':
            return [
                'from'  => date('Y-m-d', strtotime('first day of -2 month', $now)),
                'to'    => $endThis,
                'label' => 'Last 3 months',
            ];
        case '6m':
            return [
                'from'  => date('Y-m-d', strtotime('first day of -5 month', $now)),
                'to'    => $endThis,
                'label' => 'Last 6 months',
            ];
        case 'year':
            return ['from' => date('Y-01-01', $now), 'to' => date('Y-12-31', $now), 'label' => 'This year'];
        case 'all':
            return ['from' => null, 'to' => null, 'label' => 'All time'];
        case 'month':
        default:
            return ['from' => date('Y-m-01', $now), 'to' => $endThis, 'label' => 'This month'];
    }
}

/**
 * Resolve a legacy month=YYYY-MM param into the same window shape.
 * Returns null when the string is not a well-formed month.
 */
function money_month_range(string $month): ?array
{
    if (!preg_match('/^\d{4}-(0[1-9]|1[0-2])$/', $month)) {
        return null;
    }
    $ts = strtotime($month . '-01');
    if ($ts === false) {
        return null;
    }
    return [
        'from'  => date('Y-m-01', $ts),
        'to'    => date('Y-m-d', strtotime('last day of this month', $ts)),
        'label' => date('F Y', $ts),
    ];
}

/**
 * Resolve the money window an API request is asking for.
 *
 * `period` (one of MONEY_PERIODS) wins; the legacy `month=YYYY-MM` param is
 * honoured when no period is given, so the documented contract keeps working.
 * Anything unrecognised falls back to $default. Returns the money_period_range()
 * shape plus the resolved 'period' key.
 *
 * Kept self-contained (no valid_enum) so lib/ stays independent of api/.
 */
function money_window(array $input, string $default = 'month'): array
{
    $period = str_or_null(input_get($input, 'period'));
    if ($period !== null) {
        $key = in_array($period, MONEY_PERIODS, true) ? $period : $default;
        return array_merge(['period' => $key], money_period_range($key));
    }

    $month = str_or_null(input_get($input, 'month'));
    if ($month !== null) {
        $range = money_month_range($month);
        if ($range !== null) {
            return array_merge(['period' => $default], $range);
        }
    }

    return array_merge(['period' => $default], money_period_range($default));
}
