<?php
/**
 * inphub — activity history (read-only feed).
 *
 *   GET ?action=list[&type=&actor=&limit=]
 */

require_once __DIR__ . '/_bootstrap.php';

api_handle(function (): void {
    $uid   = current_user_id();
    $input = request_input();

    switch (action($input)) {
        case 'list': {
            $sql    = 'SELECT * FROM activity_log WHERE user_id = ?';
            $params = [$uid];
            if ($type = str_or_null(input_get($input, 'type'))) {
                $sql .= ' AND type = ?';
                $params[] = $type;
            }
            if ($actor = str_or_null(input_get($input, 'actor'))) {
                $sql .= ' AND actor = ?';
                $params[] = valid_enum($actor, ['user', 'ai', 'system'], 'user');
            }
            $limit = clamp_int((int) input_get($input, 'limit', 100), 1, 500);
            $sql .= ' ORDER BY created_at DESC, id DESC LIMIT ' . $limit;
            $stmt = db()->prepare($sql);
            $stmt->execute($params);
            ok($stmt->fetchAll());
            break;
        }

        default:
            fail('Unknown action.', 404);
    }
});
