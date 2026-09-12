<?php
/**
 * inphub: logout: destroy session + remember token, then back to login.
 */

declare(strict_types=1);

require_once __DIR__ . '/../lib/auth.php';
auth_boot();
logout();

header('Location: login.php');
exit;
