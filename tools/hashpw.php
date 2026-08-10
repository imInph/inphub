<?php
/**
 * inphub — password hashing helper.
 *
 * There is no sign-up flow: accounts are added by hand. Use this to turn a
 * plaintext password into a bcrypt hash you can paste into an INSERT:
 *
 *   php tools/hashpw.php "thePassword"
 *   (or in a browser: tools/hashpw.php?input=thePassword)
 *
 * Then:
 *   INSERT INTO users (username, password_hash, display_name, role, is_active)
 *   VALUES ('someone', '<paste-hash-here>', 'Some One', 'user', 1);
 */

declare(strict_types=1);

if (PHP_SAPI === 'cli') {
    $input = $argv[1] ?? '';
} else {
    $input = $_GET['input'] ?? '';
}

if (trim((string) $input) === '') {
    exit(PHP_SAPI === 'cli'
        ? "Usage: php tools/hashpw.php \"the password\"\n"
        : 'No input provided.');
}

$hash = password_hash((string) $input, PASSWORD_DEFAULT);
if ($hash === false) {
    // STDERR only exists in CLI, so keep the error path SAPI-agnostic.
    exit('Hashing failed.');
}

echo $hash, PHP_EOL;
