<?php
/**
 * inphub: app shell.
 *
 * Guards the session, injects a small bootstrap payload (user + theme), and
 * renders the persistent nav plus one empty <section> per view. The compiled
 * TypeScript in assets/js/app.js drives everything else (tab switching, data
 * loading) without full page reloads.
 */

declare(strict_types=1);

require_once __DIR__ . '/../lib/auth.php';
auth_boot();
require_login_page();

$user  = current_user();
$uid   = (int) $user['id'];
$theme = (string) (get_setting($uid, 'theme', 'dark') ?: 'dark');
$isAdmin = $user['role'] === 'admin';

$boot = [
    'user'  => ['id' => $uid, 'username' => $user['username'], 'display_name' => $user['display_name'], 'role' => $user['role']],
    'theme' => $theme,
];

/** Nav items: [id, label, hotkey-letter]. */
$nav = [
    ['dashboard', 'Dashboard', 'd'],
    ['todos',     'To-Do',     't'],
    ['expenses',  'Money',     'e'],
    ['repos',     'Repos',     'r'],
    ['habits',    'Habits',    'h'],
    ['goals',     'Goals',     'g'],
    ['notes',     'Notes',     'n'],
    ['focus',     'Focus',     'f'],
    ['insights',  'Insights',  'i'],
    ['activity',  'History',   'a'],
    ['settings',  'Settings',  's'],
];
?>
<!DOCTYPE html>
<html lang="en" data-theme="<?= htmlspecialchars($theme, ENT_QUOTES) ?>">
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>inphub</title>
    <meta name="description" content="Personal life dashboard: money, tasks, habits, goals, notes, focus.">
    <meta name="color-scheme" content="dark light">
    <meta name="theme-color" content="<?= $theme === 'light' ? '#f4f6fa' : '#0b0d12' ?>">
    <meta name="apple-mobile-web-app-capable" content="yes">
    <meta name="apple-mobile-web-app-title" content="inphub">
    <link rel="icon" href="favicon.svg" type="image/svg+xml">
    <link rel="apple-touch-icon" href="icon.svg">
    <link rel="manifest" href="manifest.json">
    <?php
        // Cache-bust CSS/JS by file mtime so a copied-in update is never served
        // stale from the browser cache.
        //
        // $jsVer is the NEWEST mtime across every module, not just app.js:
        // app.js statically imports its 14 siblings by bare relative path, so
        // those URLs carry no version of their own. Versioning only the entry
        // point let the browser pair a fresh app.js with a cached ui.js, and a
        // missing export is an ES-module *link* error, which stops app.js from
        // executing at all. The whole app dies silently. Keep this as a max().
        // $jsVer MUST equal the id tools/stamp-modules.mjs baked into the
        // import specifiers. A mismatch makes app.js?v=X and ./app.js?v=Y two
        // distinct modules, so app.js evaluates twice and the second copy runs
        // init() against a half-initialised command-palette module.
        $cssVer = @filemtime(__DIR__ . '/assets/css/app.css') ?: time();
        $jsVer  = trim((string) @file_get_contents(__DIR__ . '/assets/js/build-id.txt'));
        if ($jsVer === '') {
            // No stamp file (someone ran tsc without the build script), fall
            // back to the newest module mtime, which is still better than
            // versioning app.js alone.
            $mtime = 0;
            foreach (glob(__DIR__ . '/assets/js/*.js') ?: [] as $mod) {
                $mtime = max($mtime, (int) @filemtime($mod));
            }
            $jsVer = (string) ($mtime ?: time());
        }
    ?>
    <link rel="stylesheet" href="assets/css/app.css?v=<?= $cssVer ?>">
    <?php
        // Chart.js is vendored so the charts do not depend on a CDN. It lives
        // outside assets/js/ so the build never touches a third-party file.
        $chartSrc = 'assets/vendor/chart-4.4.1.min.js';
        $chartVer = @filemtime(__DIR__ . '/' . $chartSrc) ?: $jsVer;
    ?>
    <script src="<?= $chartSrc ?>?v=<?= htmlspecialchars((string) $chartVer, ENT_QUOTES) ?>" defer></script>
    <script>window.INPHUB = <?= json_encode($boot, JSON_UNESCAPED_UNICODE) ?>;</script>
    <script>
        // Apply the locally-cached theme before first paint so a stale server
        // value (e.g. a failed settings save) never flashes the wrong theme.
        try {
            var t = localStorage.getItem('inphub.theme');
            if (t === 'light' || t === 'dark') document.documentElement.setAttribute('data-theme', t);
        } catch (e) {}
    </script>
</head>
<body>
    <div class="app">
        <!-- Sidebar -->
        <aside class="sidebar">
            <div class="brand">
                <span class="logo-mark">in</span><span class="logo-rest">phub</span>
                <span class="brand-version">v<?= htmlspecialchars(INPHUB_VERSION) ?></span>
            </div>
            <nav class="nav">
                <?php foreach ($nav as [$id, $label, $key]): ?>
                    <a href="#<?= $id ?>" class="nav-item" data-view="<?= $id ?>" data-key="<?= $key ?>">
                        <span class="nav-label"><?= htmlspecialchars($label) ?></span>
                    </a>
                <?php endforeach; ?>
            </nav>
            <div class="sidebar-foot">
                <button class="btn btn-ghost" id="btn-chat" hidden>Chat</button>
                <button class="btn btn-ghost" id="btn-palette" title="Press K (or Ctrl/Cmd+K)"
                        onclick="window.inphubPalette&&window.inphubPalette()">Search</button>
                <a class="btn btn-ghost" href="logout.php">Log out</a>
            </div>
        </aside>
        <div class="nav-backdrop" id="nav-backdrop" hidden
             onclick="window.inphubDrawer&&window.inphubDrawer(false)"></div>

        <!-- Main -->
        <main class="main">
            <header class="topbar">
                <div class="topbar-left">
                    <button class="btn btn-ghost hamburger" id="btn-nav" aria-label="Open menu"
                            onclick="window.inphubDrawer&&window.inphubDrawer()">☰</button>
                    <div id="greeting" class="greeting"></div>
                </div>
                <div class="topbar-right">
                    <div id="clock" class="clock"></div>
                    <button class="btn btn-ghost" id="btn-theme" title="Toggle theme"
                            onclick="window.inphubToggleTheme&&window.inphubToggleTheme()">◐</button>
                </div>
            </header>

            <?php foreach ($nav as [$id, $label]): ?>
                <section id="view-<?= $id ?>" class="view" hidden aria-label="<?= htmlspecialchars($label) ?>"></section>
            <?php endforeach; ?>
        </main>
    </div>

    <!-- Slide-out chat panel (populated by chat.ts) -->
    <div id="chat-panel" class="chat-panel" hidden></div>

    <!-- Command palette -->
    <div id="palette" class="palette" hidden></div>

    <!-- Toast host -->
    <div id="toasts" class="toasts" aria-live="polite"></div>

    <!-- A module link error (usually a half-cached bundle) otherwise fails in
         total silence: no view renders and no shortcut works. Say so out loud. -->
    <script>
        window.addEventListener('error', function (e) {
            if (e && e.message && /module|import|export/i.test(e.message) && !window.__inphubLoaded) {
                var b = document.createElement('div');
                b.style.cssText = 'position:fixed;inset:auto 0 0 0;z-index:999;padding:12px 16px;'
                    + 'background:#ef4444;color:#fff;font:14px system-ui;text-align:center';
                b.textContent = 'inphub could not load its scripts. Hard-reload the page '
                    + '(Cmd/Ctrl+Shift+R) to clear a stale cached module.';
                document.body.appendChild(b);
            }
        });
    </script>
    <?php if (is_file(__DIR__ . '/assets/js/app.js')): ?>
    <script type="module" src="assets/js/app.js?v=<?= htmlspecialchars($jsVer, ENT_QUOTES) ?>"></script>
    <?php else: ?>
    <!-- A 404 on the entry module fires no window error, so the banner above
         never shows and the page just stays blank. Checked here instead. -->
    <div style="position:fixed;inset:auto 0 0 0;z-index:999;padding:12px 16px;background:#ef4444;color:#fff;font:14px system-ui;text-align:center">
        inphub's JavaScript is missing (public/assets/js/app.js). Copy the whole folder again,
        or run <code>npm install &amp;&amp; npm run build</code>.
    </div>
    <?php endif; ?>
</body>
</html>
