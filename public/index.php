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

$look  = ui_appearance($uid);

$boot = [
    'user'       => ['id' => $uid, 'username' => $user['username'], 'display_name' => $user['display_name'], 'role' => $user['role']],
    'theme'      => $theme,
    'appearance' => $look,
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

/**
 * Line icons, 24px grid, stroked with currentColor so they follow the nav
 * state. Inner SVG markup only; icon() wraps it.
 */
$icons = [
    'dashboard' => '<rect x="3.5" y="3.5" width="7" height="7" rx="2"/><rect x="13.5" y="3.5" width="7" height="7" rx="2"/><rect x="3.5" y="13.5" width="7" height="7" rx="2"/><rect x="13.5" y="13.5" width="7" height="7" rx="2"/>',
    'todos'     => '<path d="M4 6.5l1.6 1.6L8.8 5M4 12.5l1.6 1.6 3.2-3.1M4 18.5l1.6 1.6 3.2-3.1"/><path d="M12.5 7H20M12.5 13H20M12.5 19H20"/>',
    'expenses'  => '<rect x="3" y="6.5" width="18" height="13.5" rx="3"/><path d="M3 10.5h18M16 15.5h1.5M6 6.5l8.5-3 1.5 3"/>',
    'repos'     => '<circle cx="6" cy="5.5" r="2"/><circle cx="6" cy="18.5" r="2"/><circle cx="18" cy="8" r="2"/><path d="M6 7.5v9M18 10c0 4-6.5 3.5-11 7"/>',
    'habits'    => '<path d="M12 21c-3.9 0-7-2.7-7-6.5 0-3.6 2.7-5.5 3.9-8.4.6 2 1.8 3 3.1 3.4.1-3.4 1.1-5.4 3.1-6.5.2 3.1 3.9 5.8 3.9 11.3 0 3.8-3.1 6.7-7 6.7z"/>',
    'goals'     => '<circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="12" r="4.8"/><circle cx="12" cy="12" r="1.2"/>',
    'notes'     => '<path d="M6.5 3.5h8l4 4v11a2 2 0 0 1-2 2h-10a2 2 0 0 1-2-2v-13a2 2 0 0 1 2-2z"/><path d="M14 3.5V8h4.5M8.5 13h7M8.5 16.5h4.5"/>',
    'focus'     => '<circle cx="12" cy="13" r="7.5"/><path d="M12 9.5V13l2.5 2M9.5 2.8h5"/>',
    'insights'  => '<path d="M3.5 20.5h17M6.5 17v-5M10.5 17V6.5M14.5 17V9.5M18.5 17v-3"/>',
    'activity'  => '<path d="M3.8 12a8.2 8.2 0 1 0 2.4-5.8L3.8 8.5"/><path d="M3.8 4v4.5h4.5M12 7.5V12l3 2"/>',
    'settings'  => '<path d="M4 6.5h9M17.5 6.5H20M4 12h3M11.5 12H20M4 17.5h11M19.5 17.5h.5"/><circle cx="15.5" cy="6.5" r="2"/><circle cx="9" cy="12" r="2"/><circle cx="17.5" cy="17.5" r="2"/>',
    'chat'      => '<path d="M20.5 11.5a8 8 0 0 1-11.7 7.1L4 19.8l1.2-4.4a8 8 0 1 1 15.3-3.9z"/>',
    'search'    => '<circle cx="11" cy="11" r="6.5"/><path d="M20 20l-4.2-4.2"/>',
    'logout'    => '<path d="M14.5 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3"/><path d="M10 16.5L5.5 12 10 7.5M5.5 12H15"/>',
    'theme'     => '<circle cx="12" cy="12" r="8"/><path d="M12 4a8 8 0 0 1 0 16z" fill="currentColor"/>',
    'menu'      => '<path d="M4 7h16M4 12h16M4 17h16"/>',
];
$icon = static fn (string $name): string =>
    '<svg class="ico" viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8"'
    . ' stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' . ($icons[$name] ?? '') . '</svg>';

$wpStyle = $look['wallpaper_url'] !== '' ? '--wp-image: ' . css_url($look['wallpaper_url']) : '';
?>
<!DOCTYPE html>
<html lang="en" data-theme="<?= htmlspecialchars($theme, ENT_QUOTES) ?>"
      data-accent="<?= htmlspecialchars($look['accent'], ENT_QUOTES) ?>"
      data-wallpaper="<?= htmlspecialchars($look['wallpaper'], ENT_QUOTES) ?>"
      data-glass="<?= htmlspecialchars($look['transparency'], ENT_QUOTES) ?>"
      <?= $wpStyle !== '' ? 'style="' . htmlspecialchars($wpStyle, ENT_QUOTES) . '"' : '' ?>>
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>inphub</title>
    <meta name="description" content="Personal life dashboard: money, tasks, habits, goals, notes, focus.">
    <meta name="color-scheme" content="dark light">
    <meta name="theme-color" content="<?= $theme === 'light' ? '#f4f6fa' : '#0b0d12' ?>">
    <meta name="apple-mobile-web-app-capable" content="yes">
    <meta name="apple-mobile-web-app-title" content="inphub">
    <!-- Safari and older browsers ignore SVG favicons and fall back to /favicon.ico
         at the server root, which on XAMPP is XAMPP's logo. The .ico/.png links
         stop that fallback; ?v= busts browsers' long favicon cache on a redesign. -->
    <link rel="icon" href="favicon.ico?v=<?= htmlspecialchars(INPHUB_VERSION) ?>" sizes="32x32">
    <link rel="icon" href="favicon.svg?v=<?= htmlspecialchars(INPHUB_VERSION) ?>" type="image/svg+xml">
    <link rel="icon" href="favicon-32.png?v=<?= htmlspecialchars(INPHUB_VERSION) ?>" type="image/png" sizes="32x32">
    <link rel="apple-touch-icon" href="apple-touch-icon.png?v=<?= htmlspecialchars(INPHUB_VERSION) ?>">
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
    <?php
        // Markdown: marked (+ footnotes) parses, DOMPurify sanitises; markdown()
        // in src/ui.ts uses them as globals. Vendored by `npm run vendor`, the
        // version is in the file name. Deferred, and before the module script,
        // so they have run by the time app.js does.
        foreach (['marked-18.0.13.umd.js', 'marked-footnote-1.4.0.umd.js', 'purify-3.4.15.min.js'] as $lib):
            $libVer = @filemtime(__DIR__ . '/assets/vendor/' . $lib) ?: $jsVer;
    ?>
    <script src="assets/vendor/<?= $lib ?>?v=<?= htmlspecialchars((string) $libVer, ENT_QUOTES) ?>" defer></script>
    <?php endforeach; ?>
    <script>window.INPHUB = <?= json_encode($boot, JSON_UNESCAPED_UNICODE) ?>;</script>
    <script>
        // Apply the locally-cached theme + appearance before first paint so a
        // stale server value (e.g. a failed settings save) never flashes the
        // wrong look. The server attributes above are the fallback.
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
                else h.style.removeProperty('--wp-image');
            }
        } catch (e) {}
    </script>
</head>
<body>
    <div class="wallpaper" aria-hidden="true"></div>
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
                        <?= $icon($id) ?><span class="nav-label"><?= htmlspecialchars($label) ?></span>
                    </a>
                <?php endforeach; ?>
            </nav>
            <div class="sidebar-foot">
                <button class="btn btn-ghost nav-item" id="btn-chat" hidden><?= $icon('chat') ?><span class="nav-label">Chat</span></button>
                <button class="btn btn-ghost nav-item" id="btn-palette" title="Press K (or Ctrl/Cmd+K)"
                        onclick="window.inphubPalette&&window.inphubPalette()"><?= $icon('search') ?><span class="nav-label">Search</span><kbd>K</kbd></button>
                <a class="btn btn-ghost nav-item" href="logout.php"><?= $icon('logout') ?><span class="nav-label">Log out</span></a>
            </div>
        </aside>
        <div class="nav-backdrop" id="nav-backdrop" hidden
             onclick="window.inphubDrawer&&window.inphubDrawer(false)"></div>

        <!-- Main -->
        <main class="main">
            <header class="topbar">
                <div class="topbar-left">
                    <button class="btn btn-ghost btn-icon hamburger" id="btn-nav" aria-label="Open menu"
                            onclick="window.inphubDrawer&&window.inphubDrawer()"><?= $icon('menu') ?></button>
                    <div class="title-block">
                        <div id="greeting" class="greeting"></div>
                        <h1 id="page-title" class="page-title">Dashboard</h1>
                    </div>
                </div>
                <div class="topbar-right">
                    <div id="clock" class="clock"></div>
                    <button class="btn btn-ghost btn-icon" id="btn-theme" title="Toggle theme" aria-label="Toggle theme"
                            onclick="window.inphubToggleTheme&&window.inphubToggleTheme()"><?= $icon('theme') ?></button>
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
