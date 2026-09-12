<?php
/**
 * inphub: expense categories CRUD.
 *
 *   GET  ?action=list
 *   POST ?action=create { name, color?, icon?, monthly_budget? }
 *   POST ?action=update { id, name?, color?, icon?, monthly_budget? }
 *   POST ?action=delete { id }   (expenses keep, category_id set NULL)
 */

require_once __DIR__ . '/_bootstrap.php';

api_handle(function (): void {
    $uid   = current_user_id();
    $input = request_input();

    switch (action($input)) {
        case 'list': {
            $stmt = db()->prepare('SELECT * FROM expense_categories WHERE user_id = ? ORDER BY name ASC');
            $stmt->execute([$uid]);
            ok($stmt->fetchAll());
            break;
        }

        case 'create': {
            $name = str_or_null(input_get($input, 'name'));
            if ($name === null) {
                fail('Category name is required.', 422);
            }
            try {
                $stmt = db()->prepare(
                    'INSERT INTO expense_categories (user_id, name, color, icon, monthly_budget)
                     VALUES (?, ?, ?, ?, ?)'
                );
                $stmt->execute([
                    $uid,
                    $name,
                    str_or_null(input_get($input, 'color')) ?? '#6b7280',
                    str_or_null(input_get($input, 'icon')),
                    num_or_null(input_get($input, 'monthly_budget')),
                ]);
            } catch (PDOException $e) {
                if ($e->getCode() === '23000') {
                    fail('A category with that name already exists.', 409);
                }
                throw $e;
            }
            ok(['id' => (int) db()->lastInsertId()]);
            break;
        }

        case 'update': {
            $cat = fetch_owned('expense_categories', (int) input_get($input, 'id'), $uid);
            $stmt = db()->prepare(
                'UPDATE expense_categories SET name=?, color=?, icon=?, monthly_budget=? WHERE id=? AND user_id=?'
            );
            $stmt->execute([
                str_or_null(input_get($input, 'name', $cat['name'])) ?? $cat['name'],
                str_or_null(input_get($input, 'color', $cat['color'])) ?? $cat['color'],
                array_key_exists('icon', $input) ? str_or_null($input['icon']) : $cat['icon'],
                array_key_exists('monthly_budget', $input) ? num_or_null($input['monthly_budget']) : $cat['monthly_budget'],
                (int) $cat['id'],
                $uid,
            ]);
            ok(['id' => (int) $cat['id']]);
            break;
        }

        case 'delete': {
            $cat = fetch_owned('expense_categories', (int) input_get($input, 'id'), $uid);
            $del = db()->prepare('DELETE FROM expense_categories WHERE id=? AND user_id=?');
            $del->execute([(int) $cat['id'], $uid]);
            ok(['deleted' => (int) $cat['id']]);
            break;
        }

        default:
            fail('Unknown action.', 404);
    }
});
