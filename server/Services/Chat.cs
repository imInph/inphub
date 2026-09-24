using System.Security.Cryptography;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Inphub.Auth;
using Inphub.Core;

namespace Inphub.Services;

// The chat: one turn (reply, actions, one repair pass), its sessions, its prompt, and the action-block parser.
public static class Chat
{
    public static string DeveloperUser = "";

    static readonly char[] PhpTrim = [' ', '\t', '\n', '\r', '\0', '\v'];

    // Answers one user message, applies any actions the reply asks for, and saves both sides.
    public static async Task<object> Turn(int uid, string message, string? model, string? sessionId)
    {
        if (message == "") throw Api.Fail("Empty message.", 422);

        var sid = !string.IsNullOrEmpty(sessionId) && sessionId.EnumerateRunes().Count() <= 64
            ? sessionId
            : Convert.ToHexStringLower(RandomNumberGenerator.GetBytes(16));

        EnsureSession(uid, sid, message);
        Save(uid, sid, "user", message, null);

        var system = SystemPrompt(uid);
        var history = RecentText(uid, sid);
        var modelOverride = !string.IsNullOrEmpty(model) && model.EnumerateRunes().Count() <= 100 ? model : null;
        var reply = await Ai.Generate(uid, system, history, maxTokens: 1024, model: modelOverride);

        var (clean, actions) = SplitActions(reply);
        var executed = RunActions(uid, actions);

        var failed = executed.Where(IsFailure).ToList();
        if (failed.Count > 0)
        {
            var ok = executed.Where(a => !IsFailure(a)).ToList();
            try
            {
                var repairPrompt = history + " " + reply + "\n\n"
                    + ActionResultsLine(executed) + "\n\n"
                    + "(system: Some of those actions FAILED, so your reply above is wrong about them. "
                    + "Write your reply to the user again, from scratch. If the snapshot or a result above lets you fix "
                    + "the arguments, include a corrected json block containing ONLY the failed actions. If it is not clear "
                    + "which item the user means, or it does not exist, do not write a block: ask one short question and "
                    + "list the options by name. Never say something was done unless its result says OK.)\n\nAssistant:";
                var repairReply = await Ai.Generate(uid, system, repairPrompt, maxTokens: 1024, model: modelOverride);
                var (repairClean, repairActions) = SplitActions(repairReply);

                var retryable = failed.Select(a => ModelJson.Text(a["tool"])).ToHashSet();
                var repaired = RunActions(uid, repairActions.Where(a => ToolName(a) is { } t && retryable.Contains(t)).ToList());

                clean = repairClean;
                executed = ok.Concat(repaired.Count > 0 ? repaired : failed).ToList();
            }
            catch (Exception)
            {
            }
        }

        Save(uid, sid, "assistant", clean, executed.Count > 0 ? executed : null);
        var shown = executed.Select(a =>
        {
            var o = new JsonObject();
            foreach (var key in new[] { "tool", "summary", "error" })
            {
                if (a.ContainsKey(key)) o[key] = a[key]?.DeepClone();
            }
            return o;
        }).ToList();
        return new { reply = clean, actions = shown, session_id = sid };
    }

    // Runs parsed actions against the whitelist: {tool, summary, ref} on success, {tool, error, args} on failure.
    static List<JsonObject> RunActions(int uid, List<JsonObject> actions)
    {
        var executed = new List<JsonObject>();
        foreach (var a in actions)
        {
            var tool = ToolName(a);
            var rawArgs = a["args"] ?? a["arguments"] ?? a["parameters"] ?? a;
            var args = rawArgs is JsonObject or JsonArray ? ModelJson.AsObject(rawArgs.DeepClone()) : new JsonObject();

            if (tool == null || !ChatActions.Tools.Contains(tool))
            {
                var label = tool ?? "(missing tool name)";
                executed.Add(new JsonObject { ["tool"] = label, ["error"] = $"Unknown action \"{label}\" — not executed.", ["args"] = args });
                continue;
            }
            try
            {
                var result = ChatActions.Execute(uid, tool, (JsonObject)args.DeepClone());
                executed.Add(new JsonObject { ["tool"] = tool, ["summary"] = result["summary"]?.DeepClone(), ["ref"] = result["ref"]?.DeepClone() });
            }
            catch (ChatActionException e)
            {
                executed.Add(new JsonObject { ["tool"] = tool, ["error"] = e.Message, ["args"] = args });
            }
            catch (Exception e)
            {
                executed.Add(new JsonObject { ["tool"] = tool, ["error"] = $"Could not apply \"{tool}\": {e.Message}", ["args"] = args });
            }
        }
        return executed;
    }

    // The tool an action names under tool, action or name, when that is a string.
    static string? ToolName(JsonObject a) => ModelJson.StringOrNull(a["tool"] ?? a["action"] ?? a["name"]);

    // True for a {tool, error} result.
    static bool IsFailure(JsonObject a) => a["error"] != null;

    // The "(system: result of those actions …)" line: successes carry their row id, failures what was sent.
    public static string ActionResultsLine(IEnumerable<JsonNode?> executed)
    {
        var notes = new List<string>();
        foreach (var node in executed)
        {
            if (node is not JsonObject a) continue;
            var tool = a["tool"] != null ? ModelJson.Text(a["tool"]) : "action";
            if (a["error"] != null)
            {
                var sent = a["args"] is JsonObject or JsonArray ? $" (you sent {Clip(ModelJson.ToText(a["args"]), 200)})" : "";
                notes.Add($"{tool} FAILED{sent}: {ModelJson.Text(a["error"])}");
            }
            else
            {
                var kind = ModelJson.At(a, "ref", "kind");
                var id = ModelJson.At(a, "ref", "id");
                var reference = kind != null && id != null ? $" [{ModelJson.Text(kind)} id {ModelJson.Text(id)}]" : "";
                notes.Add($"{tool} OK{reference}: " + (a["summary"] != null ? ModelJson.Text(a["summary"]) : "done"));
            }
        }
        return notes.Count > 0 ? "(system: result of those actions — " + string.Join(" | ", notes) + ")" : "";
    }

    // Creates the session (titled from its first message) or bumps its updated_at.
    static void EnsureSession(int uid, string sid, string firstMessage)
    {
        var title = Clip(Regex.Replace(firstMessage, @"\s+", " ").Trim(PhpTrim), 60);
        if (title == "") title = "New chat";
        Db.Execute(
            @"INSERT INTO chat_sessions (user_id, session_id, title) VALUES (@uid, @sid, @title)
              ON DUPLICATE KEY UPDATE updated_at = CURRENT_TIMESTAMP",
            new { uid, sid, title });
    }

    // Gives chat history from before sessions existed (session_id 'default') a session row; never bumps one.
    public static void BackfillLegacySession(int uid)
    {
        var first = Db.Scalar<string>(
            "SELECT content FROM chat_messages WHERE user_id = @uid AND session_id = 'default' AND role = 'user' ORDER BY id ASC LIMIT 1",
            new { uid });
        if (first == null) return;
        var title = Clip(Regex.Replace(first, @"\s+", " ").Trim(PhpTrim), 60);
        if (title == "" || title == "0") title = "Earlier chat";
        Db.Execute("INSERT IGNORE INTO chat_sessions (user_id, session_id, title) VALUES (@uid, 'default', @title)", new { uid, title });
    }

    // The only place the chat system prompt is built: who the app is, who the user is, the snapshot and the tools.
    static string SystemPrompt(int uid)
    {
        var user = AuthService.CurrentUser(uid);
        var username = user?["username"] as string ?? "user";
        var display = user?["display_name"] is string { Length: > 0 } d && d != "0" ? d : username;

        var identity = $$"""
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

            You are talking to "{{display}}" (username: {{username}}).
            """;

        if (DeveloperUser != "" && username == DeveloperUser)
        {
            identity += "\n\n" + """
                Developer mode: this user is the sole developer and owner of inphub. Be technical
                and direct. Discuss implementation details, the database schema, and code freely
                (ASP.NET / C# + MySQL backend, TypeScript frontend). Skip end-user hand-holding and
                disclaimers — treat them as a peer who wrote this codebase.
                """;
        }

        var snapshot = Brief.Context(uid, true);
        var tomorrow = DateTime.Today.AddDays(1).ToString("yyyy-MM-dd");
        var today = AppInfo.Today();
        var currency = Money.DefaultCurrency(uid);
        var tools = $$$"""
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
            7. Every id must be copied from the snapshot above, or from a "(system: result
               of those actions …)" line in the conversation: "[expense id 395]" there is
               the id of the row that action created or changed. If what the user means is
               in neither place, say so and ask — never guess an id and never make one up.
            8. Each change must point at exactly ONE item. If the user's words could fit
               more than one item (they said "the Ali task" and the snapshot has both
               "Email Ali" and "Email Ali about rent"), do NOT write a block and do NOT
               pick one yourself. Ask which one they mean, naming the options.
            9. Identify an item with "id" (best) or its exact name under "name" or "title".
               Use no other key for that — not "habit_name", "task", or "item".
            10. If the user is only chatting or asking a question, write NO block at all.
            11. Say what you are doing ("Logging it now."). The app shows the user whether
                it worked, so never add details the result might contradict.

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
            Assistant: Adding it for tomorrow.
            ```json
            {"actions": [{"tool": "add_todo", "args": {"title": "Call the dentist", "due_date": "{{{tomorrow}}}"}}]}
            ```

            User: i finished the taxes task
            (the snapshot shows: - [id 12] Do the taxes [high])
            Assistant: Nice one — marking it done.
            ```json
            {"actions": [{"tool": "complete_todo", "args": {"id": 12}}]}
            ```

            User: spent 250 on coffee today, and i did my reading
            (the snapshot shows: - [id 3] Read — not yet done today)
            Assistant: Logging the coffee and ticking off your reading.
            ```json
            {"actions": [{"tool": "add_expense", "args": {"amount": 250, "description": "Coffee"}}, {"tool": "log_habit", "args": {"id": 3}}]}
            ```

            User: i read for 20 minutes and pausing the gym goal for now
            (the snapshot shows: - [id 3] Read — not yet done today, and - [id 2] Gym 3x a week)
            Assistant: Logging your reading and pausing the gym goal.
            ```json
            {"actions": [{"tool": "log_habit", "args": {"id": 3}}, {"tool": "set_goal_status", "args": {"id": 2, "status": "paused"}}]}
            ```

            User: that coffee was actually 180 not 250
            (the snapshot shows: - [id 91] {{{today}}} expense 250.00 {{{currency}}} — Coffee)
            Assistant: Fixing it to 180.
            ```json
            {"actions": [{"tool": "update_expense", "args": {"id": 91, "amount": 180}}]}
            ```

            User: i spent 350 on groceries
            Assistant: Logging 350 for groceries.
            ```json
            {"actions": [{"tool": "add_expense", "args": {"amount": 350, "description": "Groceries", "category": "Food & Drink"}}]}
            ```
            (system: result of those actions — add_expense OK [expense id 412]: Logged expense 350.00 {{{currency}}})
            User: change that to 380
            Assistant: Changing it to 380.
            ```json
            {"actions": [{"tool": "update_expense", "args": {"id": 412, "amount": 380}}]}
            ```

            User: i did yoga today
            (the snapshot shows: - [id 9] Yoga — not yet done today)
            Assistant: Logging yoga for today.
            ```json
            {"actions": [{"tool": "log_habit", "args": {"id": 9}}]}
            ```
            (system: result of those actions — log_habit OK [habit id 9]: Logged habit “Yoga”)
            User: actually undo that, i didn't
            Assistant: Removing today's yoga log.
            ```json
            {"actions": [{"tool": "unlog_habit", "args": {"id": 9}}]}
            ```

            User: complete the Ali task
            (the snapshot shows: - [id 27] Email Ali [medium], and - [id 28] Email Ali about rent [high])
            Assistant: You have two tasks about Ali: "Email Ali" and "Email Ali about rent". Which one should I complete?
            User: the rent one
            Assistant: Completing "Email Ali about rent".
            ```json
            {"actions": [{"tool": "complete_todo", "args": {"id": 28}}]}
            ```

            User: add to my cubing note that the springs help
            (the snapshot shows: - [id 7] Cube setup)
            Assistant: Adding that to the note.
            ```json
            {"actions": [{"tool": "update_note", "args": {"id": 7, "content": "Lighter springs help.", "append": true}}]}
            ```

            User: how much did i spend this week?
            Assistant: (answers from the snapshot, with no JSON block at all)

            If an action fails, the app tells you why, including what you sent. Read that
            reason, fix the arguments (usually the id) and try once more, or ask the user
            which item they meant. Do not silently repeat the same failing call.

            Keep the conversational part short and friendly.
            """;

        return $"{identity}\n\nHere is a snapshot of the user's current data:\n\n{snapshot}\n\n{tools}";
    }

    // The last 12 messages as one prompt, each followed by what its actions actually did.
    static string RecentText(int uid, string sid)
    {
        var rows = Db.Rows(
            "SELECT role, content, actions FROM chat_messages WHERE user_id = @uid AND session_id = @sid ORDER BY id DESC LIMIT 12",
            new { uid, sid });
        rows.Reverse();

        var parts = new List<string>();
        foreach (var r in rows)
        {
            parts.Add(((string)r["role"]! == "user" ? "User" : "Assistant") + ": " + r["content"]);
            if (r["actions"] is string { Length: > 0 } json && json != "0" && ModelJson.Parse(json) is JsonNode acts
                && acts is JsonArray or JsonObject && !ModelJson.IsEmptyContainer(acts))
            {
                var line = ActionResultsLine(ModelJson.Items(acts));
                if (line != "") parts.Add(line);
            }
        }
        parts.Add("Assistant:");
        return string.Join("\n\n", parts);
    }

    // Stores one message; actions as JSON, or NULL when there were none.
    static void Save(int uid, string sid, string role, string content, List<JsonObject>? actions)
    {
        var json = actions == null ? null : ModelJson.ToText(new JsonArray(actions.Select(a => (JsonNode)a.DeepClone()).ToArray()));
        Db.Execute(
            "INSERT INTO chat_messages (user_id, session_id, role, content, actions) VALUES (@uid, @sid, @role, @content, @json)",
            new { uid, sid, role, content, json });
    }

    // Splits a reply into its prose and the actions it asks for; liberal about fences and shapes.
    public static (string Clean, List<JsonObject> Actions) SplitActions(string reply)
    {
        var actions = new List<JsonObject>();
        var clean = reply;

        foreach (Match m in ModelJson.Fence.Matches(reply))
        {
            var decoded = ModelJson.Parse(m.Groups[1].Value.Trim(PhpTrim));
            var found = NormaliseActions(decoded);
            var emptyBlock = (decoded is JsonObject o && ModelJson.IsEmptyContainer(o["actions"])) || ModelJson.IsEmptyContainer(decoded);
            if (found.Count > 0 || emptyBlock)
            {
                actions.AddRange(found);
                clean = clean.Replace(m.Value, "");
            }
        }

        if (actions.Count == 0)
        {
            var raw = ModelJson.ExtractBalanced(reply);
            if (raw != null)
            {
                var decoded = ModelJson.Parse(raw);
                var found = NormaliseActions(decoded);
                if (found.Count > 0 || (decoded is JsonObject o && ModelJson.IsEmptyContainer(o["actions"])))
                {
                    actions = found;
                    clean = clean.Replace(raw, "");
                }
            }
        }

        clean = clean.Trim(PhpTrim);
        return (clean == "" ? "Done." : clean, actions);
    }

    // Whatever shape the model used ({actions:[…]}, one {tool,…}, a bare list) as a flat list of action objects.
    public static List<JsonObject> NormaliseActions(JsonNode? decoded)
    {
        if (decoded is not (JsonObject or JsonArray)) return [];
        if (decoded is JsonObject obj)
        {
            if (obj["actions"] is JsonObject or JsonArray) decoded = obj["actions"];
            else if (obj["tool"] != null || obj["action"] != null || obj["name"] != null) return [(JsonObject)obj.DeepClone()];
        }
        return ModelJson.Items(decoded)
            .OfType<JsonObject>()
            .Where(i => i["tool"] != null || i["action"] != null || i["name"] != null)
            .Select(i => (JsonObject)i.DeepClone())
            .ToList();
    }

    // The first n characters (code points) of a string.
    static string Clip(string s, int n)
    {
        var runes = s.EnumerateRunes().ToList();
        return runes.Count > n ? string.Concat(runes.Take(n)) : s;
    }
}
