using System.Globalization;
using System.Text.RegularExpressions;
using Inphub.Core;
using Inphub.Endpoints;

namespace Inphub.Services;

// The daily brief, the data snapshot every AI prompt is built on, and the weekly review.
public static class Brief
{
    // Writes today's brief (replacing an earlier one from today) and returns the stored row.
    public static async Task<Dictionary<string, object?>?> Generate(int uid)
    {
        var context = Context(uid);
        var system = "You are the user's concise personal assistant inside a life dashboard. "
            + "Write a short, energising daily brief in markdown: a one-line greeting, then 3-6 bullet points "
            + "covering what needs attention today (overdue/ due tasks, habits not yet done, spending vs budget, "
            + "neglected repos, active goals). Be specific using the data. No preamble, no sign-off.";
        var content = await Ai.Generate(uid, system, context, maxTokens: 700);

        var c = Ai.Config(uid);
        Db.Execute(
            @"INSERT INTO daily_briefs (user_id, brief_date, content, provider, model)
              VALUES (@uid, CURRENT_DATE, @content, @provider, @model)
              ON DUPLICATE KEY UPDATE content = VALUES(content), provider = VALUES(provider), model = VALUES(model)",
            new { uid, content, provider = c.Provider, model = Ai.ActiveModel(c) });
        Activity.Log(uid, "ai.brief", "brief", null, "Generated a daily brief", "ai");
        return Db.Row("SELECT * FROM daily_briefs WHERE user_id = @uid AND brief_date = CURRENT_DATE", new { uid });
    }

    // A compact text snapshot of the user's day; withIds adds the row ids the chat's tools need.
    public static string Context(int uid, bool withIds = false)
    {
        var now = DateTime.Now;
        var lines = new List<string> { $"Today is {now.ToString("dddd, d MMMM yyyy", CultureInfo.InvariantCulture)}." };

        var todos = Db.Rows(
            @"SELECT id, title, priority, due_date FROM todos
              WHERE user_id = @uid AND status IN ('todo', 'in_progress') AND (due_date IS NULL OR due_date <= CURRENT_DATE)
              ORDER BY (due_date IS NULL), due_date ASC LIMIT 15",
            new { uid });
        lines.Add($"\nTasks due or overdue ({todos.Count}):");
        foreach (var r in todos)
        {
            lines.Add("- " + (withIds ? $"[id {r["id"]}] " : "") + r["title"] + $" [{r["priority"]}]"
                + (Truthy(r["due_date"]) ? $" due {r["due_date"]}" : ""));
        }

        if (withIds)
        {
            var later = Db.Rows(
                @"SELECT id, title, priority, due_date FROM todos
                  WHERE user_id = @uid AND status IN ('todo', 'in_progress') AND due_date > CURRENT_DATE
                  ORDER BY due_date ASC, id DESC LIMIT 25",
                new { uid });
            if (later.Count > 0)
            {
                lines.Add("\nOther open tasks (due later):");
                foreach (var r in later) lines.Add($"- [id {r["id"]}] {r["title"]} [{r["priority"]}] due {r["due_date"]}");
            }

            lines.Add("\nHabits (today):");
            foreach (var r in Db.Rows(
                @"SELECT h.id, h.name,
                    EXISTS (SELECT 1 FROM habit_logs hl WHERE hl.habit_id = h.id AND hl.logged_date = CURRENT_DATE) AS done
                  FROM habits h WHERE h.user_id = @uid AND h.is_active = 1 ORDER BY h.sort_order ASC, h.id ASC",
                new { uid }))
            {
                lines.Add($"- [id {r["id"]}] {r["name"]} — " + (Truthy(r["done"]) ? "already logged today" : "not yet done today"));
            }
        }
        else
        {
            var unlogged = Db.Rows(
                @"SELECT name FROM habits h
                  WHERE user_id = @uid AND is_active = 1
                    AND NOT EXISTS (SELECT 1 FROM habit_logs hl WHERE hl.habit_id = h.id AND hl.logged_date = CURRENT_DATE)",
                new { uid }).Select(r => (string)r["name"]!).ToList();
            lines.Add("\nHabits not yet done today: " + (unlogged.Count > 0 ? string.Join(", ", unlogged) : "all done"));
        }

        var currency = Money.DefaultCurrency(uid);
        var spent = Stats.Number(Db.Scalar<object>(
            @"SELECT COALESCE(SUM(amount), 0) FROM expenses
              WHERE user_id = @uid AND type = 'expense' AND spent_at >= (CURRENT_DATE - INTERVAL 6 DAY)",
            new { uid }));
        lines.Add($"\nSpent from {DateTime.Today.AddDays(-6):yyyy-MM-dd} to {AppInfo.Today()} (7 days including today): {Money.Text(spent, currency)}");

        foreach (var r in Db.Rows(
            @"SELECT c.name, c.monthly_budget,
                COALESCE(SUM(CASE WHEN e.type = 'expense' THEN e.amount END), 0) AS spent
              FROM expense_categories c
              LEFT JOIN expenses e ON e.category_id = c.id AND e.user_id = c.user_id
                                  AND DATE_FORMAT(e.spent_at, '%Y-%m') = DATE_FORMAT(CURRENT_DATE, '%Y-%m')
              WHERE c.user_id = @uid AND c.monthly_budget IS NOT NULL
              GROUP BY c.id HAVING spent > c.monthly_budget * 0.8",
            new { uid }))
        {
            lines.Add($"- Budget alert ({now.ToString("MMMM yyyy", CultureInfo.InvariantCulture)}, month to date): {r["name"]} at "
                + Money.Text(Stats.Number(r["spent"]), currency) + " of " + Money.Text(Stats.Number(r["monthly_budget"]), currency));
        }

        if (withIds)
        {
            var categories = Db.Rows("SELECT id, name FROM expense_categories WHERE user_id = @uid ORDER BY name ASC", new { uid })
                .Select(r => $"[id {r["id"]}] {r["name"]}").ToList();
            if (categories.Count > 0) lines.Add("\nExpense categories: " + string.Join(", ", categories));
        }

        var stale = Db.Rows(
            "SELECT id, name, staleness_days FROM repos WHERE user_id = @uid AND staleness_days >= @days ORDER BY staleness_days DESC LIMIT 5",
            new { uid, days = Repos.StaleDays(uid) });
        if (stale.Count > 0)
        {
            lines.Add("\nNeglected repos:");
            foreach (var r in stale) lines.Add("- " + (withIds ? $"[id {r["id"]}] " : "") + r["name"] + $" ({r["staleness_days"]} days idle)");
        }

        var goals = withIds
            ? Db.Rows(
                @"SELECT id, title, current_value, target_value, unit, status FROM goals
                  WHERE user_id = @uid AND status IN ('active', 'paused') ORDER BY status ASC, id ASC LIMIT 8",
                new { uid })
            : Db.Rows("SELECT id, title, current_value, target_value, unit FROM goals WHERE user_id = @uid AND status = 'active' LIMIT 6", new { uid });
        if (goals.Count > 0)
        {
            lines.Add("\nActive goals:");
            foreach (var r in goals)
            {
                var status = r.GetValueOrDefault("status") as string;
                lines.Add("- " + (withIds ? $"[id {r["id"]}] " : "") + r["title"] + ": " + r["current_value"]
                    + (Truthy(r["target_value"]) ? $"/{r["target_value"]}" : "") + " " + r["unit"]
                    + (status != null && status != "active" ? $" ({status})" : ""));
            }
        }

        if (withIds)
        {
            var notes = Db.Rows(
                @"SELECT id, title, LEFT(content, 60) AS preview FROM notes
                  WHERE user_id = @uid ORDER BY pinned DESC, updated_at DESC, id DESC LIMIT 8",
                new { uid });
            if (notes.Count > 0)
            {
                lines.Add("\nRecent notes:");
                foreach (var r in notes)
                {
                    var title = (r["title"] as string)?.Trim();
                    var label = string.IsNullOrEmpty(title) ? Regex.Replace(r["preview"] as string ?? "", @"\s+", " ") + "…" : title;
                    lines.Add($"- [id {r["id"]}] {label}");
                }
            }

            var recent = Db.Rows(
                @"SELECT e.id, e.type, e.amount, e.currency, e.spent_at, e.description, c.name AS category
                  FROM expenses e LEFT JOIN expense_categories c ON c.id = e.category_id AND c.user_id = e.user_id
                  WHERE e.user_id = @uid ORDER BY e.id DESC LIMIT 10",
                new { uid });
            if (recent.Count > 0)
            {
                lines.Add("\nMost recently added money entries (newest first):");
                foreach (var r in recent)
                {
                    lines.Add($"- [id {r["id"]}] {r["spent_at"]} "
                        + ((string)r["type"]! == "income" ? "income " : "expense ")
                        + Money.Text(Stats.Number(r["amount"]), (string)r["currency"]!)
                        + (Truthy(r["description"]) ? " — " + r["description"] : "")
                        + (Truthy(r["category"]) ? $" ({r["category"]})" : ""));
                }
            }
        }

        return string.Join("\n", lines);
    }

    // A markdown review of the last 7 days of activity.
    public static async Task<string> WeeklyReview(int uid)
    {
        var rows = Db.Rows(
            @"SELECT type, summary, actor, created_at FROM activity_log
              WHERE user_id = @uid AND created_at >= (CURRENT_DATE - INTERVAL 6 DAY)
              ORDER BY created_at ASC LIMIT 300",
            new { uid });
        if (rows.Count == 0) return "_No activity in the last 7 days._";

        var lines = rows.Select(r => $"{((string)r["created_at"]!)[..10]} [{r["type"]}] {r["summary"]}");
        var system = "You are reviewing the user's past week from their activity log. The log below covers "
            + $"{DateTime.Today.AddDays(-6):yyyy-MM-dd} to {AppInfo.Today()} (7 days including today). Any money figure without an "
            + $"explicit currency code is in {Money.DefaultCurrency(uid)}. Write a warm, honest weekly "
            + "review in markdown: a short summary sentence, \"Wins\" and \"Watch-outs\" sections as bullets, and one "
            + "concrete suggestion for next week. Be specific to the data; keep it under 250 words.";
        return await Ai.Generate(uid, system, string.Join("\n", lines), maxTokens: 700);
    }

    // PHP-style truthiness for a database value: null, 0, "" and "0" are false.
    public static bool Truthy(object? value) => value switch
    {
        null => false,
        string s => s is not ("" or "0"),
        int i => i != 0,
        long l => l != 0,
        _ => true,
    };
}
