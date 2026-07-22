<?php
/**
 * inphub — small shared helpers used by every API endpoint.
 */

declare(strict_types=1);

/** App version — bump on release. Shown in the sidebar, login page, and export dumps. */
const INPHUB_VERSION = '1.0.1';

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
