<?php
/**
 * inphub — password hashing helper.
 *
 * There is no sign-up flow: accounts are added by hand. Use this to turn a
 * plaintext password into a bcrypt hash you can paste into an INSERT:
 *
 *   php tools/hashpw.php "thePassword"
 *
 * Then:
 *   INSERT INTO users (username, password_hash, display_name, role, is_active)
 *   VALUES ('someone', '<paste-hash-here>', 'Some One', 'user', 1);
 */

declare(strict_types=1);

if ($argc < 2 || trim((string) $argv[1]) === '') {
    fwrite(STDERR, "Usage: php tools/hashpw.php \"the password\"\n");
    exit(1);
}

$hash = password_hash($argv[1], PASSWORD_DEFAULT);
if ($hash === false) {
    fwrite(STDERR, "Hashing failed.\n");
    exit(1);
}

echo $hash, PHP_EOL;
