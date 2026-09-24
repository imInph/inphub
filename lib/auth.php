<?php
/**
 * inphub: who is asking, for the PHP that is still left in v4.
 *
 * Since v4 the ASP.NET server (server/) owns logins, sessions and remember-me.
 * Only the AI and backup endpoints still run here, and they are reached solely
 * through the server's bridge: it forwards the request with the signed-in
 * user's id and the shared bridge_key from config/config.php. There is no PHP
 * session any more, so a request that does not come through the bridge is
 * simply not authenticated.
 */

declare(strict_types=1);

require_once __DIR__ . '/../db/database.php';
require_once __DIR__ . '/helpers.php';
require_once __DIR__ . '/activity.php';

/** Trust the bridge headers for this request, if they are genuine. */
function auth_boot(): void
{
    static $booted = false;
    if ($booted) {
        return;
    }
    $booted = true;

    $_SESSION = [];
    $uid = bridge_user_id();
    if ($uid === 0) {
        return;
    }
    $stmt = db()->prepare('SELECT role FROM users WHERE id = ? AND is_active = 1');
    $stmt->execute([$uid]);
    $role = $stmt->fetchColumn();
    if ($role !== false) {
        $_SESSION = ['user_id' => $uid, 'role' => (string) $role];
    }
}

/**
 * The user id the ASP.NET server vouches for, or 0. Only trusted from the
 * local machine and only with the exact bridge_key; an empty key disables it.
 */
function bridge_user_id(): int
{
    $key    = (string) app_config('bridge_key', '');
    $sent   = (string) ($_SERVER['HTTP_X_INPHUB_KEY'] ?? '');
    $remote = (string) ($_SERVER['REMOTE_ADDR'] ?? '');
    if ($key === '' || $sent === '' || !hash_equals($key, $sent) || !in_array($remote, ['127.0.0.1', '::1'], true)) {
        return 0;
    }
    return max(0, (int) ($_SERVER['HTTP_X_INPHUB_USER'] ?? 0));
}

/** Current user id, or 0 when unauthenticated. */
function current_user_id(): int
{
    return (int) ($_SESSION['user_id'] ?? 0);
}

/** Full current user row (cached, never the password hash), or null. */
function current_user(): ?array
{
    static $cache = null;
    $id = current_user_id();
    if ($id === 0) {
        return null;
    }
    if ($cache !== null && (int) $cache['id'] === $id) {
        return $cache;
    }
    $stmt = db()->prepare('SELECT id, username, display_name, role, is_active FROM users WHERE id = ?');
    $stmt->execute([$id]);
    $cache = $stmt->fetch() ?: null;
    return $cache;
}

function is_authenticated(): bool
{
    return current_user_id() > 0;
}

/** Guard an API endpoint: 401 JSON if the bridge did not vouch for a user. */
function require_login(): void
{
    if (!is_authenticated()) {
        json_response(false, 'Not authenticated.', 401);
    }
}

/** Guard a download endpoint (export.php); same rule as require_login(). */
function require_login_page(): void
{
    require_login();
}
