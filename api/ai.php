<?php
/**
 * inphub: AI features (all gated on ai_available()).
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
 *  before api_handle() runs the request, top-level consts are not hoisted. */
const CHAT_ACTIONS = [
    // todos
    'add_todo', 'complete_todo', 'update_todo',
    // habits
    'add_habit', 'log_habit', 'unlog_habit',
    // goals
    'add_goal', 'update_goal_progress', 'set_goal_status',
    // notes
    'add_note', 'update_note',
    // money
    'add_expense', 'update_expense', 'delete_expense',
    // repos
    'add_repo_suggestion',
];

/**
 * Entities the chat may address, for chat_resolve(). Table and column names
 * come from this map only, never from model output, so they are safe to
 * interpolate, exactly like OWNED_TABLES in api/_bootstrap.php.
 */
const CHAT_ENTITIES = [
    'todo'     => ['table' => 'todos',              'name' => 'title',       'where' => "status <> 'archived'", 'label' => 'task'],
    'habit'    => ['table' => 'habits',             'name' => 'name',        'where' => 'is_active = 1',        'label' => 'habit'],
    'goal'     => ['table' => 'goals',              'name' => 'title',       'where' => '',                     'label' => 'goal'],
    'note'     => ['table' => 'notes',              'name' => 'title',       'where' => '',                     'label' => 'note'],
    'expense'  => ['table' => 'expenses',           'name' => 'description', 'where' => '',                     'label' => 'entry'],
    'repo'     => ['table' => 'repos',              'name' => 'name',        'where' => '',                     'label' => 'repository'],
    'category' => ['table' => 'expense_categories', 'name' => 'name',        'where' => '',                     'label' => 'category'],
];

/**
 * A chat action that could not be applied, carrying a message written FOR THE
 * MODEL to read on the next turn (the reason is fed back through the
 * transcript) as well as for the user. Replaces the old "return null", which
 * collapsed every distinct failure into one unactionable error.
 */
class ChatActionError extends RuntimeException
{
}

/** Repo AI analysis cooldown, cached suggestions are served within this window. */
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
                // No session requested, resume the most recent conversation.
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

            // Serve the cached analysis inside the cooldown window (unless forced),
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
    $model    = ai_active_model($c);

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

/**
 * Assemble a compact text snapshot of the user's day.
 *
 * $withIds adds the row ids the chat's action tools need (complete_todo,
 * log_habit, update_goal_progress and add_expense's category all take an id,
 * and the prompt forbids guessing one). The daily brief passes false, ids are
 * noise in prose the user reads.
 */
function brief_context(int $uid, bool $withIds = false): string
{
    $pdo   = db();
    $lines = [];
    $lines[] = 'Today is ' . date('l, j F Y') . '.';

    $t = $pdo->prepare("SELECT id, title, priority, due_date FROM todos
        WHERE user_id=? AND status IN ('todo','in_progress') AND (due_date IS NULL OR due_date <= CURRENT_DATE)
        ORDER BY (due_date IS NULL), due_date ASC LIMIT 15");
    $t->execute([$uid]);
    $todos = $t->fetchAll();
    $lines[] = "\nTasks due or overdue (" . count($todos) . '):';
    foreach ($todos as $row) {
        $lines[] = '- ' . ($withIds ? "[id {$row['id']}] " : '') . $row['title']
            . " [{$row['priority']}]" . ($row['due_date'] ? " due {$row['due_date']}" : '');
    }

    if ($withIds) {
        // Chat needs every active habit (with its id), not just the unlogged
        // ones: "log my reading habit" must resolve even when it is already done.
        $h = $pdo->prepare("SELECT h.id, h.name,
                EXISTS (SELECT 1 FROM habit_logs hl WHERE hl.habit_id=h.id AND hl.logged_date=CURRENT_DATE) AS done
            FROM habits h WHERE h.user_id=? AND h.is_active=1 ORDER BY h.sort_order ASC, h.id ASC");
        $h->execute([$uid]);
        $lines[] = "\nHabits (today):";
        foreach ($h->fetchAll() as $row) {
            $lines[] = "- [id {$row['id']}] {$row['name']} — " . ($row['done'] ? 'already logged today' : 'not yet done today');
        }
    } else {
        $h = $pdo->prepare("SELECT name FROM habits h
            WHERE user_id=? AND is_active=1
              AND NOT EXISTS (SELECT 1 FROM habit_logs hl WHERE hl.habit_id=h.id AND hl.logged_date=CURRENT_DATE)");
        $h->execute([$uid]);
        $unlogged = array_column($h->fetchAll(), 'name');
        $lines[] = "\nHabits not yet done today: " . ($unlogged ? implode(', ', $unlogged) : 'all done');
    }

    $currency = default_currency($uid);
    $m = $pdo->prepare("SELECT COALESCE(SUM(amount),0) FROM expenses
        WHERE user_id=? AND type='expense' AND spent_at >= (CURRENT_DATE - INTERVAL 6 DAY)");
    $m->execute([$uid]);
    // Units and boundary dates, always: a bare "2,000.00" reads as dollars,
    // and "last 7 days" alone leaves the model guessing at the window.
    $lines[] = "\nSpent from " . date('Y-m-d', strtotime('-6 day')) . ' to ' . date('Y-m-d')
        . ' (7 days including today): ' . money_text((float) $m->fetchColumn(), $currency);

    $b = $pdo->prepare("SELECT c.name, c.monthly_budget,
            COALESCE(SUM(CASE WHEN e.type='expense' THEN e.amount END),0) AS spent
        FROM expense_categories c
        LEFT JOIN expenses e ON e.category_id=c.id AND e.user_id=c.user_id AND DATE_FORMAT(e.spent_at,'%Y-%m')=DATE_FORMAT(CURRENT_DATE,'%Y-%m')
        WHERE c.user_id=? AND c.monthly_budget IS NOT NULL
        GROUP BY c.id HAVING spent > c.monthly_budget * 0.8");
    $b->execute([$uid]);
    foreach ($b->fetchAll() as $row) {
        $lines[] = '- Budget alert (' . date('F Y') . ', month to date): ' . $row['name'] . ' at '
            . money_text((float) $row['spent'], $currency) . ' of '
            . money_text((float) $row['monthly_budget'], $currency);
    }

    if ($withIds) {
        $c = $pdo->prepare('SELECT id, name FROM expense_categories WHERE user_id=? ORDER BY name ASC');
        $c->execute([$uid]);
        $cats = [];
        foreach ($c->fetchAll() as $row) {
            $cats[] = "[id {$row['id']}] {$row['name']}";
        }
        if ($cats) {
            $lines[] = "\nExpense categories: " . implode(', ', $cats);
        }
    }

    $staleDays = (int) (get_setting($uid, 'stale_repo_days', '60') ?: 60);
    $r = $pdo->prepare('SELECT id, name, staleness_days FROM repos WHERE user_id=? AND staleness_days >= ? ORDER BY staleness_days DESC LIMIT 5');
    $r->execute([$uid, $staleDays]);
    $stale = $r->fetchAll();
    if ($stale) {
        $lines[] = "\nNeglected repos:";
        foreach ($stale as $row) {
            $lines[] = '- ' . ($withIds ? "[id {$row['id']}] " : '') . $row['name'] . " ({$row['staleness_days']} days idle)";
        }
    }

    $g = $withIds
        ? $pdo->prepare("SELECT id, title, current_value, target_value, unit, status FROM goals
                         WHERE user_id=? AND status IN ('active','paused') ORDER BY status ASC, id ASC LIMIT 8")
        : $pdo->prepare("SELECT id, title, current_value, target_value, unit FROM goals WHERE user_id=? AND status='active' LIMIT 6");
    $g->execute([$uid]);
    $goals = $g->fetchAll();
    if ($goals) {
        $lines[] = "\nActive goals:";
        foreach ($goals as $row) {
            $lines[] = '- ' . ($withIds ? "[id {$row['id']}] " : '') . $row['title'] . ': ' . $row['current_value']
                . ($row['target_value'] ? "/{$row['target_value']}" : '') . ' ' . $row['unit']
                . (isset($row['status']) && $row['status'] !== 'active' ? ' (' . $row['status'] . ')' : '');
        }
    }

    if ($withIds) {
        // update_note and update_expense/delete_expense can only work on rows
        // whose ids the model can see, so the chat snapshot lists recent ones.
        $n = $pdo->prepare('SELECT id, title, LEFT(content, 60) AS preview FROM notes
                            WHERE user_id=? ORDER BY pinned DESC, updated_at DESC LIMIT 8');
        $n->execute([$uid]);
        $notes = $n->fetchAll();
        if ($notes) {
            $lines[] = "\nRecent notes:";
            foreach ($notes as $row) {
                $label = str_or_null($row['title']) ?? (preg_replace('/\s+/', ' ', (string) $row['preview']) . '…');
                $lines[] = "- [id {$row['id']}] {$label}";
            }
        }

        $e = $pdo->prepare('SELECT e.id, e.type, e.amount, e.currency, e.spent_at, e.description, c.name AS category
                            FROM expenses e LEFT JOIN expense_categories c ON c.id = e.category_id AND c.user_id = e.user_id
                            WHERE e.user_id=? ORDER BY e.spent_at DESC, e.id DESC LIMIT 8');
        $e->execute([$uid]);
        $recent = $e->fetchAll();
        if ($recent) {
            $lines[] = "\nMost recent money entries (newest first):";
            foreach ($recent as $row) {
                $lines[] = "- [id {$row['id']}] {$row['spent_at']} "
                    . ($row['type'] === 'income' ? 'income ' : 'expense ')
                    . money_text((float) $row['amount'], (string) $row['currency'])
                    . ($row['description'] ? ' — ' . $row['description'] : '')
                    . ($row['category'] ? ' (' . $row['category'] . ')' : '');
            }
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
    // Session-only model override from the chat's selector, never persisted.
    $opts = ['max_tokens' => 1024];
    if ($model !== null && $model !== '' && mb_strlen($model) <= 100) {
        $opts['model'] = $model;
    }
    $reply   = ai_generate($uid, $system, $history, $opts);

    // Parse an optional trailing ```json { "actions": [...] } ``` block.
    [$clean, $actions] = split_actions($reply);
    $executed = [];
    foreach ($actions as $a) {
        $tool = $a['tool'] ?? $a['action'] ?? $a['name'] ?? null;
        $args = $a['args'] ?? $a['arguments'] ?? $a['parameters'] ?? $a;
        if (!is_string($tool) || !in_array($tool, CHAT_ACTIONS, true)) {
            $label = is_string($tool) ? $tool : '(missing tool name)';
            $executed[] = ['tool' => $label, 'error' => "Unknown action \"{$label}\" — not executed."];
            continue;
        }
        try {
            $executed[] = ['tool' => $tool, 'summary' => execute_chat_action($uid, $tool, is_array($args) ? $args : [])];
        } catch (ChatActionError $e) {
            // A described failure: the user sees why, and so does the model on
            // the next turn (recent_chat_text replays it).
            $executed[] = ['tool' => $tool, 'error' => $e->getMessage()];
        } catch (Throwable $e) {
            $executed[] = ['tool' => $tool, 'error' => "Could not apply \"{$tool}\": " . $e->getMessage()];
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
 * actually is (a self-hosted personal dashboard, no company, no support
 * team), injects the logged-in username, and appends a developer-mode block
 * for the account named by 'developer_user' in config/config.php (empty = off).
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

    $devUser = trim((string) app_config('developer_user', ''));
    if ($devUser !== '' && $username === $devUser) {
        $identity .= "\n\n" . <<<TXT
Developer mode: this user is the sole developer and owner of inphub. Be technical
and direct. Discuss implementation details, the database schema, and code freely
(PHP + MySQL backend, TypeScript frontend). Skip end-user hand-holding and
disclaimers — treat them as a peer who wrote this codebase.
TXT;
    }

    $snapshot = brief_context($uid, true);
    // Small local models (gemma, phi, qwen) need the mechanism spelled out:
    // the old wording said "only include the JSON when you actually performed
    // an action", which reads as "you cannot act" and made them skip the block
    // entirely. Emitting the block IS the action, say so, then show it.
    $tomorrow = date('Y-m-d', strtotime('+1 day'));
    $today    = date('Y-m-d');
    $currency = default_currency($uid);
    $tools = <<<TXT
HOW TO CHANGE THE USER'S DATA

You can create and update the user's data, but only by writing one JSON block
at the end of your reply. There is no other mechanism: you cannot click
buttons and you have no separate tool interface. Writing the block IS how the
change happens — the app reads it, applies it, and shows the user the result.

So when the user asks for a change, write the block in that same reply. Never
reply that you are unable to change their data, never promise to do it later,
and never ask the user to do it by hand.

RULES — follow them exactly:
1. Write your short reply in plain sentences first.
2. Then put ONE fenced block as the very last thing in your message.
3. The fence is three backticks followed by the word json. Never use
   tool_code, tool_call, python, or any other tag.
4. Write nothing after the closing fence — no explanation, no second block.
5. "actions" is always a list, even for a single change. To make several
   changes at once, put several objects in the same list.
6. Use the tool names below spelled exactly. Do not invent new ones.
7. Every id must be copied from the snapshot above. If what the user means is
   not in the snapshot, say so and ask which one they mean — never guess an id
   and never make one up.
8. If the user is only chatting or asking a question, write NO block at all.

TOOLS

You can reach every part of the app, not just tasks. Anywhere an id is asked
for you may instead give the exact name — "id" is more reliable, so prefer it
when the snapshot shows one.

Tasks
- add_todo — add a task.
    required: title. optional: description, priority (low|medium|high|urgent),
    due_date (YYYY-MM-DD), project
- complete_todo — mark a task done.
    required: id (or title)
- update_todo — change an existing task.
    required: id (or title, to identify it)
    optional: new_title (to rename), description, priority, due_date, project,
    status (todo|in_progress|done|archived). Use status "archived" to get a
    task out of the way instead of deleting it.

Habits
- add_habit — start tracking a new habit.
    required: name. optional: description, frequency (daily|weekly), target_per_period
- log_habit — mark a habit done.
    required: id (or name). optional: date (defaults to today)
- unlog_habit — undo a habit log, e.g. logged by mistake.
    required: id (or name). optional: date (defaults to today)

Goals
- add_goal — create a goal.
    required: title. optional: description, category, target_value (number),
    unit, target_date (YYYY-MM-DD)
- update_goal_progress — move a goal's progress.
    required: id (or title), delta (number; negative to go back). Reaching the
    target completes the goal automatically.
- set_goal_status — pause, resume or finish a goal.
    required: id (or title), status (active|paused|completed)

Notes
- add_note — save a new note.
    required: content. optional: title, tags
- update_note — change or extend an existing note.
    required: id (or title)
    optional: content, append (true to add to the end instead of replacing),
    new_title, tags

Money
- add_expense — record money spent or received.
    required: amount (plain number, currency as stated at the top)
    optional: type (expense|income, defaults to expense), description,
    category (name) or category_id, spent_at (YYYY-MM-DD)
- update_expense — correct an entry.
    required: id
    optional: amount, type, description, category, spent_at
- delete_expense — remove an entry, e.g. a duplicate.
    required: id (a numeric id only — a name is refused here on purpose)

Repositories
- add_repo_suggestion — attach a suggestion to a repo.
    required: repo_id (or name), title
    optional: detail, category (feature|docs|refactor|testing|ci|security|other),
    priority (low|medium|high)

EXAMPLES

User: remind me to call the dentist tomorrow
Assistant: Added it for tomorrow.
```json
{"actions": [{"tool": "add_todo", "args": {"title": "Call the dentist", "due_date": "{$tomorrow}"}}]}
```

User: i finished the taxes task
(the snapshot shows: - [id 12] Do the taxes [high])
Assistant: Nice one — marked it done.
```json
{"actions": [{"tool": "complete_todo", "args": {"id": 12}}]}
```

User: spent 250 on coffee today, and i did my reading
(the snapshot shows: - [id 3] Read — not yet done today)
Assistant: Logged the coffee and ticked off your reading.
```json
{"actions": [{"tool": "add_expense", "args": {"amount": 250, "description": "Coffee"}}, {"tool": "log_habit", "args": {"id": 3}}]}
```

User: i read for 20 minutes and pausing the gym goal for now
(the snapshot shows: - [id 3] Read — not yet done today, and - [id 2] Gym 3x a week)
Assistant: Logged your reading and paused the gym goal.
```json
{"actions": [{"tool": "log_habit", "args": {"id": 3}}, {"tool": "set_goal_status", "args": {"id": 2, "status": "paused"}}]}
```

User: that coffee was actually 180 not 250
(the snapshot shows: - [id 91] {$today} expense 250.00 {$currency} — Coffee)
Assistant: Fixed it to 180.
```json
{"actions": [{"tool": "update_expense", "args": {"id": 91, "amount": 180}}]}
```

User: add to my cubing note that the springs help
(the snapshot shows: - [id 7] Cube setup)
Assistant: Added that to the note.
```json
{"actions": [{"tool": "update_note", "args": {"id": 7, "content": "Lighter springs help.", "append": true}}]}
```

User: how much did i spend this week?
Assistant: (answers from the snapshot, with no JSON block at all)

If an action fails, the app tells you why on the next turn. Read that reason,
fix the arguments (usually an id) and try once more, or ask the user which item
they meant. Do not silently repeat the same failing call.

Keep the conversational part short and friendly.
TXT;

    return "{$identity}\n\nHere is a snapshot of the user's current data:\n\n{$snapshot}\n\n{$tools}";
}

/** Recent conversation flattened to a single prompt string. */
function recent_chat_text(int $uid, string $sid): string
{
    $stmt = db()->prepare(
        'SELECT role, content, actions FROM chat_messages WHERE user_id=? AND session_id=?
         ORDER BY id DESC LIMIT 12'
    );
    $stmt->execute([$uid, $sid]);
    $rows = array_reverse($stmt->fetchAll());
    $out = [];
    foreach ($rows as $r) {
        $out[] = ($r['role'] === 'user' ? 'User' : 'Assistant') . ': ' . $r['content'];

        // Replay what each earlier action actually did. Without this the model
        // cannot tell a success from a failure it should retry differently,
        // it only ever saw its own optimistic wording.
        $acts = $r['actions'] ? json_decode((string) $r['actions'], true) : null;
        if (is_array($acts) && $acts) {
            $notes = [];
            foreach ($acts as $a) {
                if (!is_array($a)) {
                    continue;
                }
                $tool = (string) ($a['tool'] ?? 'action');
                $notes[] = isset($a['error'])
                    ? "{$tool} FAILED: {$a['error']}"
                    : "{$tool} OK: " . (string) ($a['summary'] ?? 'done');
            }
            if ($notes) {
                $out[] = '(system: result of those actions — ' . implode(' | ', $notes) . ')';
            }
        }
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

    // Be liberal about the shape. The prompt asks for one ```json block of
    // {"actions":[...]}, but small local models routinely emit a different
    // fence tag (gemma likes ```tool_code), no fence at all, a single bare
    // action object, or a plain array. Rejecting those silently dropped the
    // user's request AND left the raw JSON in the visible reply.
    if (preg_match_all('/```[A-Za-z0-9_+-]*[ \t]*\r?\n?(.*?)```/s', $reply, $mm, PREG_SET_ORDER)) {
        foreach ($mm as $m) {
            $found = normalise_chat_actions(json_decode(trim($m[1]), true));
            if ($found) {
                $actions = array_merge($actions, $found);
                $clean   = str_replace($m[0], '', $clean);
            }
        }
    }

    // Unfenced JSON somewhere in the prose.
    if (!$actions) {
        $raw = extract_balanced_json($reply);
        if ($raw !== null) {
            $found = normalise_chat_actions(json_decode($raw, true));
            if ($found) {
                $actions = $found;
                $clean   = str_replace($raw, '', $clean);
            }
        }
    }

    $clean = trim($clean);
    if ($clean === '') {
        $clean = 'Done.';
    }
    return [$clean, $actions];
}

/**
 * Coerce whatever the model produced into a flat list of action objects.
 * Accepts {"actions":[...]}, a lone {"tool":...}, or a bare [...] array, and
 * keeps only entries that actually name a tool. Validation of the name itself
 * stays in chat_turn() against the CHAT_ACTIONS whitelist.
 */
function normalise_chat_actions($decoded): array
{
    if (!is_array($decoded)) {
        return [];
    }
    if (isset($decoded['actions']) && is_array($decoded['actions'])) {
        $decoded = $decoded['actions'];
    } elseif (isset($decoded['tool']) || isset($decoded['action']) || isset($decoded['name'])) {
        $decoded = [$decoded];
    }
    $out = [];
    foreach ($decoded as $item) {
        if (is_array($item) && (isset($item['tool']) || isset($item['action']) || isset($item['name']))) {
            $out[] = $item;
        }
    }
    return $out;
}

/**
 * First syntactically complete JSON object/array in a string, found by brace
 * matching (string-aware) rather than first-brace-to-last-brace, which breaks
 * as soon as any prose around it contains a brace.
 */
function extract_balanced_json(string $text): ?string
{
    $len = strlen($text);
    for ($i = 0; $i < $len; $i++) {
        if ($text[$i] !== '{' && $text[$i] !== '[') {
            continue;
        }
        $depth = 0;
        $inStr = false;
        $esc   = false;
        for ($j = $i; $j < $len; $j++) {
            $c = $text[$j];
            if ($inStr) {
                if ($esc) {
                    $esc = false;
                } elseif ($c === '\\') {
                    $esc = true;
                } elseif ($c === '"') {
                    $inStr = false;
                }
                continue;
            }
            if ($c === '"') {
                $inStr = true;
            } elseif ($c === '{' || $c === '[') {
                $depth++;
            } elseif ($c === '}' || $c === ']') {
                if (--$depth === 0) {
                    $candidate = substr($text, $i, $j - $i + 1);
                    if (json_decode($candidate, true) !== null) {
                        return $candidate;
                    }
                    break;   // invalid — start again from the next opener
                }
            }
        }
    }
    return null;
}

/**
 * Execute a single whitelisted chat action, scoped to the user. Returns a short
 * human summary, or null if the action could not be applied. Logs actor='ai'.
 */
/** Abort the current chat action with a reason the model can act on. */
function fail_action(string $message): void
{
    throw new ChatActionError($message);
}

/**
 * Find the row the model meant, by id OR by name.
 *
 * Small models frequently send {"name":"Read"} instead of {"id":3} even when
 * the prompt says otherwise, so accepting both is the difference between the
 * tool working and the turn being wasted. An ambiguous name lists the
 * candidates with their ids, which is something the model can actually use on
 * the next turn.
 */
function chat_resolve(int $uid, string $kind, array $args): array
{
    $meta = CHAT_ENTITIES[$kind] ?? null;
    if ($meta === null) {
        fail_action("Internal error: \"{$kind}\" is not an addressable entity.");
    }
    $table = $meta['table'];
    $col   = $meta['name'];
    $scope = $meta['where'] !== '' ? ' AND ' . $meta['where'] : '';
    $label = $meta['label'];
    $pdo   = db();

    // An explicit id always wins.
    foreach (['id', $kind . '_id'] as $key) {
        if (isset($args[$key]) && (int) $args[$key] > 0) {
            $id  = (int) $args[$key];
            $st  = $pdo->prepare("SELECT * FROM `{$table}` WHERE id=? AND user_id=? LIMIT 1");
            $st->execute([$id, $uid]);
            $row = $st->fetch();
            if ($row) {
                return $row;
            }
            fail_action("There is no {$label} with id {$id}. Use an id shown in the snapshot, or give the name instead.");
        }
    }

    // Otherwise fall back to a name/title.
    $needle = null;
    foreach (['name', 'title', 'description', $kind, 'query'] as $key) {
        if (isset($args[$key]) && trim((string) $args[$key]) !== '') {
            $needle = trim((string) $args[$key]);
            break;
        }
    }
    if ($needle === null) {
        fail_action("Which {$label} do you mean? Give its id from the snapshot, or its exact name.");
    }

    // Exact match first, then a contains-match.
    $st = $pdo->prepare("SELECT * FROM `{$table}` WHERE user_id=? AND `{$col}`=?{$scope} ORDER BY id DESC LIMIT 6");
    $st->execute([$uid, $needle]);
    $rows = $st->fetchAll();
    if (!$rows) {
        $st = $pdo->prepare("SELECT * FROM `{$table}` WHERE user_id=? AND `{$col}` LIKE ?{$scope} ORDER BY id DESC LIMIT 6");
        $st->execute([$uid, '%' . $needle . '%']);
        $rows = $st->fetchAll();
    }

    if (count($rows) === 1) {
        return $rows[0];
    }
    if (!$rows) {
        fail_action("No {$label} matching \"{$needle}\" was found. Check the snapshot for the exact name.");
    }
    $options = [];
    foreach ($rows as $row) {
        $options[] = '[id ' . $row['id'] . '] ' . (string) $row[$col];
    }
    fail_action(count($rows) . " {$label}s match \"{$needle}\": " . implode(', ', $options)
        . '. Ask which one is meant, then use its id.');
}

/**
 * Validate a date argument. Accepts YYYY-MM-DD plus the relative words small
 * models reach for anyway ("tomorrow"), and rejects anything else with a
 * message instead of letting MySQL fail on a malformed DATE.
 */
function chat_date($value, string $field, ?string $default = null): ?string
{
    if ($value === null || $value === '' ) {
        return $default;
    }
    $raw = strtolower(trim((string) $value));
    $words = ['today' => 'today', 'tomorrow' => '+1 day', 'yesterday' => '-1 day'];
    if (isset($words[$raw])) {
        return date('Y-m-d', strtotime($words[$raw]));
    }
    $d = DateTime::createFromFormat('Y-m-d', $raw);
    if ($d === false || $d->format('Y-m-d') !== $raw) {
        fail_action("\"{$value}\" is not a usable {$field}. Use the format YYYY-MM-DD.");
    }
    return $raw;
}

/** A required text argument, trimmed. */
function chat_text(array $args, string $key, string $what): string
{
    $value = trim((string) ($args[$key] ?? ''));
    if ($value === '') {
        fail_action("The \"{$key}\" argument is required — {$what}.");
    }
    return $value;
}

/** An optional text argument: null when absent, trimmed-or-null when present. */
function chat_opt_text(array $args, string $key): ?string
{
    if (!array_key_exists($key, $args) || $args[$key] === null) {
        return null;
    }
    $value = trim((string) $args[$key]);
    return $value === '' ? null : $value;
}

/** A required positive number argument. */
function chat_amount(array $args, string $key = 'amount'): float
{
    if (!isset($args[$key]) || !is_numeric($args[$key])) {
        fail_action("The \"{$key}\" argument must be a plain number, with no currency symbol or separators.");
    }
    $value = (float) $args[$key];
    if ($value <= 0) {
        fail_action("The \"{$key}\" argument must be greater than zero.");
    }
    return $value;
}

/**
 * Apply one whitelisted chat action.
 *
 * Returns a short human summary on success. On failure it throws
 * ChatActionError with a reason, chat_turn() surfaces that to the user and
 * feeds it back into the transcript so the model can correct itself next turn.
 * Every write logs an activity_log row with actor='ai'.
 */
function execute_chat_action(int $uid, string $tool, array $args): string
{
    $pdo = db();
    $prio = ['low', 'medium', 'high', 'urgent'];

    switch ($tool) {

        /* ------------------------------------------------------------ todos */

        case 'add_todo': {
            $title = chat_text($args, 'title', 'the task needs a name');
            $stmt = $pdo->prepare(
                'INSERT INTO todos (user_id, title, description, priority, project, due_date, created_by)
                 VALUES (?, ?, ?, ?, ?, ?, "ai")'
            );
            $stmt->execute([
                $uid, $title,
                chat_opt_text($args, 'description'),
                valid_enum($args['priority'] ?? 'medium', $prio, 'medium'),
                chat_opt_text($args, 'project'),
                chat_date($args['due_date'] ?? null, 'due_date'),
            ]);
            $id = (int) $pdo->lastInsertId();
            log_activity($uid, 'todo.created', 'todo', $id, 'Added todo: ' . $title, 'ai');
            return 'Added todo “' . $title . '”';
        }

        case 'complete_todo': {
            $todo = chat_resolve($uid, 'todo', $args);
            if ($todo['status'] === 'done') {
                return 'Task “' . $todo['title'] . '” was already done';
            }
            $pdo->prepare("UPDATE todos SET status='done', completed_at=NOW() WHERE id=? AND user_id=?")
                ->execute([(int) $todo['id'], $uid]);
            log_activity($uid, 'todo.completed', 'todo', (int) $todo['id'], 'Completed: ' . $todo['title'], 'ai');
            return 'Completed “' . $todo['title'] . '”';
        }

        case 'update_todo': {
            $todo = chat_resolve($uid, 'todo', $args);
            // "title" identifies the task, "new_title" renames it.
            $fields = [
                'title'       => chat_opt_text($args, 'new_title') ?? $todo['title'],
                'description' => array_key_exists('description', $args) ? chat_opt_text($args, 'description') : $todo['description'],
                'priority'    => isset($args['priority']) ? valid_enum($args['priority'], $prio, $todo['priority']) : $todo['priority'],
                'project'     => array_key_exists('project', $args) ? chat_opt_text($args, 'project') : $todo['project'],
                'due_date'    => array_key_exists('due_date', $args) ? chat_date($args['due_date'], 'due_date') : $todo['due_date'],
                'status'      => isset($args['status']) ? valid_enum($args['status'], ['todo', 'in_progress', 'done', 'archived'], $todo['status']) : $todo['status'],
            ];
            $done = $fields['status'] === 'done' && $todo['status'] !== 'done';
            $pdo->prepare(
                'UPDATE todos SET title=?, description=?, priority=?, project=?, due_date=?, status=?,
                 completed_at = CASE WHEN ? = 1 THEN NOW() WHEN status <> "done" THEN NULL ELSE completed_at END
                 WHERE id=? AND user_id=?'
            )->execute([
                $fields['title'], $fields['description'], $fields['priority'], $fields['project'],
                $fields['due_date'], $fields['status'], $done ? 1 : 0, (int) $todo['id'], $uid,
            ]);
            log_activity($uid, 'todo.updated', 'todo', (int) $todo['id'], 'Updated todo: ' . $fields['title'], 'ai');
            return 'Updated “' . $fields['title'] . '”';
        }

        /* ----------------------------------------------------------- habits */

        case 'add_habit': {
            $name = chat_text($args, 'name', 'the habit needs a name');
            $stmt = $pdo->prepare(
                'INSERT INTO habits (user_id, name, description, frequency, target_per_period, color)
                 VALUES (?, ?, ?, ?, ?, ?)'
            );
            $stmt->execute([
                $uid, $name,
                chat_opt_text($args, 'description'),
                valid_enum($args['frequency'] ?? 'daily', ['daily', 'weekly'], 'daily'),
                max(1, (int) ($args['target_per_period'] ?? 1)),
                '#4f8cff',
            ]);
            $id = (int) $pdo->lastInsertId();
            log_activity($uid, 'habit.created', 'habit', $id, 'Added habit: ' . $name, 'ai');
            return 'Added habit “' . $name . '”';
        }

        case 'log_habit': {
            $habit = chat_resolve($uid, 'habit', $args);
            $date  = chat_date($args['date'] ?? null, 'date', today());
            $exists = $pdo->prepare('SELECT id FROM habit_logs WHERE habit_id=? AND logged_date=?');
            $exists->execute([(int) $habit['id'], $date]);
            if ($exists->fetchColumn() !== false) {
                return 'Habit “' . $habit['name'] . '” was already logged for ' . $date;
            }
            $pdo->prepare('INSERT INTO habit_logs (user_id, habit_id, logged_date, count) VALUES (?, ?, ?, 1)')
                ->execute([$uid, (int) $habit['id'], $date]);
            log_activity($uid, 'habit.logged', 'habit', (int) $habit['id'], 'Logged habit: ' . $habit['name'], 'ai');
            return 'Logged habit “' . $habit['name'] . '”' . ($date === today() ? '' : ' for ' . $date);
        }

        case 'unlog_habit': {
            $habit = chat_resolve($uid, 'habit', $args);
            $date  = chat_date($args['date'] ?? null, 'date', today());
            $del = $pdo->prepare('DELETE FROM habit_logs WHERE user_id=? AND habit_id=? AND logged_date=?');
            $del->execute([$uid, (int) $habit['id'], $date]);
            if ($del->rowCount() === 0) {
                return 'Habit “' . $habit['name'] . '” was not logged for ' . $date . ', so nothing changed';
            }
            log_activity($uid, 'habit.unlogged', 'habit', (int) $habit['id'], 'Removed habit log: ' . $habit['name'], 'ai');
            return 'Removed the log for “' . $habit['name'] . '” on ' . $date;
        }

        /* ------------------------------------------------------------ goals */

        case 'add_goal': {
            $title = chat_text($args, 'title', 'the goal needs a name');
            $stmt = $pdo->prepare(
                'INSERT INTO goals (user_id, title, description, category, target_value, unit, target_date)
                 VALUES (?, ?, ?, ?, ?, ?, ?)'
            );
            $stmt->execute([
                $uid, $title,
                chat_opt_text($args, 'description'),
                chat_opt_text($args, 'category'),
                isset($args['target_value']) && is_numeric($args['target_value']) ? (int) $args['target_value'] : null,
                chat_opt_text($args, 'unit'),
                chat_date($args['target_date'] ?? null, 'target_date'),
            ]);
            $id = (int) $pdo->lastInsertId();
            log_activity($uid, 'goal.created', 'goal', $id, 'Added goal: ' . $title, 'ai');
            return 'Added goal “' . $title . '”';
        }

        case 'update_goal_progress': {
            $goal = chat_resolve($uid, 'goal', $args);
            if (!isset($args['delta']) || !is_numeric($args['delta'])) {
                fail_action('The "delta" argument must be a number — how much to add (or a negative number to subtract).');
            }
            $newValue = max(0, (int) $goal['current_value'] + (int) $args['delta']);
            $status   = $goal['status'];
            if ($goal['target_value'] !== null && $newValue >= (int) $goal['target_value'] && $status === 'active') {
                $status = 'completed';
            }
            $pdo->prepare('UPDATE goals SET current_value=?, status=? WHERE id=? AND user_id=?')
                ->execute([$newValue, $status, (int) $goal['id'], $uid]);
            log_activity($uid, 'goal.progress', 'goal', (int) $goal['id'], $goal['title'] . ' → ' . $newValue, 'ai');
            $suffix = $goal['target_value'] !== null ? '/' . (int) $goal['target_value'] : '';
            return 'Goal “' . $goal['title'] . '” is now at ' . $newValue . $suffix
                . ($status === 'completed' && $goal['status'] !== 'completed' ? ' — completed!' : '');
        }

        case 'set_goal_status': {
            $goal   = chat_resolve($uid, 'goal', $args);
            $status = valid_enum($args['status'] ?? '', ['active', 'completed', 'paused'], '');
            if ($status === '') {
                fail_action('The "status" argument must be exactly one of: active, completed, paused.');
            }
            $pdo->prepare('UPDATE goals SET status=? WHERE id=? AND user_id=?')
                ->execute([$status, (int) $goal['id'], $uid]);
            log_activity($uid, 'goal.status', 'goal', (int) $goal['id'], $goal['title'] . ' → ' . $status, 'ai');
            return 'Goal “' . $goal['title'] . '” is now ' . $status;
        }

        /* ------------------------------------------------------------ notes */

        case 'add_note': {
            $content = chat_text($args, 'content', 'a note needs some text');
            $stmt = $pdo->prepare('INSERT INTO notes (user_id, title, content, tags) VALUES (?, ?, ?, ?)');
            $stmt->execute([$uid, chat_opt_text($args, 'title'), $content, chat_opt_text($args, 'tags')]);
            $id = (int) $pdo->lastInsertId();
            log_activity($uid, 'note.created', 'note', $id, 'New note', 'ai');
            return 'Saved a note';
        }

        case 'update_note': {
            $note   = chat_resolve($uid, 'note', $args);
            $append = !empty($args['append']);
            $incoming = chat_opt_text($args, 'content');
            if ($incoming === null && !array_key_exists('new_title', $args) && !array_key_exists('tags', $args)) {
                fail_action('Nothing to change — pass "content" (optionally with "append": true), "new_title", or "tags".');
            }
            $content = $incoming === null
                ? $note['content']
                : ($append ? rtrim((string) $note['content']) . "\n" . $incoming : $incoming);
            $pdo->prepare('UPDATE notes SET title=?, content=?, tags=? WHERE id=? AND user_id=?')->execute([
                array_key_exists('new_title', $args) ? chat_opt_text($args, 'new_title') : $note['title'],
                $content,
                array_key_exists('tags', $args) ? chat_opt_text($args, 'tags') : $note['tags'],
                (int) $note['id'], $uid,
            ]);
            log_activity($uid, 'note.updated', 'note', (int) $note['id'], $append ? 'Appended to a note' : 'Updated a note', 'ai');
            return $append ? 'Added to that note' : 'Updated that note';
        }

        /* ------------------------------------------------------------ money */

        case 'add_expense': {
            $amount = chat_amount($args);
            $type   = valid_enum($args['type'] ?? 'expense', ['expense', 'income'], 'expense');
            // Accept a category by name as well as by id.
            $catId = null;
            if (isset($args['category_id']) && (int) $args['category_id'] > 0) {
                $catId = (int) chat_resolve($uid, 'category', ['id' => $args['category_id']])['id'];
            } elseif (chat_opt_text($args, 'category') !== null) {
                $catId = (int) chat_resolve($uid, 'category', ['name' => $args['category']])['id'];
            }
            $currency = default_currency($uid);
            $stmt = $pdo->prepare(
                'INSERT INTO expenses (user_id, type, amount, currency, category_id, description, spent_at, created_by)
                 VALUES (?, ?, ?, ?, ?, ?, ?, "ai")'
            );
            $stmt->execute([
                $uid, $type, $amount, $currency, $catId,
                chat_opt_text($args, 'description'),
                chat_date($args['spent_at'] ?? null, 'spent_at', today()),
            ]);
            $id = (int) $pdo->lastInsertId();
            log_activity($uid, 'expense.created', 'expense', $id, ($type === 'income' ? 'Income ' : 'Spent ') . money_text($amount, $currency), 'ai');
            return ($type === 'income' ? 'Logged income ' : 'Logged expense ') . money_text($amount, $currency);
        }

        case 'update_expense': {
            $exp      = chat_resolve($uid, 'expense', $args);
            $currency = (string) ($exp['currency'] ?: default_currency($uid));
            $amount   = isset($args['amount']) ? chat_amount($args) : (float) $exp['amount'];
            $catId    = $exp['category_id'] !== null ? (int) $exp['category_id'] : null;
            if (isset($args['category_id']) && (int) $args['category_id'] > 0) {
                $catId = (int) chat_resolve($uid, 'category', ['id' => $args['category_id']])['id'];
            } elseif (chat_opt_text($args, 'category') !== null) {
                $catId = (int) chat_resolve($uid, 'category', ['name' => $args['category']])['id'];
            }
            $pdo->prepare(
                'UPDATE expenses SET type=?, amount=?, category_id=?, description=?, spent_at=? WHERE id=? AND user_id=?'
            )->execute([
                isset($args['type']) ? valid_enum($args['type'], ['expense', 'income'], $exp['type']) : $exp['type'],
                $amount,
                $catId,
                array_key_exists('description', $args) ? chat_opt_text($args, 'description') : $exp['description'],
                array_key_exists('spent_at', $args) ? chat_date($args['spent_at'], 'spent_at', $exp['spent_at']) : $exp['spent_at'],
                (int) $exp['id'], $uid,
            ]);
            log_activity($uid, 'expense.updated', 'expense', (int) $exp['id'], 'Updated entry to ' . money_text($amount, $currency), 'ai');
            return 'Updated that entry to ' . money_text($amount, $currency);
        }

        case 'delete_expense': {
            // Id only, deliberately: a fuzzy name match must never delete a row.
            if (!isset($args['id']) || (int) $args['id'] <= 0) {
                fail_action('Deleting an entry needs its numeric "id" from the snapshot — a name is not accepted here.');
            }
            $exp = chat_resolve($uid, 'expense', ['id' => (int) $args['id']]);
            $pdo->prepare('DELETE FROM expenses WHERE id=? AND user_id=?')->execute([(int) $exp['id'], $uid]);
            $what = money_text((float) $exp['amount'], (string) ($exp['currency'] ?: default_currency($uid)));
            log_activity($uid, 'expense.deleted', 'expense', (int) $exp['id'], 'Deleted entry of ' . $what, 'ai');
            return 'Deleted that entry (' . $what . ')';
        }

        /* ------------------------------------------------------------ repos */

        case 'add_repo_suggestion': {
            $repo  = chat_resolve($uid, 'repo', $args);
            $title = chat_text($args, 'title', 'the suggestion needs a title');
            $stmt = $pdo->prepare(
                'INSERT INTO repo_suggestions (user_id, repo_id, title, detail, category, priority)
                 VALUES (?, ?, ?, ?, ?, ?)'
            );
            $stmt->execute([
                $uid, (int) $repo['id'], $title,
                chat_opt_text($args, 'detail'),
                valid_enum($args['category'] ?? 'other', ['feature', 'docs', 'refactor', 'testing', 'ci', 'security', 'other'], 'other'),
                valid_enum($args['priority'] ?? 'medium', ['low', 'medium', 'high'], 'medium'),
            ]);
            $id = (int) $pdo->lastInsertId();
            log_activity($uid, 'repo.suggestion', 'repo', (int) $repo['id'], 'Suggestion for ' . $repo['name'] . ': ' . $title, 'ai');
            return 'Added a suggestion to ' . $repo['name'];
        }
    }

    fail_action("\"{$tool}\" is not an action this app supports.");
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

    $system = <<<TXT
You are a senior engineer reviewing a GitHub repository. Suggest 3 to 5
concrete, high-value improvements, specific to THIS repository — refer to what
the metadata and README below actually show, never generic advice.

Reply with a JSON array and nothing else: no prose before or after it, no code
fence, no explanation. The array holds one object per suggestion:

[
  {"title":"...","detail":"...","category":"docs","priority":"high"},
  {"title":"...","detail":"...","category":"testing","priority":"medium"}
]

Every field is required on every object:
- "title"    a short imperative summary, under 80 characters.
- "detail"   two or three sentences on what to do and why it is worth doing.
- "category" exactly one of: feature, docs, refactor, testing, ci, security, other.
- "priority" exactly one of: low, medium, high.

Use those exact spellings in lowercase. Do not add other fields, and do not
wrap the array in an object.
TXT;

    // raw_system: must come back as a bare JSON array, parse_json_array()
    // spans first '[' to last ']', so stray prose corrupts it.
    $raw = ai_generate($uid, $system, $meta, ['max_tokens' => 900, 'raw_system' => true]);
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
            $currency = default_currency($uid);
            $stmt = db()->prepare('INSERT INTO expenses (user_id, type, amount, currency, description, spent_at, created_by) VALUES (?, ?, ?, ?, ?, ?, "ai")');
            $stmt->execute([
                $uid,
                valid_enum($parsed['type'] ?? 'expense', ['expense', 'income'], 'expense'),
                $amount, $currency,
                $parsed['description'] ?? $text,
                $parsed['spent_at'] ?? today(),
            ]);
            $id = (int) db()->lastInsertId();
            log_activity($uid, 'expense.created', 'expense', $id, 'Spent ' . money_text($amount, $currency), 'ai');
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
    $today    = date('Y-m-d');
    $tomorrow = date('Y-m-d', strtotime('+1 day'));
    // Spelled out with worked examples for the same reason as the chat
    // protocol: terse schema notation alone loses small local models, and a
    // parse failure here is silent (the text gets filed as a note instead).
    // raw_system skips the shared preamble, so state the date and currency here.
    $currency = default_currency($uid);
    $system = <<<TXT
You sort ONE line of the user's text into exactly one of three kinds, and reply
with a single JSON object and nothing else — no prose, no code fence, no
explanation before or after.

Pick the kind that fits best:
- "todo"    — something the user has to DO later.
- "expense" — money spent or received. Only when there is an amount.
- "note"    — anything worth remembering that is neither of the above.
              Use this when you are unsure.

Reply with exactly one of these shapes:
{"kind":"todo","title":"...","priority":"low|medium|high|urgent","due_date":"YYYY-MM-DD"}
{"kind":"expense","amount":0,"type":"expense|income","description":"..."}
{"kind":"note","title":"...","content":"..."}

Only "kind" and the first field are required; drop any optional field you are
not confident about rather than inventing a value. "amount" is a plain number
with no currency symbol and no thousands separator — amounts are in {$currency}.

Examples:
"buy milk tomorrow"            -> {"kind":"todo","title":"Buy milk","due_date":"{$tomorrow}"}
"call the bank, urgent"        -> {"kind":"todo","title":"Call the bank","priority":"urgent"}
"spent 250 on coffee"          -> {"kind":"expense","amount":250,"description":"Coffee"}
"got paid 5000 for the site"   -> {"kind":"expense","amount":5000,"type":"income","description":"Site payment"}
"gan 14 is better on light springs" -> {"kind":"note","content":"GAN 14 is better on light springs"}

Today is {$today}.
TXT;
    try {
        // raw_system: same reason, and a parse failure here is silent, it
        // falls back to the prefix parser and files the expense as a note.
        $raw = ai_generate($uid, $system, $text, ['max_tokens' => 300, 'raw_system' => true]);
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
    // INTERVAL 6 DAY, not 7: created_at is a TIMESTAMP and CURRENT_DATE is
    // midnight, so 7 would span eight calendar days while calling itself a week.
    $stmt = db()->prepare(
        'SELECT type, summary, actor, created_at FROM activity_log
         WHERE user_id=? AND created_at >= (CURRENT_DATE - INTERVAL 6 DAY)
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
    // State the window and the unit: these log lines are the model's only
    // evidence, and older rows were written before summaries carried a currency.
    $from = date('Y-m-d', strtotime('-6 day'));
    $system = 'You are reviewing the user\'s past week from their activity log. The log below covers '
        . $from . ' to ' . date('Y-m-d') . ' (7 days including today). Any money figure without an '
        . 'explicit currency code is in ' . default_currency($uid) . '. Write a warm, honest weekly '
        . 'review in markdown: a short summary sentence, "Wins" and "Watch-outs" sections as bullets, and one '
        . 'concrete suggestion for next week. Be specific to the data; keep it under 250 words.';
    return ai_generate($uid, $system, implode("\n", $lines), ['max_tokens' => 700]);
}

/* ============================================================== JSON utils */

/** Extract the first JSON object substring from arbitrary model text. */
function extract_json_object(string $text): string
{
    // Any fence tag, not just json, small models pick their own.
    if (preg_match('/```[A-Za-z0-9_+-]*[ \t]*\r?\n?(.*?)```/s', $text, $m)) {
        $inner = trim($m[1]);
        if (json_decode($inner, true) !== null) {
            return $inner;
        }
    }
    // Brace matching beats first-'{'-to-last-'}', which breaks the moment the
    // surrounding prose contains a brace of its own.
    $balanced = extract_balanced_json($text);
    if ($balanced !== null) {
        return $balanced;
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
    $candidate = null;
    if (preg_match('/```[A-Za-z0-9_+-]*[ \t]*\r?\n?(.*?)```/s', $text, $m)) {
        $inner = trim($m[1]);
        if (json_decode($inner, true) !== null) {
            $candidate = $inner;
        }
    }
    $candidate ??= extract_balanced_json($text);
    if ($candidate === null) {
        $start = strpos($text, '[');
        $end   = strrpos($text, ']');
        $candidate = ($start !== false && $end !== false && $end > $start)
            ? substr($text, $start, $end - $start + 1)
            : $text;
    }
    $decoded = json_decode($candidate, true);
    if (!is_array($decoded)) {
        return [];
    }
    // A model that wraps the array in an object ({"suggestions":[...]}) is
    // still usable, take the first array-of-objects value it holds.
    if (!array_is_list($decoded)) {
        foreach ($decoded as $value) {
            if (is_array($value) && array_is_list($value)) {
                return $value;
            }
        }
        return [];
    }
    return $decoded;
}
