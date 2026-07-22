<?php
/**
 * inphub — app shell.
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
    <link rel="icon" href="favicon.svg" type="image/svg+xml">
    <link rel="stylesheet" href="assets/css/app.css">
    <script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js" defer></script>
    <script>window.INPHUB = <?= json_encode($boot, JSON_UNESCAPED_UNICODE) ?>;</script>
</head>
<body>
    <div class="app">
        <!-- Sidebar -->
        <aside class="sidebar">
            <div class="brand">
                <span class="logo-mark">in</span><span class="logo-rest">phub</span>
            </div>
            <nav class="nav">
                <?php foreach ($nav as [$id, $label, $key]): ?>
                    <a href="#<?= $id ?>" class="nav-item" data-view="<?= $id ?>" data-key="<?= $key ?>">
                        <span class="nav-label"><?= htmlspecialchars($label) ?></span>
                    </a>
                <?php endforeach; ?>
            </nav>
            <div class="sidebar-foot">
                <button class="btn btn-ghost" id="btn-chat" hidden>💬 Chat</button>
                <button class="btn btn-ghost" id="btn-palette" title="Ctrl/Cmd+K">⌘K</button>
                <a class="btn btn-ghost" href="logout.php">Log out</a>
            </div>
        </aside>

        <!-- Main -->
        <main class="main">
            <header class="topbar">
                <div class="topbar-left">
                    <div id="greeting" class="greeting"></div>
                </div>
                <div class="topbar-right">
                    <div id="clock" class="clock"></div>
                    <button class="btn btn-ghost" id="btn-theme" title="Toggle theme">◐</button>
                </div>
            </header>

            <?php foreach ($nav as [$id, $label]): ?>
                <section id="view-<?= $id ?>" class="view" hidden aria-label="<?= htmlspecialchars($label) ?>"></section>
            <?php endforeach; ?>
        </main>
    </div>

    <!-- Slide-out chat panel (populated in Phase 2 by chat.ts) -->
    <div id="chat-panel" class="chat-panel" hidden></div>

    <!-- Command palette -->
    <div id="palette" class="palette" hidden></div>

    <!-- Toast host -->
    <div id="toasts" class="toasts" aria-live="polite"></div>

    <script type="module" src="assets/js/app.js"></script>
</body>
</html>
