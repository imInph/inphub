<?php
/**
 * inphub: common bootstrap for the PHP endpoints left in v4 (ai.php, import.php).
 *
 * Reads the user from the ASP.NET bridge headers (see lib/auth.php), wires the
 * shared libs, and requires an authenticated user. Wrap the endpoint body in
 * api_handle() so any thrown error becomes a clean JSON error.
 */

declare(strict_types=1);

require_once __DIR__ . '/../db/database.php';
require_once __DIR__ . '/../lib/helpers.php';
require_once __DIR__ . '/../lib/auth.php';
require_once __DIR__ . '/../lib/activity.php';

auth_boot();

/**
 * Run an endpoint callback, converting exceptions into the error envelope.
 * Guards login by default; pass requireAuth=false for the auth endpoint.
 */
function api_handle(callable $fn, bool $requireAuth = true): void
{
    if ($requireAuth) {
        require_login();
    }
    try {
        $fn();
    } catch (Throwable $e) {
        json_response(false, $e->getMessage(), 500);
    }
}

/** The HTTP method, uppercased. */
function method(): string
{
    return strtoupper($_SERVER['REQUEST_METHOD'] ?? 'GET');
}

/** Resolve the requested action from query or body. */
function action(array $input): string
{
    return (string) input_get($input, 'action', method() === 'GET' ? 'list' : '');
}

/** Tables that fetch_owned() is allowed to read (whitelist, no interpolation risk). */
const OWNED_TABLES = [
    'todos', 'expenses', 'expense_categories', 'repos', 'repo_suggestions',
    'habits', 'habit_logs', 'goals', 'notes', 'focus_sessions',
];

/**
 * Fetch a single row by id, scoped to the owner. Fails 404 if missing/foreign.
 */
function fetch_owned(string $table, int $id, int $uid): array
{
    if (!in_array($table, OWNED_TABLES, true)) {
        fail('Invalid table.', 500);
    }
    if ($id <= 0) {
        fail('Missing or invalid id.', 422);
    }
    $stmt = db()->prepare("SELECT * FROM `$table` WHERE id = ? AND user_id = ? LIMIT 1");
    $stmt->execute([$id, $uid]);
    $row = $stmt->fetch();
    if (!$row) {
        fail('Not found.', 404);
    }
    return $row;
}

/**
 * Return $value if it is one of $allowed, otherwise $default. Used to sanitise
 * ENUM columns coming from the client.
 */
function valid_enum($value, array $allowed, string $default): string
{
    $value = is_string($value) ? $value : (string) $value;
    return in_array($value, $allowed, true) ? $value : $default;
}
