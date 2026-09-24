using System.Globalization;
using System.Text.Json.Nodes;
using Inphub.Core;

namespace Inphub.Services;

// A chat action that could not be applied, with a reason written for the model to read on its next turn.
public class ChatActionException(string message) : Exception(message);

// The tools the chat model may call, and how each one finds, checks and changes the user's rows.
public static class ChatActions
{
    public static readonly string[] Tools =
    [
        "add_todo", "complete_todo", "update_todo",
        "add_habit", "log_habit", "unlog_habit",
        "add_goal", "update_goal_progress", "set_goal_status",
        "add_note", "update_note",
        "add_expense", "update_expense", "delete_expense",
        "add_repo_suggestion",
    ];

    record Entity(string Table, string NameColumn, string Where, string Label);

    // Table and column names come from here only, never from model output.
    static readonly Dictionary<string, Entity> Entities = new()
    {
        ["todo"] = new("todos", "title", "status <> 'archived'", "task"),
        ["habit"] = new("habits", "name", "is_active = 1", "habit"),
        ["goal"] = new("goals", "title", "", "goal"),
        ["note"] = new("notes", "title", "", "note"),
        ["expense"] = new("expenses", "description", "", "entry"),
        ["repo"] = new("repos", "name", "", "repository"),
        ["category"] = new("expense_categories", "name", "", "category"),
    };

    static readonly string[] Priorities = ["low", "medium", "high", "urgent"];

    // Applies one whitelisted tool; returns Done(...) or throws ChatActionException with the reason.
    public static JsonObject Execute(int uid, string tool, JsonObject args)
    {
        switch (tool)
        {
            case "add_todo":
            {
                var title = RequiredText(args, "title", "the task needs a name");
                var id = Db.Insert(
                    @"INSERT INTO todos (user_id, title, description, priority, project, due_date, created_by)
                      VALUES (@uid, @title, @description, @priority, @project, @due, 'ai')",
                    new
                    {
                        uid, title,
                        description = OptionalText(args, "description"),
                        priority = Enum(args["priority"], Priorities, "medium"),
                        project = OptionalText(args, "project"),
                        due = Date(args["due_date"], "due_date"),
                    });
                Activity.Log(uid, "todo.created", "todo", id, "Added todo: " + title, "ai");
                return Done($"Added todo “{title}”", "task", id);
            }
            case "complete_todo":
            {
                var todo = Resolve(uid, "todo", args);
                var id = Convert.ToInt32(todo["id"]);
                if ((string)todo["status"]! == "done") return Done($"Task “{todo["title"]}” was already done", "task", id);
                Db.Execute("UPDATE todos SET status = 'done', completed_at = NOW() WHERE id = @id AND user_id = @uid", new { id, uid });
                Activity.Log(uid, "todo.completed", "todo", id, "Completed: " + todo["title"], "ai");
                return Done($"Completed “{todo["title"]}”", "task", id);
            }
            case "update_todo":
            {
                var todo = Resolve(uid, "todo", args);
                var id = Convert.ToInt32(todo["id"]);
                var currentStatus = (string)todo["status"]!;
                var title = OptionalText(args, "new_title") ?? (string)todo["title"]!;
                var status = args["status"] != null ? Enum(args["status"], ["todo", "in_progress", "done", "archived"], currentStatus) : currentStatus;
                Db.Execute(
                    @"UPDATE todos SET title = @title, description = @description, priority = @priority, project = @project,
                        due_date = @due, status = @status,
                        completed_at = CASE WHEN @done = 1 THEN NOW() WHEN status <> 'done' THEN NULL ELSE completed_at END
                      WHERE id = @id AND user_id = @uid",
                    new
                    {
                        title, status, id, uid,
                        description = args.ContainsKey("description") ? OptionalText(args, "description") : todo["description"],
                        priority = args["priority"] != null ? Enum(args["priority"], Priorities, (string)todo["priority"]!) : todo["priority"],
                        project = args.ContainsKey("project") ? OptionalText(args, "project") : todo["project"],
                        due = args.ContainsKey("due_date") ? Date(args["due_date"], "due_date") : todo["due_date"],
                        done = status == "done" && currentStatus != "done" ? 1 : 0,
                    });
                Activity.Log(uid, "todo.updated", "todo", id, "Updated todo: " + title, "ai");
                return Done($"Updated “{title}”", "task", id);
            }
            case "add_habit":
            {
                var name = RequiredText(args, "name", "the habit needs a name");
                var id = Db.Insert(
                    @"INSERT INTO habits (user_id, name, description, frequency, target_per_period, color)
                      VALUES (@uid, @name, @description, @frequency, @target, '#4f8cff')",
                    new
                    {
                        uid, name,
                        description = OptionalText(args, "description"),
                        frequency = Enum(args["frequency"], ["daily", "weekly"], "daily"),
                        target = Math.Max(1, args["target_per_period"] != null ? ModelJson.Int(args["target_per_period"]) : 1),
                    });
                Activity.Log(uid, "habit.created", "habit", id, "Added habit: " + name, "ai");
                return Done($"Added habit “{name}”", "habit", id);
            }
            case "log_habit":
            {
                var habit = Resolve(uid, "habit", args);
                var id = Convert.ToInt32(habit["id"]);
                var date = Date(args["date"], "date", AppInfo.Today())!;
                if (Db.Scalar<int?>("SELECT id FROM habit_logs WHERE habit_id = @id AND logged_date = @date", new { id, date }) != null)
                {
                    return Done($"Habit “{habit["name"]}” was already logged for {date}", "habit", id);
                }
                Db.Execute("INSERT INTO habit_logs (user_id, habit_id, logged_date, count) VALUES (@uid, @id, @date, 1)", new { uid, id, date });
                Activity.Log(uid, "habit.logged", "habit", id, "Logged habit: " + habit["name"], "ai");
                return Done($"Logged habit “{habit["name"]}”" + (date == AppInfo.Today() ? "" : " for " + date), "habit", id);
            }
            case "unlog_habit":
            {
                var habit = Resolve(uid, "habit", args);
                var id = Convert.ToInt32(habit["id"]);
                var date = Date(args["date"], "date", AppInfo.Today())!;
                var removed = Db.Execute("DELETE FROM habit_logs WHERE user_id = @uid AND habit_id = @id AND logged_date = @date", new { uid, id, date });
                if (removed == 0) return Done($"Habit “{habit["name"]}” was not logged for {date}, so nothing changed", "habit", id);
                Activity.Log(uid, "habit.unlogged", "habit", id, "Removed habit log: " + habit["name"], "ai");
                return Done($"Removed the log for “{habit["name"]}” on {date}", "habit", id);
            }
            case "add_goal":
            {
                var title = RequiredText(args, "title", "the goal needs a name");
                var id = Db.Insert(
                    @"INSERT INTO goals (user_id, title, description, category, target_value, unit, target_date)
                      VALUES (@uid, @title, @description, @category, @target, @unit, @date)",
                    new
                    {
                        uid, title,
                        description = OptionalText(args, "description"),
                        category = OptionalText(args, "category"),
                        target = ModelJson.IsNumeric(args["target_value"]) ? ModelJson.Int(args["target_value"]) : (int?)null,
                        unit = OptionalText(args, "unit"),
                        date = Date(args["target_date"], "target_date"),
                    });
                Activity.Log(uid, "goal.created", "goal", id, "Added goal: " + title, "ai");
                return Done($"Added goal “{title}”", "goal", id);
            }
            case "update_goal_progress":
            {
                var goal = Resolve(uid, "goal", args);
                var id = Convert.ToInt32(goal["id"]);
                if (!ModelJson.IsNumeric(args["delta"]))
                {
                    throw new ChatActionException("The \"delta\" argument must be a number — how much to add (or a negative number to subtract).");
                }
                var newValue = Math.Max(0, Convert.ToInt32(goal["current_value"]) + ModelJson.Int(args["delta"]));
                var oldStatus = (string)goal["status"]!;
                var status = oldStatus;
                if (goal["target_value"] != null && newValue >= Convert.ToInt32(goal["target_value"]) && status == "active") status = "completed";
                Db.Execute("UPDATE goals SET current_value = @newValue, status = @status WHERE id = @id AND user_id = @uid", new { newValue, status, id, uid });
                Activity.Log(uid, "goal.progress", "goal", id, $"{goal["title"]} → {newValue}", "ai");
                var suffix = goal["target_value"] != null ? "/" + Convert.ToInt32(goal["target_value"]) : "";
                return Done($"Goal “{goal["title"]}” is now at {newValue}{suffix}"
                    + (status == "completed" && oldStatus != "completed" ? " — completed!" : ""), "goal", id);
            }
            case "set_goal_status":
            {
                var goal = Resolve(uid, "goal", args);
                var id = Convert.ToInt32(goal["id"]);
                var status = Enum(args["status"], ["active", "completed", "paused"], "");
                if (status == "") throw new ChatActionException("The \"status\" argument must be exactly one of: active, completed, paused.");
                Db.Execute("UPDATE goals SET status = @status WHERE id = @id AND user_id = @uid", new { status, id, uid });
                Activity.Log(uid, "goal.status", "goal", id, $"{goal["title"]} → {status}", "ai");
                return Done($"Goal “{goal["title"]}” is now {status}", "goal", id);
            }
            case "add_note":
            {
                var content = RequiredText(args, "content", "a note needs some text");
                var id = Db.Insert("INSERT INTO notes (user_id, title, content, tags) VALUES (@uid, @title, @content, @tags)",
                    new { uid, title = OptionalText(args, "title"), content, tags = OptionalText(args, "tags") });
                Activity.Log(uid, "note.created", "note", id, "New note", "ai");
                return Done("Saved a note", "note", id);
            }
            case "update_note":
            {
                var note = Resolve(uid, "note", args);
                var id = Convert.ToInt32(note["id"]);
                var append = ModelJson.Truthy(args["append"]);
                var incoming = OptionalText(args, "content");
                if (incoming == null && !args.ContainsKey("new_title") && !args.ContainsKey("tags"))
                {
                    throw new ChatActionException("Nothing to change — pass \"content\" (optionally with \"append\": true), \"new_title\", or \"tags\".");
                }
                var content = incoming == null ? (string)note["content"]!
                    : append ? ((string)note["content"]!).TrimEnd(' ', '\t', '\n', '\r', '\0', '\v') + "\n" + incoming
                    : incoming;
                Db.Execute("UPDATE notes SET title = @title, content = @content, tags = @tags WHERE id = @id AND user_id = @uid",
                    new
                    {
                        content, id, uid,
                        title = args.ContainsKey("new_title") ? OptionalText(args, "new_title") : note["title"],
                        tags = args.ContainsKey("tags") ? OptionalText(args, "tags") : note["tags"],
                    });
                Activity.Log(uid, "note.updated", "note", id, append ? "Appended to a note" : "Updated a note", "ai");
                return Done(append ? "Added to that note" : "Updated that note", "note", id);
            }
            case "add_expense":
            {
                var amount = Amount(args);
                var type = Enum(args["type"], ["expense", "income"], "expense");
                var categoryId = CategoryFrom(uid, args, null);
                var currency = Money.DefaultCurrency(uid);
                var id = Db.Insert(
                    @"INSERT INTO expenses (user_id, type, amount, currency, category_id, description, spent_at, created_by)
                      VALUES (@uid, @type, @amount, @currency, @categoryId, @description, @spentAt, 'ai')",
                    new
                    {
                        uid, type, amount, currency, categoryId,
                        description = OptionalText(args, "description"),
                        spentAt = Date(args["spent_at"], "spent_at", AppInfo.Today()),
                    });
                Activity.Log(uid, "expense.created", "expense", id, (type == "income" ? "Income " : "Spent ") + Money.Text(amount, currency), "ai");
                return Done((type == "income" ? "Logged income " : "Logged expense ") + Money.Text(amount, currency), "expense", id);
            }
            case "update_expense":
            {
                var entry = Resolve(uid, "expense", args);
                var id = Convert.ToInt32(entry["id"]);
                var currency = entry["currency"] is string { Length: > 0 } c ? c : Money.DefaultCurrency(uid);
                var amount = args["amount"] != null ? Amount(args) : Input.LeadingNumber((string)entry["amount"]!);
                var categoryId = CategoryFrom(uid, args, entry["category_id"] as int?);
                var type = (string)entry["type"]!;
                Db.Execute(
                    @"UPDATE expenses SET type = @type, amount = @amount, category_id = @categoryId, description = @description, spent_at = @spentAt
                      WHERE id = @id AND user_id = @uid",
                    new
                    {
                        amount, categoryId, id, uid,
                        type = args["type"] != null ? Enum(args["type"], ["expense", "income"], type) : type,
                        description = args.ContainsKey("description") ? OptionalText(args, "description") : entry["description"],
                        spentAt = args.ContainsKey("spent_at") ? Date(args["spent_at"], "spent_at", (string)entry["spent_at"]!) : entry["spent_at"],
                    });
                Activity.Log(uid, "expense.updated", "expense", id, "Updated entry to " + Money.Text(amount, currency), "ai");
                return Done("Updated that entry to " + Money.Text(amount, currency), "expense", id);
            }
            case "delete_expense":
            {
                if (args["id"] == null || ModelJson.Int(args["id"]) <= 0)
                {
                    throw new ChatActionException("Deleting an entry needs its numeric \"id\" from the snapshot — a name is not accepted here.");
                }
                var entry = Resolve(uid, "expense", new JsonObject { ["id"] = ModelJson.Int(args["id"]) });
                var id = Convert.ToInt32(entry["id"]);
                Db.Execute("DELETE FROM expenses WHERE id = @id AND user_id = @uid", new { id, uid });
                var currency = entry["currency"] is string { Length: > 0 } c ? c : Money.DefaultCurrency(uid);
                var what = Money.Text(Input.LeadingNumber((string)entry["amount"]!), currency);
                Activity.Log(uid, "expense.deleted", "expense", id, "Deleted entry of " + what, "ai");
                return Done($"Deleted that entry ({what})", "expense", id);
            }
            case "add_repo_suggestion":
            {
                var repo = Resolve(uid, "repo", args);
                var repoId = Convert.ToInt32(repo["id"]);
                var title = RequiredText(args, "title", "the suggestion needs a title");
                Db.Insert(
                    @"INSERT INTO repo_suggestions (user_id, repo_id, title, detail, category, priority)
                      VALUES (@uid, @repoId, @title, @detail, @category, @priority)",
                    new
                    {
                        uid, repoId, title,
                        detail = OptionalText(args, "detail"),
                        category = Enum(args["category"], ["feature", "docs", "refactor", "testing", "ci", "security", "other"], "other"),
                        priority = Enum(args["priority"], ["low", "medium", "high"], "medium"),
                    });
                Activity.Log(uid, "repo.suggestion", "repo", repoId, $"Suggestion for {repo["name"]}: {title}", "ai");
                return Done($"Added a suggestion to {repo["name"]}", "repository", repoId);
            }
        }
        throw new ChatActionException($"\"{tool}\" is not an action this app supports.");
    }

    // Finds the row the model meant, by id or by a name that picks out exactly one row; ambiguity lists the candidates.
    public static Dictionary<string, object?> Resolve(int uid, string kind, JsonObject args)
    {
        if (!Entities.TryGetValue(kind, out var e)) throw new ChatActionException($"Internal error: \"{kind}\" is not an addressable entity.");
        var scope = e.Where != "" ? " AND " + e.Where : "";

        Dictionary<string, object?> ById(int id) =>
            Db.Row($"SELECT * FROM `{e.Table}` WHERE id = @id AND user_id = @uid LIMIT 1", new { id, uid })
            ?? throw new ChatActionException($"There is no {e.Label} with id {id}. Use an id shown in the snapshot or in an earlier result, or give the name instead.");

        foreach (var key in new[] { "id", kind + "_id", kind == "todo" ? "task_id" : kind + "_id" })
        {
            var v = args[key];
            if (v != null && ModelJson.IsNumeric(v) && ModelJson.Int(v) > 0) return ById(ModelJson.Int(v));
        }

        var keys = new List<string> { kind + "_name", kind + "_title", kind, "name", "title", "description", "query", "label", "text" };
        if (kind == "todo") keys.InsertRange(0, ["task", "task_title", "task_name"]);
        string? needle = null;
        foreach (var key in keys)
        {
            var v = args[key];
            if (v != null && ModelJson.IsScalar(v) && ModelJson.Text(v).Trim() != "")
            {
                needle = ModelJson.Text(v).Trim();
                break;
            }
        }
        if (needle == null) throw new ChatActionException($"Which {e.Label} do you mean? Put its id from the snapshot under \"id\" (or its exact name under \"name\").");
        if (needle.All(char.IsAsciiDigit)) return ById(int.Parse(needle, CultureInfo.InvariantCulture));

        var like = "%" + needle.Replace("!", "!!").Replace("%", "!%").Replace("_", "!_") + "%";
        var exact = Db.Rows($"SELECT * FROM `{e.Table}` WHERE user_id = @uid AND `{e.NameColumn}` = @needle{scope} ORDER BY id DESC LIMIT 6", new { uid, needle });
        var contains = Db.Rows($"SELECT * FROM `{e.Table}` WHERE user_id = @uid AND `{e.NameColumn}` LIKE @like ESCAPE '!'{scope} ORDER BY id DESC LIMIT 6", new { uid, like });

        if (exact.Count == 1 && (kind == "category" || contains.Count <= 1)) return exact[0];
        if (exact.Count == 0 && contains.Count == 1) return contains[0];
        if (exact.Count == 0 && contains.Count == 0) throw new ChatActionException($"No {e.Label} matching \"{needle}\" was found. Check the snapshot for the exact name.");

        var options = (contains.Count > 0 ? contains : exact).Select(r => $"[id {r["id"]}] {r[e.NameColumn]}").ToList();
        throw new ChatActionException($"{options.Count} {e.Label}s match \"{needle}\": {string.Join(", ", options)}. Nothing was changed. Ask the user which one they mean, then use its id.");
    }

    // A success: the summary the user sees and the row it touched (replayed to the model as "[expense id 395]").
    static JsonObject Done(string summary, string? kind = null, int? id = null) => new()
    {
        ["summary"] = summary,
        ["ref"] = kind != null && id is > 0 ? new JsonObject { ["kind"] = kind, ["id"] = id } : null,
    };

    // A date argument: YYYY-MM-DD or today/tomorrow/yesterday; anything else fails with a reason.
    static string? Date(JsonNode? value, string field, string? fallback = null)
    {
        if (value == null || ModelJson.StringOrNull(value) == "") return fallback;
        var raw = ModelJson.Text(value).Trim().ToLowerInvariant();
        if (raw == "today") return AppInfo.Today();
        if (raw == "tomorrow") return DateTime.Today.AddDays(1).ToString("yyyy-MM-dd");
        if (raw == "yesterday") return DateTime.Today.AddDays(-1).ToString("yyyy-MM-dd");
        if (!DateTime.TryParseExact(raw, "yyyy-MM-dd", CultureInfo.InvariantCulture, DateTimeStyles.None, out _))
        {
            throw new ChatActionException($"\"{ModelJson.Text(value)}\" is not a usable {field}. Use the format YYYY-MM-DD.");
        }
        return raw;
    }

    // A required text argument, trimmed.
    static string RequiredText(JsonObject args, string key, string what)
    {
        var value = ModelJson.Text(args[key]).Trim();
        if (value == "") throw new ChatActionException($"The \"{key}\" argument is required — {what}.");
        return value;
    }

    // An optional text argument: null when absent or blank, otherwise trimmed.
    static string? OptionalText(JsonObject args, string key)
    {
        if (args[key] == null) return null;
        var value = ModelJson.Text(args[key]).Trim();
        return value == "" ? null : value;
    }

    // A required positive amount, a plain number.
    static double Amount(JsonObject args, string key = "amount")
    {
        if (!ModelJson.IsNumeric(args[key])) throw new ChatActionException($"The \"{key}\" argument must be a plain number, with no currency symbol or separators.");
        var value = ModelJson.Number(args[key]);
        if (value <= 0) throw new ChatActionException($"The \"{key}\" argument must be greater than zero.");
        return value;
    }

    // The value when it is one of allowed (as text), otherwise the fallback.
    static string Enum(JsonNode? value, string[] allowed, string fallback)
    {
        if (value == null) return fallback;
        var text = ModelJson.Text(value);
        return allowed.Contains(text) ? text : fallback;
    }

    // A category by category_id or by name, or the current one when neither is given.
    static int? CategoryFrom(int uid, JsonObject args, int? current)
    {
        if (args["category_id"] != null && ModelJson.Int(args["category_id"]) > 0)
        {
            return Convert.ToInt32(Resolve(uid, "category", new JsonObject { ["id"] = args["category_id"]!.DeepClone() })["id"]);
        }
        if (OptionalText(args, "category") != null)
        {
            return Convert.ToInt32(Resolve(uid, "category", new JsonObject { ["name"] = args["category"]!.DeepClone() })["id"]);
        }
        return current;
    }
}
