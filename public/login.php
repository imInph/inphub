<?php
/**
 * inphub: login page.
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
<html lang="en" data-theme="<?= htmlspecialchars($theme, ENT_QUOTES) ?>" data-accent="blue" data-wallpaper="aurora" data-glass="full">
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>inphub · sign in</title>
    <meta name="color-scheme" content="dark light">
    <meta name="theme-color" content="#0b0d12">
    <link rel="manifest" href="manifest.json">
    <!-- Safari and older browsers ignore SVG favicons and fall back to /favicon.ico
         at the server root, which on XAMPP is XAMPP's logo. The .ico/.png links
         stop that fallback; ?v= busts browsers' long favicon cache on a redesign. -->
    <link rel="icon" href="favicon.ico?v=<?= htmlspecialchars(INPHUB_VERSION) ?>" sizes="32x32">
    <link rel="icon" href="favicon.svg?v=<?= htmlspecialchars(INPHUB_VERSION) ?>" type="image/svg+xml">
    <link rel="icon" href="favicon-32.png?v=<?= htmlspecialchars(INPHUB_VERSION) ?>" type="image/png" sizes="32x32">
    <link rel="apple-touch-icon" href="apple-touch-icon.png?v=<?= htmlspecialchars(INPHUB_VERSION) ?>">
    <link rel="stylesheet" href="assets/css/app.css?v=<?= @filemtime(__DIR__ . '/assets/css/app.css') ?: time() ?>">
    <script>
        // Use the last-chosen theme + appearance (cached by the app) instead of
        // always dark on the default wallpaper. No session here, so the cache
        // is the only source.
        try {
            var t = localStorage.getItem('inphub.theme');
            if (t === 'light' || t === 'dark') document.documentElement.setAttribute('data-theme', t);
            var a = JSON.parse(localStorage.getItem('inphub.appearance') || 'null');
            if (a && typeof a === 'object') {
                var h = document.documentElement;
                if (a.accent) h.setAttribute('data-accent', a.accent);
                if (a.wallpaper) h.setAttribute('data-wallpaper', a.wallpaper);
                if (a.transparency) h.setAttribute('data-glass', a.transparency);
                if (a.image) h.style.setProperty('--wp-image', a.image);
            }
        } catch (e) {}
    </script>
</head>
<body class="login-body">
    <div class="wallpaper" aria-hidden="true"></div>
    <main class="login-card glass">
        <div class="login-brand">
            <span class="logo-mark">in</span><span class="logo-rest">phub</span>
        </div>
        <p class="login-sub">Sign in</p>

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
        <p class="login-version">inphub v<?= htmlspecialchars(INPHUB_VERSION) ?></p>
    </main>
</body>
</html>
