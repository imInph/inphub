<?php
/**
 * inphub — AI features (all gated on ai_available()).
 *
 *   GET  ?action=status                          { available }
 *   GET  ?action=brief                           today's cached brief (or null)
 *   POST ?action=generate_brief                  (re)generate today's brief
 *   POST ?action=clear_brief                     delete the user's stored briefs
 *   GET  ?action=chat_history    [session_id]     turns of a session (default: latest)
 *   GET  ?action=list_sessions                   chat conversations, newest first
 *   GET  ?action=models                          selectable models for the provider
 *   POST ?action=chat            { message, session_id?, model? }   reply + executed actions
 *   POST ?action=delete_session  { session_id }   delete one conversation
 *   POST ?action=analyze_repo    { repo_id }     produce repo_suggestions
 *   POST ?action=analyze_stale                   analyze every stale repo
 *   POST ?action=quick_add       { text }        classify free text → the right table
 *   GET  ?action=weekly_review                   summarise the last 7 days
 *
 * quick_add is the only action that also works with AI off (prefix parsing).
 */

require_once __DIR__ . '/_bootstrap.php';
require_once __DIR__ . '/../lib/ai.php';

/** Whitelist of actions the chat AI is allowed to execute. Must be defined
 *  before api_handle() runs the request — top-level consts are not hoisted. */
const CHAT_ACTIONS = ['add_todo', 'complete_todo', 'add_expense', 'log_habit', 'add_note', 'update_goal_progress', 'add_repo_suggestion'];

/** Repo AI analysis cooldown — cached suggestions are served within this window. */
const AI_ANALYZE_COOLDOWN_HOURS = 6;

api_handle(function (): void {
    $uid   = current_user_id();
    $input = request_input();

    switch (action($input)) {
        case 'status':
            ok(['available' => ai_available($uid)]);
            break;

        case 'brief': {
            ai_gate($uid);
            $stmt = db()->prepare('SELECT * FROM daily_briefs WHERE user_id=? AND brief_date=CURRENT_DATE');
            $stmt->execute([$uid]);
            ok(['brief' => $stmt->fetch() ?: null]);
            break;
        }

        case 'clear_brief': {
            ai_gate($uid);
            $stmt = db()->prepare('DELETE FROM daily_briefs WHERE user_id=?');
            $stmt->execute([$uid]);
            ok(['cleared' => true]);
            break;
        }

        case 'generate_brief':
            ai_gate($uid);
            ok(['brief' => generate_brief($uid)]);
            break;

        case 'chat_history': {
            ai_gate($uid);
            $sid = str_or_null(input_get($input, 'session_id'));
            if ($sid === null) {
                // No session requested — resume the most recent conversation.
                backfill_legacy_session($uid);
                $stmt = db()->prepare('SELECT session_id FROM chat_sessions WHERE user_id=? ORDER BY updated_at DESC LIMIT 1');
                $stmt->execute([$uid]);
                $sid = $stmt->fetchColumn() ?: null;
            }
            if ($sid === null) {
                ok(['session_id' => null, 'messages' => []]);
                break;
            }
            $stmt = db()->prepare(
                'SELECT id, role, content, actions, created_at FROM chat_messages
                 WHERE user_id=? AND session_id=? ORDER BY id ASC LIMIT 100'
            );
            $stmt->execute([$uid, $sid]);
            ok(['session_id' => $sid, 'messages' => $stmt->fetchAll()]);
            break;
        }

        case 'list_sessions': {
            ai_gate($uid);
            backfill_legacy_session($uid);
            $stmt = db()->prepare(
                'SELECT session_id, title, created_at, updated_at FROM chat_sessions
                 WHERE user_id=? ORDER BY updated_at DESC LIMIT 50'
            );
            $stmt->execute([$uid]);
            ok(['sessions' => $stmt->fetchAll()]);
            break;
        }

        case 'delete_session': {
            ai_gate($uid);
            $sid = str_or_null(input_get($input, 'session_id'));
            if ($sid === null || $sid === '') {
                fail('session_id is required.', 422);
            }
            $stmt = db()->prepare('DELETE FROM chat_messages WHERE user_id=? AND session_id=?');
            $stmt->execute([$uid, $sid]);
            $stmt = db()->prepare('DELETE FROM chat_sessions WHERE user_id=? AND session_id=?');
            $stmt->execute([$uid, $sid]);
            ok(['deleted' => true]);
            break;
        }

        case 'chat':
            ai_gate($uid);
            ok(chat_turn(
                $uid,
                (string) (str_or_null(input_get($input, 'message')) ?? ''),
                str_or_null(input_get($input, 'model')),
                str_or_null(input_get($input, 'session_id'))
            ));
            break;

        case 'models':
            ai_gate($uid);
            ok(ai_list_models($uid));
            break;


        case 'analyze_repo': {
            ai_gate($uid);
            $repo  = fetch_owned('repos', (int) input_get($input, 'repo_id'), $uid);
            $force = (string) (input_get($input, 'force') ?? '') === '1';

            // Serve the cached analysis inside the cooldown window (unless forced) —
            // re-analysing on every click burns API tokens for the same input.
            $last = repo_last_analyzed($uid, (int) $repo['id']);
            if (!$force && $last !== null && strtotime($last) > time() - AI_ANALYZE_COOLDOWN_HOURS * 3600) {
                $out = db()->prepare('SELECT * FROM repo_suggestions WHERE repo_id=? AND user_id=? ORDER BY id DESC');
                $out->execute([(int) $repo['id'], $uid]);
                ok(['suggestions' => $out->fetchAll(), 'cached' => true, 'analyzed_at' => $last]);
                break;
            }
            ok(['suggestions' => analyze_repo($uid, $repo), 'cached' => false, 'analyzed_at' => date('Y-m-d H:i:s')]);
            break;
        }

        case 'analyze_stale': {
            ai_gate($uid);
            $staleDays = (int) (get_setting($uid, 'stale_repo_days', '60') ?: 60);
            $stmt = db()->prepare('SELECT * FROM repos WHERE user_id=? AND staleness_days >= ? ORDER BY staleness_days DESC LIMIT 10');
            $stmt->execute([$uid, $staleDays]);
            $analyzed = 0;
            $skipped  = 0;
            $failed   = 0;
            foreach ($stmt->fetchAll() as $repo) {
                $last = repo_last_analyzed($uid, (int) $repo['id']);
                if ($last !== null && strtotime($last) > time() - AI_ANALYZE_COOLDOWN_HOURS * 3600) {
                    $skipped++;
                    continue;
                }
                // One bad repo/model reply must not sink the whole batch.
                try {
                    analyze_repo($uid, $repo);
                    $analyzed++;
                } catch (Throwable $e) {
                    $failed++;
                }
            }
            ok(['analyzed' => $analyzed, 'skipped' => $skipped, 'failed' => $failed]);
            break;
        }

        case 'quick_add':
            ok(quick_add($uid, (string) (str_or_null(input_get($input, 'text')) ?? '')));
            break;

        case 'weekly_review':
            ai_gate($uid);
            ok(['review' => weekly_review($uid)]);
            break;

        default:
            fail('Unknown action.', 404);
    }
});

/** Stop with a clean 403 if AI is not configured/enabled. */
function ai_gate(int $uid): void
{
    if (!ai_available($uid)) {
        fail('AI is disabled. Enable it and configure a provider in Settings.', 403);
    }
}

/* ============================================================ daily brief */

function generate_brief(int $uid): array
{
    $context = brief_context($uid);
    $system  = 'You are the user\'s concise personal assistant inside a life dashboard. '
        . 'Write a short, energising daily brief in markdown: a one-line greeting, then 3-6 bullet points '
        . 'covering what needs attention today (overdue/ due tasks, habits not yet done, spending vs budget, '
        . 'neglected repos, active goals). Be specific using the data. No preamble, no sign-off.';
    $content = ai_generate($uid, $system, $context, ['max_tokens' => 700]);

    $c = ai_config($uid);
    $provider = $c['provider'];
    $model    = $provider === 'ollama' ? $c['ollama_model'] : $c['claude_model'];

    $stmt = db()->prepare(
        'INSERT INTO daily_briefs (user_id, brief_date, content, provider, model)
         VALUES (?, CURRENT_DATE, ?, ?, ?)
         ON DUPLICATE KEY UPDATE content=VALUES(content), provider=VALUES(provider), model=VALUES(model)'
    );
    $stmt->execute([$uid, $content, $provider, $model]);
    log_activity($uid, 'ai.brief', 'brief', null, 'Generated a daily brief', 'ai');

    $row = db()->prepare('SELECT * FROM daily_briefs WHERE user_id=? AND brief_date=CURRENT_DATE');
    $row->execute([$uid]);
    return $row->fetch();
}

/** Assemble a compact text snapshot of the user's day. */
function brief_context(int $uid): string
{
    $pdo   = db();
    $lines = [];
    $lines[] = 'Today is ' . date('l, j F Y') . '.';

    $t = $pdo->prepare("SELECT title, priority, due_date FROM todos
        WHERE user_id=? AND status IN ('todo','in_progress') AND (due_date IS NULL OR due_date <= CURRENT_DATE)
        ORDER BY (due_date IS NULL), due_date ASC LIMIT 15");
    $t->execute([$uid]);
    $todos = $t->fetchAll();
    $lines[] = "\nTasks due or overdue (" . count($todos) . '):';
    foreach ($todos as $row) {
        $lines[] = "- {$row['title']} [{$row['priority']}]" . ($row['due_date'] ? " due {$row['due_date']}" : '');
    }

    $h = $pdo->prepare("SELECT name FROM habits h
        WHERE user_id=? AND is_active=1
          AND NOT EXISTS (SELECT 1 FROM habit_logs hl WHERE hl.habit_id=h.id AND hl.logged_date=CURRENT_DATE)");
    $h->execute([$uid]);
    $unlogged = array_column($h->fetchAll(), 'name');
    $lines[] = "\nHabits not yet done today: " . ($unlogged ? implode(', ', $unlogged) : 'all done');

    $m = $pdo->prepare("SELECT COALESCE(SUM(amount),0) FROM expenses
        WHERE user_id=? AND type='expense' AND spent_at >= (CURRENT_DATE - INTERVAL 6 DAY)");
    $m->execute([$uid]);
    $lines[] = "\nSpent in the last 7 days: " . number_format((float) $m->fetchColumn(), 2);

    $b = $pdo->prepare("SELECT c.name, c.monthly_budget,
            COALESCE(SUM(CASE WHEN e.type='expense' THEN e.amount END),0) AS spent
        FROM expense_categories c
        LEFT JOIN expenses e ON e.category_id=c.id AND DATE_FORMAT(e.spent_at,'%Y-%m')=DATE_FORMAT(CURRENT_DATE,'%Y-%m')
        WHERE c.user_id=? AND c.monthly_budget IS NOT NULL
        GROUP BY c.id HAVING spent > c.monthly_budget * 0.8");
    $b->execute([$uid]);
    foreach ($b->fetchAll() as $row) {
        $lines[] = "- Budget alert: {$row['name']} at " . number_format((float) $row['spent'], 0) . " of {$row['monthly_budget']}";
    }

    $staleDays = (int) (get_setting($uid, 'stale_repo_days', '60') ?: 60);
    $r = $pdo->prepare('SELECT name, staleness_days FROM repos WHERE user_id=? AND staleness_days >= ? ORDER BY staleness_days DESC LIMIT 5');
    $r->execute([$uid, $staleDays]);
    $stale = $r->fetchAll();
    if ($stale) {
        $lines[] = "\nNeglected repos:";
        foreach ($stale as $row) {
            $lines[] = "- {$row['name']} ({$row['staleness_days']} days idle)";
        }
    }

    $g = $pdo->prepare("SELECT title, current_value, target_value, unit FROM goals WHERE user_id=? AND status='active' LIMIT 6");
    $g->execute([$uid]);
    $goals = $g->fetchAll();
    if ($goals) {
        $lines[] = "\nActive goals:";
        foreach ($goals as $row) {
            $lines[] = "- {$row['title']}: {$row['current_value']}" . ($row['target_value'] ? "/{$row['target_value']}" : '') . " {$row['unit']}";
        }
    }

    return implode("\n", $lines);
}

/* ================================================================== chat */

function chat_turn(int $uid, string $message, ?string $model = null, ?string $sessionId = null): array
{
    if ($message === '') {
        fail('Empty message.', 422);
    }

    // No session yet → this message starts a new conversation.
    $sid = ($sessionId !== null && $sessionId !== '' && mb_strlen($sessionId) <= 64)
        ? $sessionId
        : bin2hex(random_bytes(16));

    ensure_chat_session($uid, $sid, $message);
    save_chat($uid, $sid, 'user', $message, null);

    $system = chat_system_prompt($uid);
    $history = recent_chat_text($uid, $sid);
    // Session-only model override from the chat's selector — never persisted.
    $opts = ['max_tokens' => 1024];
    if ($model !== null && $model !== '' && mb_strlen($model) <= 100) {
        $opts['model'] = $model;
    }
    $reply   = ai_generate($uid, $system, $history, $opts);

    // Parse an optional trailing ```json { "actions": [...] } ``` block.
    [$clean, $actions] = split_actions($reply);
    $executed = [];
    foreach ($actions as $a) {
        $tool = $a['tool'] ?? ($a['action'] ?? null);
        $args = $a['args'] ?? $a;
        if (!is_string($tool) || !in_array($tool, CHAT_ACTIONS, true)) {
            $label = is_string($tool) ? $tool : '(missing tool name)';
            $executed[] = ['tool' => $label, 'error' => "Unknown action \"{$label}\" — not executed."];
            continue;
        }
        $summary = execute_chat_action($uid, $tool, is_array($args) ? $args : []);
        if ($summary !== null) {
            $executed[] = ['tool' => $tool, 'summary' => $summary];
        } else {
            $executed[] = ['tool' => $tool, 'error' => "Could not apply \"{$tool}\" — check the values and try again."];
        }
    }

    save_chat($uid, $sid, 'assistant', $clean, $executed ?: null);
    return ['reply' => $clean, 'actions' => $executed, 'session_id' => $sid];
}

/**
 * Upsert the session row: created (titled from the first user message) on the
 * first message, otherwise just bumps updated_at so listings sort by recency.
 */
function ensure_chat_session(int $uid, string $sid, string $firstMessage): void
{
    $title = mb_substr(trim((string) preg_replace('/\s+/', ' ', $firstMessage)), 0, 60);
    if ($title === '') {
        $title = 'New chat';
    }
    $stmt = db()->prepare(
        'INSERT INTO chat_sessions (user_id, session_id, title) VALUES (?,?,?)
         ON DUPLICATE KEY UPDATE updated_at = CURRENT_TIMESTAMP'
    );
    $stmt->execute([$uid, $sid, $title]);
}

/**
 * Give pre-sessions chat history (session_id='default') a session row so it
 * shows up in the history menu. INSERT IGNORE: never bumps an existing row.
 */
function backfill_legacy_session(int $uid): void
{
    $stmt = db()->prepare(
        "SELECT content FROM chat_messages WHERE user_id=? AND session_id='default' AND role='user' ORDER BY id ASC LIMIT 1"
    );
    $stmt->execute([$uid]);
    $first = $stmt->fetchColumn();
    if ($first === false) {
        return;
    }
    $title = mb_substr(trim((string) preg_replace('/\s+/', ' ', (string) $first)), 0, 60) ?: 'Earlier chat';
    $stmt = db()->prepare('INSERT IGNORE INTO chat_sessions (user_id, session_id, title) VALUES (?,?,?)');
    $stmt->execute([$uid, 'default', $title]);
}

/**
 * The single place the chat system prompt is built. Establishes what inphub
 * actually is (a self-hosted personal dashboard — no company, no support
 * team), injects the logged-in username, and appends a developer-mode block
 * for the owner/developer account (imInph).
 */
function chat_system_prompt(int $uid): string
{
    $user     = current_user();
    $username = $user['username'] ?? 'user';
    $display  = $user['display_name'] ?: $username;

    $identity = <<<TXT
You are the built-in assistant of "inphub", a single-user personal life dashboard
(todos, habits, expenses, notes, goals, focus sessions, GitHub repos).

Facts you must never contradict:
- inphub is self-hosted software running on the user's own machine, built and
  maintained by one person. It is not a commercial product or a service.
- There is no company, no support team, no ticketing system, and no other staff.
  Never offer to "escalate", "contact support", "check with the team", or open a
  ticket, and never invent product policies, plans, or terms of service.
- If something looks broken, say so plainly; the person who can fix it is the
  app's sole developer.

You are talking to "{$display}" (username: {$username}).
TXT;

    if ($username === 'imInph') {
        $identity .= "\n\n" . <<<TXT
Developer mode: this user is the sole developer and owner of inphub. Be technical
and direct. Discuss implementation details, the database schema, and code freely
(PHP + MySQL backend, TypeScript frontend). Skip end-user hand-holding and
disclaimers — treat them as a peer who wrote this codebase.
TXT;
    }

    $snapshot = brief_context($uid);
    $tools = <<<TXT
You can take actions on the user's data. When (and only when) the user asks you to change something,
append a single fenced code block at the very end of your reply, exactly like:

```json
{ "actions": [ { "tool": "add_todo", "args": { "title": "Buy milk", "priority": "high" } } ] }
```

Available tools and args:
- add_todo: { title, description?, priority?(low|medium|high|urgent), due_date?(YYYY-MM-DD), project? }
- complete_todo: { id }
- add_expense: { amount, type?(expense|income), description?, category_id?, spent_at?(YYYY-MM-DD) }
- log_habit: { id, date?(YYYY-MM-DD) }
- add_note: { content, title?, tags? }
- update_goal_progress: { id, delta }
- add_repo_suggestion: { repo_id, title, detail?, category?, priority? }

Only include the JSON block when you actually performed an action; otherwise omit it entirely.
Keep the conversational part short and friendly. Never invent ids — use ones present in the snapshot.
TXT;

    return "{$identity}\n\nHere is a snapshot of the user's current data:\n\n{$snapshot}\n\n{$tools}";
}

/** Recent conversation flattened to a single prompt string. */
function recent_chat_text(int $uid, string $sid): string
{
    $stmt = db()->prepare(
        'SELECT role, content FROM chat_messages WHERE user_id=? AND session_id=?
         ORDER BY id DESC LIMIT 12'
    );
    $stmt->execute([$uid, $sid]);
    $rows = array_reverse($stmt->fetchAll());
    $out = [];
    foreach ($rows as $r) {
        $out[] = ($r['role'] === 'user' ? 'User' : 'Assistant') . ': ' . $r['content'];
    }
    $out[] = 'Assistant:';
    return implode("\n\n", $out);
}

function save_chat(int $uid, string $sid, string $role, string $content, ?array $actions): void
{
    $stmt = db()->prepare(
        'INSERT INTO chat_messages (user_id, session_id, role, content, actions)
         VALUES (?, ?, ?, ?, ?)'
    );
    $stmt->execute([$uid, $sid, $role, $content, $actions !== null ? json_encode($actions, JSON_UNESCAPED_UNICODE) : null]);
}

/**
 * Split a reply into [conversationalText, actionsArray]. Tolerates a fenced
 * ```json block or a bare {"actions":...} object at the end.
 */
function split_actions(string $reply): array
{
    $actions = [];
    $clean   = $reply;

    if (preg_match('/```(?:json)?\s*(\{.*?\})\s*```/is', $reply, $mm)) {
        $decoded = json_decode($mm[1], true);
        if (is_array($decoded) && isset($decoded['actions']) && is_array($decoded['actions'])) {
            $actions = $decoded['actions'];
            $clean = trim(str_replace($mm[0], '', $reply));
        }
    }
    if ($clean === '') {
        $clean = 'Done.';
    }
    return [$clean, $actions];
}

/**
 * Execute a single whitelisted chat action, scoped to the user. Returns a short
 * human summary, or null if the action could not be applied. Logs actor='ai'.
 */
function execute_chat_action(int $uid, string $tool, array $args): ?string
{
    $pdo = db();
    try {
        switch ($tool) {
            case 'add_todo': {
                $title = trim((string) ($args['title'] ?? ''));
                if ($title === '') return null;
                $stmt = $pdo->prepare(
                    'INSERT INTO todos (user_id, title, description, priority, project, due_date, created_by)
                     VALUES (?, ?, ?, ?, ?, ?, "ai")'
                );
                $stmt->execute([
                    $uid, $title,
                    isset($args['description']) ? (string) $args['description'] : null,
                    valid_enum($args['priority'] ?? 'medium', ['low', 'medium', 'high', 'urgent'], 'medium'),
                    isset($args['project']) ? (string) $args['project'] : null,
                    isset($args['due_date']) ? (string) $args['due_date'] : null,
                ]);
                $id = (int) $pdo->lastInsertId();
                log_activity($uid, 'todo.created', 'todo', $id, 'Added todo: ' . $title, 'ai');
                return 'Added todo “' . $title . '”';
            }
            case 'complete_todo': {
                $id = (int) ($args['id'] ?? 0);
                $chk = $pdo->prepare('SELECT title FROM todos WHERE id=? AND user_id=?');
                $chk->execute([$id, $uid]);
                $title = $chk->fetchColumn();
                if ($title === false) return null;
                $pdo->prepare("UPDATE todos SET status='done', completed_at=NOW() WHERE id=? AND user_id=?")->execute([$id, $uid]);
                log_activity($uid, 'todo.completed', 'todo', $id, 'Completed: ' . $title, 'ai');
                return 'Completed “' . $title . '”';
            }
            case 'add_expense': {
                $amount = isset($args['amount']) ? (float) $args['amount'] : null;
                if ($amount === null || $amount <= 0) return null;
                $type = valid_enum($args['type'] ?? 'expense', ['expense', 'income'], 'expense');
                $catId = isset($args['category_id']) ? (int) $args['category_id'] : null;
                if ($catId !== null) {
                    $own = $pdo->prepare('SELECT 1 FROM expense_categories WHERE id=? AND user_id=?');
                    $own->execute([$catId, $uid]);
                    if ($own->fetchColumn() === false) $catId = null;
                }
                $currency = (string) (get_setting($uid, 'base_currency', 'TRY') ?: 'TRY');
                $stmt = $pdo->prepare(
                    'INSERT INTO expenses (user_id, type, amount, currency, category_id, description, spent_at, created_by)
                     VALUES (?, ?, ?, ?, ?, ?, ?, "ai")'
                );
                $stmt->execute([
                    $uid, $type, $amount, $currency, $catId,
                    isset($args['description']) ? (string) $args['description'] : null,
                    isset($args['spent_at']) ? (string) $args['spent_at'] : today(),
                ]);
                $id = (int) $pdo->lastInsertId();
                log_activity($uid, 'expense.created', 'expense', $id, ($type === 'income' ? 'Income ' : 'Spent ') . $amount, 'ai');
                return ($type === 'income' ? 'Logged income ' : 'Logged expense ') . number_format($amount, 2);
            }
            case 'log_habit': {
                $id = (int) ($args['id'] ?? 0);
                $chk = $pdo->prepare('SELECT name FROM habits WHERE id=? AND user_id=?');
                $chk->execute([$id, $uid]);
                $name = $chk->fetchColumn();
                if ($name === false) return null;
                $date = isset($args['date']) ? (string) $args['date'] : today();
                $exists = $pdo->prepare('SELECT id FROM habit_logs WHERE habit_id=? AND logged_date=?');
                $exists->execute([$id, $date]);
                if ($exists->fetchColumn() !== false) return 'Habit “' . $name . '” already logged';
                $pdo->prepare('INSERT INTO habit_logs (user_id, habit_id, logged_date, count) VALUES (?, ?, ?, 1)')
                    ->execute([$uid, $id, $date]);
                log_activity($uid, 'habit.logged', 'habit', $id, 'Logged habit: ' . $name, 'ai');
                return 'Logged habit “' . $name . '”';
            }
            case 'add_note': {
                $content = trim((string) ($args['content'] ?? ''));
                if ($content === '') return null;
                $stmt = $pdo->prepare('INSERT INTO notes (user_id, title, content, tags) VALUES (?, ?, ?, ?)');
                $stmt->execute([
                    $uid,
                    isset($args['title']) ? (string) $args['title'] : null,
                    $content,
                    isset($args['tags']) ? (string) $args['tags'] : null,
                ]);
                $id = (int) $pdo->lastInsertId();
                log_activity($uid, 'note.created', 'note', $id, 'New note', 'ai');
                return 'Saved a note';
            }
            case 'update_goal_progress': {
                $id = (int) ($args['id'] ?? 0);
                $delta = (int) ($args['delta'] ?? 0);
                $g = $pdo->prepare('SELECT title, current_value, target_value, unit, status FROM goals WHERE id=? AND user_id=?');
                $g->execute([$id, $uid]);
                $goal = $g->fetch();
                if (!$goal) return null;
                $newValue = max(0, (int) $goal['current_value'] + $delta);
                $status = $goal['status'];
                if ($goal['target_value'] !== null && $newValue >= (int) $goal['target_value'] && $status === 'active') {
                    $status = 'completed';
                }
                $pdo->prepare('UPDATE goals SET current_value=?, status=? WHERE id=? AND user_id=?')->execute([$newValue, $status, $id, $uid]);
                log_activity($uid, 'goal.progress', 'goal', $id, $goal['title'] . " → $newValue", 'ai');
                return 'Updated goal “' . $goal['title'] . '” to ' . $newValue;
            }
            case 'add_repo_suggestion': {
                $repoId = (int) ($args['repo_id'] ?? 0);
                $title  = trim((string) ($args['title'] ?? ''));
                if ($title === '') return null;
                $own = $pdo->prepare('SELECT 1 FROM repos WHERE id=? AND user_id=?');
                $own->execute([$repoId, $uid]);
                if ($own->fetchColumn() === false) return null;
                $stmt = $pdo->prepare(
                    'INSERT INTO repo_suggestions (user_id, repo_id, title, detail, category, priority)
                     VALUES (?, ?, ?, ?, ?, ?)'
                );
                $stmt->execute([
                    $uid, $repoId, $title,
                    isset($args['detail']) ? (string) $args['detail'] : null,
                    valid_enum($args['category'] ?? 'other', ['feature', 'docs', 'refactor', 'testing', 'ci', 'security', 'other'], 'other'),
                    valid_enum($args['priority'] ?? 'medium', ['low', 'medium', 'high'], 'medium'),
                ]);
                return 'Added a repo suggestion';
            }
        }
    } catch (Throwable $e) {
        return null;
    }
    return null;
}

/* ========================================================= repo analysis */

/** When this repo was last AI-analyzed (newest suggestion timestamp), or null. */
function repo_last_analyzed(int $uid, int $repoId): ?string
{
    $stmt = db()->prepare('SELECT MAX(created_at) FROM repo_suggestions WHERE repo_id=? AND user_id=?');
    $stmt->execute([$repoId, $uid]);
    $ts = $stmt->fetchColumn();
    return is_string($ts) && $ts !== '' ? $ts : null;
}

function analyze_repo(int $uid, array $repo): array
{
    $meta = "Repository: {$repo['full_name']}\n"
        . 'Language: ' . ($repo['language'] ?? 'unknown') . "\n"
        . 'Description: ' . ($repo['description'] ?? '(none)') . "\n"
        . 'Stars: ' . $repo['stars'] . ', open issues: ' . $repo['open_issues'] . "\n"
        . 'Has README: ' . ($repo['has_readme'] ? 'yes' : 'no') . ', has license: ' . ($repo['has_license'] ? 'yes' : 'no') . "\n"
        . 'Days since last push: ' . ($repo['staleness_days'] ?? 'unknown') . "\n\n"
        . "README excerpt:\n" . (substr((string) ($repo['readme_excerpt'] ?? ''), 0, 2500) ?: '(no README)');

    $system = 'You are a senior engineer reviewing a GitHub repository. Suggest 3-5 concrete, high-value '
        . 'improvements. Respond ONLY with a JSON array, no prose, each item: '
        . '{ "title": string, "detail": string, "category": one of feature|docs|refactor|testing|ci|security|other, '
        . '"priority": one of low|medium|high }.';

    $raw = ai_generate($uid, $system, $meta, ['max_tokens' => 900]);
    $items = parse_json_array($raw);

    // A garbled model reply must not wipe the previous analysis.
    if (!$items) {
        throw new RuntimeException("The model returned no usable suggestions for {$repo['name']} — kept the previous analysis.");
    }

    // Replace previous open suggestions so re-analysis stays tidy.
    db()->prepare("DELETE FROM repo_suggestions WHERE repo_id=? AND user_id=? AND status='open'")->execute([(int) $repo['id'], $uid]);

    $ins = db()->prepare(
        'INSERT INTO repo_suggestions (user_id, repo_id, title, detail, category, priority)
         VALUES (?, ?, ?, ?, ?, ?)'
    );
    $saved = 0;
    foreach ($items as $it) {
        $title = trim((string) ($it['title'] ?? ''));
        if ($title === '') continue;
        $ins->execute([
            $uid, (int) $repo['id'], $title,
            isset($it['detail']) ? (string) $it['detail'] : null,
            valid_enum($it['category'] ?? 'other', ['feature', 'docs', 'refactor', 'testing', 'ci', 'security', 'other'], 'other'),
            valid_enum($it['priority'] ?? 'medium', ['low', 'medium', 'high'], 'medium'),
        ]);
        $saved++;
    }
    log_activity($uid, 'ai.repo_analyzed', 'repo', (int) $repo['id'], "Analyzed {$repo['name']}: $saved suggestions", 'ai');

    $out = db()->prepare('SELECT * FROM repo_suggestions WHERE repo_id=? AND user_id=? ORDER BY id DESC');
    $out->execute([(int) $repo['id'], $uid]);
    return $out->fetchAll();
}

/* ============================================================= quick add */

/**
 * Route free text to the right table. With AI on, ask the model to classify;
 * with AI off, fall back to simple prefix parsing.
 */
function quick_add(int $uid, string $text): array
{
    $text = trim($text);
    if ($text === '') {
        fail('Nothing to add.', 422);
    }

    $parsed = ai_available($uid) ? quick_add_ai($uid, $text) : quick_add_prefix($text);
    if ($parsed === null) {
        // Last-resort default: a note.
        $parsed = ['kind' => 'note', 'content' => $text];
    }

    $kind = $parsed['kind'] ?? 'note';
    switch ($kind) {
        case 'todo': {
            $stmt = db()->prepare('INSERT INTO todos (user_id, title, priority, due_date, created_by) VALUES (?, ?, ?, ?, "ai")');
            $stmt->execute([
                $uid, $parsed['title'] ?? $text,
                valid_enum($parsed['priority'] ?? 'medium', ['low', 'medium', 'high', 'urgent'], 'medium'),
                $parsed['due_date'] ?? null,
            ]);
            $id = (int) db()->lastInsertId();
            log_activity($uid, 'todo.created', 'todo', $id, 'Added todo: ' . ($parsed['title'] ?? $text), 'ai');
            return ['kind' => 'todo', 'id' => $id, 'summary' => 'Added a task'];
        }
        case 'expense': {
            $amount = isset($parsed['amount']) ? (float) $parsed['amount'] : 0.0;
            if ($amount <= 0) {
                return ['kind' => 'note', 'id' => save_quick_note($uid, $text), 'summary' => 'Saved as a note'];
            }
            $currency = (string) (get_setting($uid, 'base_currency', 'TRY') ?: 'TRY');
            $stmt = db()->prepare('INSERT INTO expenses (user_id, type, amount, currency, description, spent_at, created_by) VALUES (?, ?, ?, ?, ?, ?, "ai")');
            $stmt->execute([
                $uid,
                valid_enum($parsed['type'] ?? 'expense', ['expense', 'income'], 'expense'),
                $amount, $currency,
                $parsed['description'] ?? $text,
                $parsed['spent_at'] ?? today(),
            ]);
            $id = (int) db()->lastInsertId();
            log_activity($uid, 'expense.created', 'expense', $id, 'Spent ' . $amount, 'ai');
            return ['kind' => 'expense', 'id' => $id, 'summary' => 'Logged an expense'];
        }
        case 'note':
        default:
            return ['kind' => 'note', 'id' => save_quick_note($uid, $parsed['content'] ?? $text, $parsed['title'] ?? null), 'summary' => 'Saved a note'];
    }
}

function save_quick_note(int $uid, string $content, ?string $title = null): int
{
    $stmt = db()->prepare('INSERT INTO notes (user_id, title, content) VALUES (?, ?, ?)');
    $stmt->execute([$uid, $title, $content]);
    $id = (int) db()->lastInsertId();
    log_activity($uid, 'note.created', 'note', $id, 'Quick note', 'ai');
    return $id;
}

function quick_add_ai(int $uid, string $text): ?array
{
    $system = 'Classify the user\'s quick-capture text into one of: todo, expense, note. '
        . 'Respond ONLY with JSON. Shapes: '
        . '{"kind":"todo","title":string,"priority"?:low|medium|high|urgent,"due_date"?:YYYY-MM-DD} | '
        . '{"kind":"expense","amount":number,"type"?:expense|income,"description"?:string} | '
        . '{"kind":"note","title"?:string,"content":string}. Today is ' . date('Y-m-d') . '.';
    try {
        $raw = ai_generate($uid, $system, $text, ['max_tokens' => 300]);
        $obj = json_decode(extract_json_object($raw), true);
        return is_array($obj) ? $obj : null;
    } catch (Throwable $e) {
        return quick_add_prefix($text);
    }
}

/** Offline fallback: "todo: …", "note: …", "spent 12 on lunch", "income 100 …". */
function quick_add_prefix(string $text): ?array
{
    if (preg_match('/^todo:\s*(.+)$/i', $text, $m)) {
        return ['kind' => 'todo', 'title' => trim($m[1])];
    }
    if (preg_match('/^note:\s*(.+)$/i', $text, $m)) {
        return ['kind' => 'note', 'content' => trim($m[1])];
    }
    if (preg_match('/^(spent|paid)\s+([0-9]+(?:\.[0-9]+)?)\s*(?:on\s+)?(.*)$/i', $text, $m)) {
        return ['kind' => 'expense', 'type' => 'expense', 'amount' => (float) $m[2], 'description' => trim($m[3]) ?: null];
    }
    if (preg_match('/^(income|earned|got)\s+([0-9]+(?:\.[0-9]+)?)\s*(?:from\s+)?(.*)$/i', $text, $m)) {
        return ['kind' => 'expense', 'type' => 'income', 'amount' => (float) $m[2], 'description' => trim($m[3]) ?: null];
    }
    return null;
}

/* ========================================================= weekly review */

function weekly_review(int $uid): string
{
    $stmt = db()->prepare(
        'SELECT type, summary, actor, created_at FROM activity_log
         WHERE user_id=? AND created_at >= (CURRENT_DATE - INTERVAL 7 DAY)
         ORDER BY created_at ASC LIMIT 300'
    );
    $stmt->execute([$uid]);
    $rows = $stmt->fetchAll();
    if (!$rows) {
        return "_No activity in the last 7 days._";
    }
    $lines = [];
    foreach ($rows as $r) {
        $lines[] = substr($r['created_at'], 0, 10) . " [{$r['type']}] {$r['summary']}";
    }
    $system = 'You are reviewing the user\'s past week from their activity log. Write a warm, honest weekly '
        . 'review in markdown: a short summary sentence, "Wins" and "Watch-outs" sections as bullets, and one '
        . 'concrete suggestion for next week. Be specific to the data; keep it under 250 words.';
    return ai_generate($uid, $system, implode("\n", $lines), ['max_tokens' => 700]);
}

/* ============================================================== JSON utils */

/** Extract the first JSON object substring from arbitrary model text. */
function extract_json_object(string $text): string
{
    if (preg_match('/```(?:json)?\s*(\{.*?\})\s*```/is', $text, $m)) {
        return $m[1];
    }
    $start = strpos($text, '{');
    $end   = strrpos($text, '}');
    if ($start !== false && $end !== false && $end > $start) {
        return substr($text, $start, $end - $start + 1);
    }
    return $text;
}

/** Parse a JSON array from arbitrary model text (fenced or bare). */
function parse_json_array(string $text): array
{
    if (preg_match('/```(?:json)?\s*(\[.*?\])\s*```/is', $text, $m)) {
        $text = $m[1];
    } else {
        $start = strpos($text, '[');
        $end   = strrpos($text, ']');
        if ($start !== false && $end !== false && $end > $start) {
            $text = substr($text, $start, $end - $start + 1);
        }
    }
    $decoded = json_decode($text, true);
    return is_array($decoded) ? $decoded : [];
}
