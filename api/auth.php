<?php
/**
 * inphub: auth endpoint: login + logout + who-am-i.
 *
 *   POST ?action=login   { username, password, remember }
 *   POST ?action=logout
 *   GET  ?action=me
 *   POST ?action=change_password { current, next }   (requires a session)
 */

require_once __DIR__ . '/_bootstrap.php';

api_handle(function (): void {
    $input = request_input();
    $act   = action($input);

    switch ($act) {
        case 'login':
            if (method() !== 'POST') {
                fail('Use POST to log in.', 405);
            }
            $username = trim((string) input_get($input, 'username', ''));
            $password = (string) input_get($input, 'password', '');
            $remember = (bool) input_get($input, 'remember', false);

            if ($username === '' || $password === '') {
                fail('Username and password are required.', 422);
            }
            $res = login($username, $password, $remember);
            if (!$res['ok']) {
                fail($res['error'], 401);
            }
            ok(['user' => current_user()]);
            break;

        case 'logout':
            logout();
            ok(['loggedOut' => true]);
            break;

        case 'me':
            ok(['user' => current_user()]);
            break;

        case 'change_password': {
            // This endpoint is reached with requireAuth=false like the rest of
            // the file, so the guard has to be explicit here.
            require_login();
            if (method() !== 'POST') {
                fail('Use POST to change a password.', 405);
            }
            $res = change_password(
                current_user_id(),
                (string) input_get($input, 'current', ''),
                (string) input_get($input, 'next', '')
            );
            if (!$res['ok']) {
                fail((string) $res['error'], 422);
            }
            ok(['changed' => true]);
            break;
        }

        default:
            fail('Unknown action.', 404);
    }
}, requireAuth: false);
