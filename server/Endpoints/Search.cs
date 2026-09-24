using System.Text.RegularExpressions;
using Inphub.Core;

namespace Inphub.Endpoints;

public static class Search
{
    const int MinChars = 2;

    // GET /api/search: grouped results across everything the user owns, for the palette and dashboard bar.
    public static void Map(WebApplication app) =>
        app.MapMethods("/api/search", ["GET", "POST"], Api.Handle(Run));

    // Runs every group and drops the empty ones.
    static object? Run(Req req)
    {
        if (req.Action != "search" && req.Action != "list") throw Api.Fail("Unknown action.", 404);

        var q = req.Input.Str("q") ?? "";
        var limit = Math.Clamp(req.Input.Int("limit", 5), 1, 20);
        if (q.EnumerateRunes().Count() < MinChars)
        {
            return new { q, total = 0, truncated = false, groups = Array.Empty<object>() };
        }

        var args = new { uid = req.Uid, contains = "%" + LikeEscape(q) + "%", prefix = LikeEscape(q) + "%" };
        var groups = new List<Group>
        {
            Todos(args, limit), Expenses(args, limit), Notes(args, limit),
            Habits(args, limit), Goals(args, limit), Repos(args, limit),
        }.Where(g => g.items.Count > 0).ToList();

        return new { q, total = groups.Sum(g => g.items.Count), truncated = groups.Any(g => g.truncated), groups };
    }

    record Group(string type, string label, List<object> items, bool truncated);

    // The user's text as a LIKE literal; every LIKE below must carry ESCAPE '!'.
    static string LikeEscape(string q) => q.Replace("!", "!!").Replace("%", "!%").Replace("_", "!_");

    // Runs one group's query with limit+1 rows, so we know whether more exist, then shapes each row.
    static Group Run(string type, string label, string sql, object args, int limit, Func<Dictionary<string, object?>, object> shape)
    {
        var rows = Db.Rows(sql.Replace("{limit}", (limit + 1).ToString()), args);
        var truncated = rows.Count > limit;
        return new Group(type, label, rows.Take(limit).Select(shape).ToList(), truncated);
    }

    // Collapses whitespace and clips long text with an ellipsis.
    static string Snippet(object? text, int length = 90)
    {
        var clean = Regex.Replace(text as string ?? "", @"\s+", " ").Trim();
        var runes = clean.EnumerateRunes().ToList();
        return runes.Count > length ? string.Concat(runes.Take(length - 1)) + "…" : clean;
    }

    // Tasks by title, description, project or tags; title prefix matches first.
    static Group Todos(object args, int limit) => Run("todo", "Tasks",
        @"SELECT id, title, description, project, tags, status, priority, due_date
          FROM todos
          WHERE user_id = @uid
            AND (title LIKE @contains ESCAPE '!' OR description LIKE @contains ESCAPE '!'
                 OR project LIKE @contains ESCAPE '!' OR tags LIKE @contains ESCAPE '!')
          ORDER BY (title LIKE @prefix ESCAPE '!') DESC, (status IN ('done', 'archived')) ASC,
                   (due_date IS NULL) ASC, due_date ASC, id DESC
          LIMIT {limit}",
        args, limit, r =>
        {
            var bits = new List<string>();
            if (r["project"] is string { Length: > 0 } project) bits.Add("#" + project);
            if ((string)r["status"]! != "todo") bits.Add(((string)r["status"]!).Replace("_", " "));
            if ((string)r["priority"]! != "medium") bits.Add((string)r["priority"]!);
            return new
            {
                id = Convert.ToInt32(r["id"]),
                label = (string)r["title"]!,
                sub = string.Join(" · ", bits),
                meta = r["due_date"] != null ? "due " + r["due_date"] : "",
            };
        });

    // Money entries by description, category or payment method.
    static Group Expenses(object args, int limit) => Run("expense", "Money",
        @"SELECT e.id, e.description, e.amount, e.currency, e.type, e.spent_at, c.name AS category
          FROM expenses e
          LEFT JOIN expense_categories c ON c.id = e.category_id AND c.user_id = e.user_id
          WHERE e.user_id = @uid
            AND (e.description LIKE @contains ESCAPE '!' OR c.name LIKE @contains ESCAPE '!' OR e.payment_method LIKE @contains ESCAPE '!')
          ORDER BY (e.description LIKE @prefix ESCAPE '!') DESC, e.spent_at DESC, e.id DESC
          LIMIT {limit}",
        args, limit, r =>
        {
            var category = r["category"] as string;
            var label = Snippet(r["description"]);
            if (label == "") label = category ?? "Entry";
            return new
            {
                id = Convert.ToInt32(r["id"]),
                label,
                sub = ((string)r["type"]! == "income" ? "income" : "expense") + (category != null ? " · " + category : ""),
                meta = (string)r["spent_at"]!,
                amount = Stats.Number(r["amount"]),
                currency = (string)r["currency"]!,
            };
        });

    // Notes by title, content or tags.
    static Group Notes(object args, int limit) => Run("note", "Notes",
        @"SELECT id, title, content, tags, pinned, updated_at
          FROM notes
          WHERE user_id = @uid
            AND (title LIKE @contains ESCAPE '!' OR content LIKE @contains ESCAPE '!' OR tags LIKE @contains ESCAPE '!')
          ORDER BY (title LIKE @prefix ESCAPE '!') DESC, pinned DESC, updated_at DESC, id DESC
          LIMIT {limit}",
        args, limit, r =>
        {
            var title = (r["title"] as string)?.Trim();
            if (title == "") title = null;
            return new
            {
                id = Convert.ToInt32(r["id"]),
                label = title ?? Snippet(r["content"], 60),
                sub = title != null ? Snippet(r["content"], 70) : "",
                meta = (Convert.ToInt32(r["pinned"]) == 1 ? "pinned · " : "") + ((string)r["updated_at"]!)[..10],
            };
        });

    // Habits by name or description.
    static Group Habits(object args, int limit) => Run("habit", "Habits",
        @"SELECT id, name, description, frequency, is_active
          FROM habits
          WHERE user_id = @uid AND (name LIKE @contains ESCAPE '!' OR description LIKE @contains ESCAPE '!')
          ORDER BY (name LIKE @prefix ESCAPE '!') DESC, is_active DESC, sort_order ASC, id ASC
          LIMIT {limit}",
        args, limit, r => new
        {
            id = Convert.ToInt32(r["id"]),
            label = (string)r["name"]!,
            sub = Snippet(r["description"], 70),
            meta = (string)r["frequency"]! + (Convert.ToInt32(r["is_active"]) == 1 ? "" : " · paused"),
        });

    // Goals by title, description or category.
    static Group Goals(object args, int limit) => Run("goal", "Goals",
        @"SELECT id, title, description, category, current_value, target_value, unit, status
          FROM goals
          WHERE user_id = @uid
            AND (title LIKE @contains ESCAPE '!' OR description LIKE @contains ESCAPE '!' OR category LIKE @contains ESCAPE '!')
          ORDER BY (title LIKE @prefix ESCAPE '!') DESC, FIELD(status, 'active', 'paused', 'completed'), id DESC
          LIMIT {limit}",
        args, limit, r =>
        {
            var progress = Convert.ToInt32(r["current_value"]).ToString()
                + (r["target_value"] != null ? "/" + Convert.ToInt32(r["target_value"]) : "")
                + (r["unit"] is string { Length: > 0 } unit ? " " + unit : "");
            var status = (string)r["status"]!;
            return new
            {
                id = Convert.ToInt32(r["id"]),
                label = (string)r["title"]!,
                sub = (progress + (status != "active" ? " · " + status : "")).Trim(),
                meta = r["category"] as string ?? "",
            };
        });

    // Repositories by name, full name or description.
    static Group Repos(object args, int limit) => Run("repo", "Repositories",
        @"SELECT id, name, full_name, description, language, health_score, staleness_days
          FROM repos
          WHERE user_id = @uid
            AND (name LIKE @contains ESCAPE '!' OR full_name LIKE @contains ESCAPE '!' OR description LIKE @contains ESCAPE '!')
          ORDER BY (name LIKE @prefix ESCAPE '!') DESC, pinned DESC, name ASC, id DESC
          LIMIT {limit}",
        args, limit, r => new
        {
            id = Convert.ToInt32(r["id"]),
            label = (string)r["full_name"]!,
            sub = Snippet(r["description"], 70),
            meta = ((r["language"] as string ?? "") + (r["health_score"] != null ? " · health " + Convert.ToInt32(r["health_score"]) : "")).Trim(),
        });
}
