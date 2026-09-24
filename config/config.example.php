<?php
/**
 * inphub — DB credentials template.
 *
 * Copy this file to config/config.php and adjust if needed.
 * On a default XAMPP install the values below work as-is
 * (MySQL user "root" with no password).
 *
 * Only DB credentials live here. AI keys and the GitHub token are
 * stored per-user in the `settings` table and entered in the UI.
 */

return [
    'db_host'    => 'localhost',
    'db_name'    => 'inphub',
    'db_user'    => 'root',
    'db_pass'    => '',
    'db_charset' => 'utf8mb4',

    // Username that gets the AI chat's "developer mode" (blunt, technical,
    // talks about the code and schema). Leave empty to disable it entirely.
    'developer_user' => '',

    // v4: shared secret for the ASP.NET server, which forwards the AI and
    // backup endpoints here. Must equal Inphub:BridgeKey in
    // server/appsettings.Local.json. Empty disables the bridge.
    'bridge_key' => '',
];
