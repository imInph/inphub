<?php
/**
 * inphub: authentication: sessions, login/logout, remember-me, guards.
 *
 * There is no registration. Accounts are inserted by hand (see tools/hashpw.php
 * and the template in inphub.sql). On first login a user is auto-provisioned
 * with default settings/categories/habits.
 */

declare(strict_types=1);

require_once __DIR__ . '/../db/database.php';
require_once __DIR__ . '/helpers.php';
require_once __DIR__ . '/provision.php';
require_once __DIR__ . '/activity.php';

const REMEMBER_COOKIE = 'inphub_remember';
const REMEMBER_TTL_DAYS = 365;

/**
 * Start the PHP session (once) and, if there is no active session, try to
 * silently re-establish one from a valid remember-me cookie.
 */
function auth_boot(): void
{
    static $booted = false;
    if ($booted) {
        return;
    }
    $booted = true;

    if (session_status() !== PHP_SESSION_ACTIVE) {
        session_set_cookie_params([
            'lifetime' => 0,
            'path'     => '/',
            'httponly' => true,
            'samesite' => 'Lax',
        ]);
        session_start();
    }

    if (empty($_SESSION['user_id'])) {
        attempt_remember_login();
    }
}

/** SHA-256 hash of a raw remember token (what we store + index on). */
function remember_hash(string $rawToken): string
{
    return hash('sha256', $rawToken);
}

/**
 * Verify a username/password. On success, establish the session, stamp
 * last_login_at, provision defaults, and optionally issue a remember cookie.
 *
 * @return array{ok:bool,error?:string}
 */
function login(string $username, #[\SensitiveParameter] string $password, bool $remember = false): array
{
    $stmt = db()->prepare('SELECT * FROM users WHERE username = ? LIMIT 1');
    $stmt->execute([$username]);
    $user = $stmt->fetch();

    // Generic error for every failure mode (don't reveal which part failed).
    if (!$user || !password_verify($password, $user['password_hash'])) {
        return ['ok' => false, 'error' => 'Invalid username or password.'];
    }
    if ((int) $user['is_active'] !== 1) {
        return ['ok' => false, 'error' => 'This account is deactivated.'];
    }

    // Fresh session id to avoid fixation.
    session_regenerate_id(true);
    $_SESSION['user_id'] = (int) $user['id'];
    $_SESSION['role']    = $user['role'];

    $upd = db()->prepare('UPDATE users SET last_login_at = NOW() WHERE id = ?');
    $upd->execute([(int) $user['id']]);

    provision_user((int) $user['id']);

    if ($remember) {
        issue_remember_token((int) $user['id']);
    }

    log_activity((int) $user['id'], 'auth.login', 'user', (int) $user['id'], 'Logged in', 'system');

    return ['ok' => true];
}

/**
 * Create a remember-me token: store only its hash, set an httponly cookie
 * with the raw value.
 */
function issue_remember_token(int $userId): void
{
    $raw     = bin2hex(random_bytes(32));
    $expires = (new DateTime("+" . REMEMBER_TTL_DAYS . " days"))->format('Y-m-d H:i:s');

    $stmt = db()->prepare(
        'INSERT INTO remember_tokens (user_id, token_hash, expires_at, user_agent)
         VALUES (?, ?, ?, ?)'
    );
    $stmt->execute([
        $userId,
        remember_hash($raw),
        $expires,
        mb_substr($_SERVER['HTTP_USER_AGENT'] ?? '', 0, 255),
    ]);

    setcookie(REMEMBER_COOKIE, $raw, [
        'expires'  => time() + REMEMBER_TTL_DAYS * 86400,
        'path'     => '/',
        'httponly' => true,
        'samesite' => 'Lax',
    ]);
}

/**
 * Look up the remember cookie; if valid + unexpired, re-establish the session
 * and rotate the token (delete the used one, issue a fresh one).
 */
function attempt_remember_login(): void
{
    $raw = $_COOKIE[REMEMBER_COOKIE] ?? '';
    if ($raw === '') {
        return;
    }

    $stmt = db()->prepare(
        'SELECT rt.id, rt.user_id, u.role, u.is_active
           FROM remember_tokens rt
           JOIN users u ON u.id = rt.user_id
          WHERE rt.token_hash = ? AND rt.expires_at > NOW()
          LIMIT 1'
    );
    $stmt->execute([remember_hash($raw)]);
    $row = $stmt->fetch();

    if (!$row || (int) $row['is_active'] !== 1) {
        clear_remember_cookie();
        return;
    }

    // Rotate: drop the used token, then mint a new one.
    $del = db()->prepare('DELETE FROM remember_tokens WHERE id = ?');
    $del->execute([(int) $row['id']]);

    $_SESSION['user_id'] = (int) $row['user_id'];
    $_SESSION['role']    = $row['role'];

    issue_remember_token((int) $row['user_id']);
}

/**
 * Change the signed-in user's password.
 *
 * The app had no way to do this at all, accounts are inserted by hand and
 * README tells you to change the publicly documented default immediately.
 * Every *other* remember-me token is invalidated, so a device that kept you
 * signed in cannot keep the old credential alive; the current one is rotated.
 *
 * @return array{ok:bool, error:?string}
 */
function change_password(int $userId, #[\SensitiveParameter] string $current, #[\SensitiveParameter] string $next): array
{
    if ($userId <= 0) {
        return ['ok' => false, 'error' => 'Not signed in.'];
    }
    if (mb_strlen($next) < 8) {
        return ['ok' => false, 'error' => 'New password must be at least 8 characters.'];
    }

    $stmt = db()->prepare('SELECT password_hash FROM users WHERE id = ? LIMIT 1');
    $stmt->execute([$userId]);
    $hash = $stmt->fetchColumn();
    if ($hash === false || !password_verify($current, (string) $hash)) {
        return ['ok' => false, 'error' => 'Current password is incorrect.'];
    }
    if (password_verify($next, (string) $hash)) {
        return ['ok' => false, 'error' => 'That is already your password.'];
    }

    $upd = db()->prepare('UPDATE users SET password_hash = ? WHERE id = ?');
    $upd->execute([password_hash($next, PASSWORD_DEFAULT), $userId]);

    // Drop every remembered device, then re-issue for this one if it had one.
    $hadCookie = ($_COOKIE[REMEMBER_COOKIE] ?? '') !== '';
    $wipe = db()->prepare('DELETE FROM remember_tokens WHERE user_id = ?');
    $wipe->execute([$userId]);
    clear_remember_cookie();
    if ($hadCookie) {
        issue_remember_token($userId);
    }

    // Keep the session valid but give it a new id.
    if (session_status() === PHP_SESSION_ACTIVE) {
        session_regenerate_id(true);
    }

    log_activity($userId, 'auth.password_changed', 'user', $userId, 'Changed account password');
    return ['ok' => true, 'error' => null];
}

/** Destroy the session and delete the matching remember token + cookie. */
function logout(): void
{
    $raw = $_COOKIE[REMEMBER_COOKIE] ?? '';
    if ($raw !== '') {
        $del = db()->prepare('DELETE FROM remember_tokens WHERE token_hash = ?');
        $del->execute([remember_hash($raw)]);
    }
    clear_remember_cookie();

    $_SESSION = [];
    if (session_status() === PHP_SESSION_ACTIVE) {
        session_destroy();
    }
}

function clear_remember_cookie(): void
{
    setcookie(REMEMBER_COOKIE, '', [
        'expires'  => time() - 3600,
        'path'     => '/',
        'httponly' => true,
        'samesite' => 'Lax',
    ]);
}

/** Current user id from the session, or 0 when unauthenticated. */
function current_user_id(): int
{
    return (int) ($_SESSION['user_id'] ?? 0);
}

/** Full current user row (cached), or null. */
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

/**
 * Guard an API endpoint: 401 JSON if not logged in.
 */
function require_login(): void
{
    if (!is_authenticated()) {
        json_response(false, 'Not authenticated.', 401);
    }
}

/**
 * Guard an HTML page: redirect to the login page if not logged in.
 */
function require_login_page(): void
{
    if (!is_authenticated()) {
        header('Location: login.php');
        exit;
    }
}

/**
 * Guard an admin-only API endpoint.
 */
function require_role(string $role): void
{
    require_login();
    $user = current_user();
    if (!$user || $user['role'] !== $role) {
        json_response(false, 'Forbidden.', 403);
    }
}
