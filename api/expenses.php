<?php
/**
 * inphub: expenses (income + expense) CRUD.
 *
 *   GET  ?action=list[&period=month|last_month|3m|6m|year|all&category_id=&type=]
 *        (legacy &month=YYYY-MM still works; ?period= wins when both are sent)
 *   POST ?action=create { type, amount, currency?, category_id?, description?, payment_method?, spent_at?, is_recurring?, recurring_interval? }
 *   POST ?action=update { id, ...fields }
 *   POST ?action=delete { id }
 */

require_once __DIR__ . '/_bootstrap.php';

api_handle(function (): void {
    $uid   = current_user_id();
    $input = request_input();

    switch (action($input)) {
        case 'list': {
            $sql    = 'SELECT e.*, c.name AS category_name, c.color AS category_color, c.icon AS category_icon
                       FROM expenses e
                       LEFT JOIN expense_categories c ON c.id = e.category_id
                       WHERE e.user_id = ?';
            $params = [$uid];
            // Date window: ?period= wins, ?month=YYYY-MM still honoured (legacy).
            // A range predicate keeps spent_at bare instead of wrapping it in
            // DATE_FORMAT(); 'all' has null bounds, so the clause is dropped.
            // Default 'all' keeps the old contract: no date param = no date filter.
            $win = money_window($input, 'all');
            if ($win['from'] !== null) {
                $sql .= ' AND e.spent_at >= ? AND e.spent_at <= ?';
                $params[] = $win['from'];
                $params[] = $win['to'];
            }
            if (($cat = input_get($input, 'category_id')) !== null && $cat !== '') {
                $sql .= ' AND e.category_id = ?';
                $params[] = (int) $cat;
            }
            if ($type = str_or_null(input_get($input, 'type'))) {
                $sql .= ' AND e.type = ?';
                $params[] = valid_enum($type, ['expense', 'income'], 'expense');
            }
            $sql .= ' ORDER BY e.spent_at DESC, e.id DESC';
            $stmt = db()->prepare($sql);
            $stmt->execute($params);
            ok($stmt->fetchAll());
            break;
        }

        case 'create': {
            $amount = num_or_null(input_get($input, 'amount'));
            if ($amount === null) {
                fail('Amount is required.', 422);
            }
            $type      = valid_enum(input_get($input, 'type'), ['expense', 'income'], 'expense');
            $createdBy = input_get($input, 'created_by') === 'ai' ? 'ai' : 'user';
            $catId     = int_or_null(input_get($input, 'category_id'));
            assert_category_owned($catId, $uid);

            $stmt = db()->prepare(
                'INSERT INTO expenses
                    (user_id, type, amount, currency, category_id, description, payment_method, spent_at, is_recurring, recurring_interval, created_by)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
            );
            $currency = strtoupper(substr((string) (input_get($input, 'currency') ?: default_currency($uid)), 0, 3));
            $stmt->execute([
                $uid,
                $type,
                $amount,
                $currency,
                $catId,
                str_or_null(input_get($input, 'description')),
                str_or_null(input_get($input, 'payment_method')),
                str_or_null(input_get($input, 'spent_at')) ?? today(),
                (int) (bool) input_get($input, 'is_recurring', 0),
                str_or_null(input_get($input, 'recurring_interval')),
                $createdBy,
            ]);
            $id = (int) db()->lastInsertId();
            // Units in the summary, always: the weekly review reads these rows
            // back to the model, and a bare number reads as dollars.
            $verb = $type === 'income' ? 'Income' : 'Spent';
            log_activity($uid, 'expense.created', 'expense', $id, "$verb " . money_text($amount, $currency), $createdBy === 'ai' ? 'ai' : 'user');
            ok(['id' => $id]);
            break;
        }

        case 'update': {
            $exp   = fetch_owned('expenses', (int) input_get($input, 'id'), $uid);
            $catId = array_key_exists('category_id', $input) ? int_or_null($input['category_id']) : (int_or_null($exp['category_id']));
            assert_category_owned($catId, $uid);
            $stmt = db()->prepare(
                'UPDATE expenses SET type=?, amount=?, currency=?, category_id=?, description=?, payment_method=?, spent_at=?, is_recurring=?, recurring_interval=?
                 WHERE id=? AND user_id=?'
            );
            $stmt->execute([
                valid_enum(input_get($input, 'type', $exp['type']), ['expense', 'income'], $exp['type']),
                num_or_null(input_get($input, 'amount', $exp['amount'])) ?? (float) $exp['amount'],
                strtoupper(substr((string) input_get($input, 'currency', $exp['currency']), 0, 3)),
                $catId,
                array_key_exists('description', $input) ? str_or_null($input['description']) : $exp['description'],
                array_key_exists('payment_method', $input) ? str_or_null($input['payment_method']) : $exp['payment_method'],
                str_or_null(input_get($input, 'spent_at', $exp['spent_at'])) ?? $exp['spent_at'],
                (int) (bool) input_get($input, 'is_recurring', $exp['is_recurring']),
                array_key_exists('recurring_interval', $input) ? str_or_null($input['recurring_interval']) : $exp['recurring_interval'],
                (int) $exp['id'],
                $uid,
            ]);
            log_activity($uid, 'expense.updated', 'expense', (int) $exp['id'], 'Updated an entry');
            ok(['id' => (int) $exp['id']]);
            break;
        }

        case 'delete': {
            $exp = fetch_owned('expenses', (int) input_get($input, 'id'), $uid);
            $del = db()->prepare('DELETE FROM expenses WHERE id=? AND user_id=?');
            $del->execute([(int) $exp['id'], $uid]);
            log_activity($uid, 'expense.deleted', 'expense', (int) $exp['id'], 'Deleted an entry');
            ok(['deleted' => (int) $exp['id']]);
            break;
        }

        default:
            fail('Unknown action.', 404);
    }
});

/** Reject a category_id that does not belong to the user. */
function assert_category_owned(?int $catId, int $uid): void
{
    if ($catId === null) {
        return;
    }
    $stmt = db()->prepare('SELECT 1 FROM expense_categories WHERE id=? AND user_id=?');
    $stmt->execute([$catId, $uid]);
    if ($stmt->fetchColumn() === false) {
        fail('Unknown category.', 422);
    }
}
