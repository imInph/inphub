<?php
/**
 * inphub — admin-only account management.
 *
 *   GET  ?action=list                       list all accounts
 *   POST ?action=set_active { id, active }  activate / deactivate an account
 *
 * Every action requires the 'admin' role.
 */

require_once __DIR__ . '/_bootstrap.php';

api_handle(function (): void {
    require_role('admin');
    $input = request_input();

    switch (action($input)) {
        case 'list': {
            $stmt = db()->query(
                'SELECT id, username, display_name, role, is_active, created_at, last_login_at
                 FROM users ORDER BY id ASC'
            );
            ok($stmt->fetchAll());
            break;
        }

        case 'set_active': {
            $id     = (int) input_get($input, 'id', 0);
            $active = (int) (bool) input_get($input, 'active', 1);
            if ($id <= 0) {
                fail('Missing user id.', 422);
            }
            // Don't let an admin deactivate their own account and lock themselves out.
            if ($id === current_user_id() && $active === 0) {
                fail('You cannot deactivate your own account.', 422);
            }
            $stmt = db()->prepare('UPDATE users SET is_active=? WHERE id=?');
            $stmt->execute([$active, $id]);
            log_activity(current_user_id(), 'admin.user_active', 'user', $id, ($active ? 'Activated' : 'Deactivated') . " account #$id", 'user');
            ok(['id' => $id, 'is_active' => (bool) $active]);
            break;
        }

        default:
            fail('Unknown action.', 404);
    }
});
