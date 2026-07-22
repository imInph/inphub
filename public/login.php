<?php
/**
 * inphub — login page.
 *
 * Server-rendered so it works before the TypeScript is compiled. There is no
 * registration: accounts are created by hand in phpMyAdmin.
 */

declare(strict_types=1);

require_once __DIR__ . '/../lib/auth.php';
auth_boot();

// Already logged in? Go home.
if (is_authenticated()) {
    header('Location: index.php');
    exit;
}

$error = null;
if (($_SERVER['REQUEST_METHOD'] ?? 'GET') === 'POST') {
    $username = trim((string) ($_POST['username'] ?? ''));
    $password = (string) ($_POST['password'] ?? '');
    $remember = isset($_POST['remember']);

    $res = login($username, $password, $remember);
    if ($res['ok']) {
        header('Location: index.php');
        exit;
    }
    $error = $res['error'];
}

$theme = 'dark';
?>
<!DOCTYPE html>
<html lang="en" data-theme="<?= htmlspecialchars($theme, ENT_QUOTES) ?>">
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>inphub · sign in</title>
    <link rel="icon" href="favicon.svg" type="image/svg+xml">
    <link rel="stylesheet" href="assets/css/app.css">
</head>
<body class="login-body">
    <main class="login-card">
        <div class="login-brand">
            <span class="logo-mark">in</span><span class="logo-rest">phub</span>
        </div>
        <p class="login-sub">Your personal daily dashboard.</p>

        <?php if ($error !== null): ?>
            <div class="login-error" role="alert"><?= htmlspecialchars($error, ENT_QUOTES) ?></div>
        <?php endif; ?>

        <form method="post" class="login-form" autocomplete="on">
            <label>
                <span>Username</span>
                <input type="text" name="username" required autofocus autocomplete="username">
            </label>
            <label>
                <span>Password</span>
                <input type="password" name="password" required autocomplete="current-password">
            </label>
            <label class="checkbox">
                <input type="checkbox" name="remember" value="1" checked>
                <span>Keep me logged in</span>
            </label>
            <button type="submit" class="btn btn-primary btn-block">Sign in</button>
        </form>

        <p class="login-hint">No account? Accounts are created by hand in phpMyAdmin.</p>
    </main>
</body>
</html>
