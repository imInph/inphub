using System.Globalization;
using System.Text.Json;
using Inphub.Auth;
using Inphub.Core;

namespace Inphub.Endpoints;

public static class Stats
{
    // GET /api/stats: dashboard (every widget's data) and expenses (Money view charts).
    public static void Map(WebApplication app) =>
        app.MapMethods("/api/stats", ["GET", "POST"], Api.Handle(Run));

    // Dispatches on ?action=.
    static object? Run(Req req)
    {
        return req.Action switch
        {
            "dashboard" => Dashboard(req.Uid),
            "expenses" => ExpenseCharts(req.Uid, Money.Window(req.Input)),
            _ => throw Api.Fail("Unknown action.", 404),
        };
    }

    // One payload for the whole dashboard.
    static object Dashboard(int uid)
    {
        var month = DateTime.Now.ToString("yyyy-MM");

        var todos = Db.Rows(
            @"SELECT * FROM todos
              WHERE user_id = @uid AND status IN ('todo', 'in_progress')
                AND (due_date IS NULL OR due_date <= CURRENT_DATE)
              ORDER BY (due_date IS NULL), due_date ASC, FIELD(priority, 'urgent', 'high', 'medium', 'low') LIMIT 12",
            new { uid });

        var habits = Db.Rows(
            @"SELECT h.*, (SELECT COUNT(*) FROM habit_logs hl WHERE hl.habit_id = h.id AND hl.logged_date = CURRENT_DATE) AS logged_today
              FROM habits h WHERE h.user_id = @uid AND h.is_active = 1 ORDER BY h.sort_order ASC",
            new { uid });

        var money = Db.Row(
            @"SELECT
                COALESCE(SUM(CASE WHEN type = 'expense' THEN amount END), 0) AS spent,
                COALESCE(SUM(CASE WHEN type = 'income' THEN amount END), 0) AS income
              FROM expenses WHERE user_id = @uid AND DATE_FORMAT(spent_at, '%Y-%m') = @month",
            new { uid, month })!;

        var topCategories = Db.Rows(
            @"SELECT c.name, c.color, c.icon, c.monthly_budget, COALESCE(SUM(e.amount), 0) AS total
              FROM expense_categories c
              LEFT JOIN expenses e ON e.category_id = c.id AND e.user_id = c.user_id AND e.type = 'expense'
                                  AND DATE_FORMAT(e.spent_at, '%Y-%m') = @month
              WHERE c.user_id = @uid
              GROUP BY c.id HAVING total > 0 ORDER BY total DESC LIMIT 5",
            new { uid, month });

        var staleDays = Repos.StaleDays(uid);
        var staleCount = Db.Scalar<int>("SELECT COUNT(*) FROM repos WHERE user_id = @uid AND staleness_days >= @staleDays", new { uid, staleDays });
        var neglected = Db.Row(
            @"SELECT name, full_name, staleness_days, health_score FROM repos WHERE user_id = @uid
              ORDER BY (staleness_days IS NULL), staleness_days DESC LIMIT 1",
            new { uid });

        var goals = Db.Rows(
            "SELECT * FROM goals WHERE user_id = @uid AND status = 'active' ORDER BY (target_date IS NULL), target_date ASC LIMIT 6",
            new { uid });

        var activity = Db.Rows("SELECT * FROM activity_log WHERE user_id = @uid ORDER BY created_at DESC, id DESC LIMIT 8", new { uid });

        var focus = Db.Row(
            @"SELECT
                COALESCE(SUM(CASE WHEN DATE(started_at) = CURRENT_DATE THEN duration_minutes END), 0) AS today,
                COALESCE(SUM(CASE WHEN started_at >= (CURRENT_DATE - INTERVAL 6 DAY) THEN duration_minutes END), 0) AS week
              FROM focus_sessions WHERE user_id = @uid",
            new { uid })!;

        var lastFocus = Db.Row(
            @"SELECT f.label, f.duration_minutes, f.started_at, t.title AS todo_title
              FROM focus_sessions f
              LEFT JOIN todos t ON t.id = f.linked_todo_id AND t.user_id = f.user_id
              WHERE f.user_id = @uid ORDER BY f.started_at DESC LIMIT 1",
            new { uid });

        var upcomingTodos = Db.Rows(
            @"SELECT id, title, priority, due_date FROM todos
              WHERE user_id = @uid AND status IN ('todo', 'in_progress')
                AND due_date > CURRENT_DATE AND due_date <= CURRENT_DATE + INTERVAL 7 DAY
              ORDER BY due_date ASC, FIELD(priority, 'urgent', 'high', 'medium', 'low'), id DESC LIMIT 20",
            new { uid });
        var upcomingGoals = Db.Rows(
            @"SELECT id, title, target_date FROM goals
              WHERE user_id = @uid AND status = 'active'
                AND target_date > CURRENT_DATE AND target_date <= CURRENT_DATE + INTERVAL 7 DAY
              ORDER BY target_date ASC, id DESC LIMIT 10",
            new { uid });

        var ownerName = Settings.Get(uid, "owner_name", "");
        if (string.IsNullOrEmpty(ownerName)) ownerName = AuthService.CurrentUser(uid)?["display_name"] as string ?? "";

        return new
        {
            layout = Appearance.DashboardLayout(uid),
            wallet = Wallet(uid),
            upcoming = new { todos = upcomingTodos, goals = upcomingGoals },
            owner_name = ownerName,
            currency = Money.DefaultCurrency(uid),
            ai_enabled = Settings.Get(uid, "ai_enabled", "0") == "1",
            shortcuts = Shortcuts(uid),
            todos,
            habits,
            money = new
            {
                spent = Number(money["spent"]),
                income = Number(money["income"]),
                top_categories = topCategories,
                month,
            },
            repos = new { stale_count = staleCount, most_neglected = neglected },
            goals,
            focus = new
            {
                today_minutes = Convert.ToInt32(focus["today"]),
                week_minutes = Convert.ToInt32(focus["week"]),
                last = lastFocus,
            },
            activity,
        };
    }

    // The all-time balance and how it moved over the last 30 days, walked back from today.
    static object Wallet(int uid)
    {
        var lifetime = Number(Db.Scalar<object>(
            "SELECT COALESCE(SUM(CASE WHEN type = 'income' THEN amount ELSE -amount END), 0) FROM expenses WHERE user_id = @uid",
            new { uid }));
        var balance = Money.StartingBalance(uid) + lifetime;

        var from = DateTime.Today.AddDays(-29).ToString("yyyy-MM-dd");
        var to = AppInfo.Today();
        var netByDay = new Dictionary<string, double>();
        foreach (var row in Db.Rows(
            @"SELECT spent_at AS d, COALESCE(SUM(CASE WHEN type = 'income' THEN amount ELSE -amount END), 0) AS net
              FROM expenses WHERE user_id = @uid AND spent_at >= @from AND spent_at <= @to
              GROUP BY d ORDER BY d ASC",
            new { uid, from, to }))
        {
            netByDay[(string)row["d"]!] = Number(row["net"]);
        }

        var future = Number(Db.Scalar<object>(
            "SELECT COALESCE(SUM(CASE WHEN type = 'income' THEN amount ELSE -amount END), 0) FROM expenses WHERE user_id = @uid AND spent_at > @to",
            new { uid, to }));
        var running = balance - future;

        var days = SeriesFill(netByDay, "day", from, to);
        var series = new object[days.Count];
        for (var i = days.Count - 1; i >= 0; i--)
        {
            series[i] = new { d = days[i].d, balance = Math.Round(running, 2) };
            running -= days[i].total;
        }
        return new { balance = Math.Round(balance, 2), series };
    }

    // The dashboard_shortcuts setting as a list, empty when unset or broken.
    static object Shortcuts(int uid)
    {
        try
        {
            var value = JsonDocument.Parse(Settings.Get(uid, "dashboard_shortcuts", "[]") ?? "[]").RootElement;
            if (value.ValueKind == JsonValueKind.Array) return value;
            if (value.ValueKind == JsonValueKind.Object) return value.EnumerateObject().Select(p => p.Value).ToList();
        }
        catch (JsonException)
        {
        }
        return Array.Empty<object>();
    }

    // Totals, donut, line and budgets for the Money view; budgets and all-time ignore the window.
    static object ExpenseCharts(int uid, MoneyWindow window)
    {
        var ranged = window.From != null;
        var range = ranged ? " AND e.spent_at >= @from AND e.spent_at <= @to" : "";
        var rangePlain = ranged ? " AND spent_at >= @from AND spent_at <= @to" : "";
        var args = new { uid, from = window.From, to = window.To };

        var categories = Db.Rows(
            @"SELECT c.name, c.color, COALESCE(SUM(e.amount), 0) AS total
              FROM expense_categories c
              LEFT JOIN expenses e ON e.category_id = c.id AND e.user_id = c.user_id AND e.type = 'expense'" + range + @"
              WHERE c.user_id = @uid
              GROUP BY c.id HAVING total > 0 ORDER BY total DESC",
            args);

        var uncategorised = Number(Db.Scalar<object>(
            "SELECT COALESCE(SUM(amount), 0) FROM expenses WHERE user_id = @uid AND type = 'expense' AND category_id IS NULL" + rangePlain,
            args));

        var totals = Db.Row(
            @"SELECT COALESCE(SUM(CASE WHEN type = 'expense' THEN amount END), 0) AS expense,
                     COALESCE(SUM(CASE WHEN type = 'income' THEN amount END), 0) AS income
              FROM expenses WHERE user_id = @uid" + rangePlain,
            args)!;

        var lifetime = Db.Row(
            @"SELECT COALESCE(SUM(CASE WHEN type = 'expense' THEN amount END), 0) AS expense,
                     COALESCE(SUM(CASE WHEN type = 'income' THEN amount END), 0) AS income
              FROM expenses WHERE user_id = @uid",
            new { uid })!;
        var opening = Money.StartingBalance(uid);

        var spanDays = ranged ? (Date(window.To!) - Date(window.From!)).Days + 1 : int.MaxValue;
        var granularity = spanDays <= 62 ? "day" : "month";
        var bucket = granularity == "day" ? "spent_at" : "DATE_FORMAT(spent_at, '%Y-%m')";
        var byBucket = new Dictionary<string, double>();
        foreach (var row in Db.Rows(
            $@"SELECT {bucket} AS d, COALESCE(SUM(amount), 0) AS total
               FROM expenses WHERE user_id = @uid AND type = 'expense'{rangePlain}
               GROUP BY d ORDER BY d ASC",
            args))
        {
            byBucket[(string)row["d"]!] = Number(row["total"]);
        }

        var firstOfMonth = new DateTime(DateTime.Today.Year, DateTime.Today.Month, 1);
        var budgets = Db.Rows(
            @"SELECT c.name, c.color, c.monthly_budget,
                     COALESCE(SUM(CASE WHEN e.type = 'expense' THEN e.amount END), 0) AS spent
              FROM expense_categories c
              LEFT JOIN expenses e ON e.category_id = c.id AND e.user_id = c.user_id
                                  AND e.spent_at >= @monthStart AND e.spent_at <= @monthEnd
              WHERE c.user_id = @uid AND c.monthly_budget IS NOT NULL
              GROUP BY c.id ORDER BY c.name ASC",
            new
            {
                uid,
                monthStart = firstOfMonth.ToString("yyyy-MM-dd"),
                monthEnd = firstOfMonth.AddMonths(1).AddDays(-1).ToString("yyyy-MM-dd"),
            });

        var byCategory = categories.Cast<object>().ToList();
        if (uncategorised > 0) byCategory.Add(new { name = "Uncategorised", color = "#6b7280", total = uncategorised });

        var expense = Number(totals["expense"]);
        var income = Number(totals["income"]);
        var lifeExpense = Number(lifetime["expense"]);
        var lifeIncome = Number(lifetime["income"]);

        return new
        {
            period = window.Period,
            label = window.Label,
            from = window.From,
            to = window.To,
            currency = Money.DefaultCurrency(uid),
            granularity,
            budget_month = DateTime.Now.ToString("yyyy-MM"),
            totals = new { expense, income, net = income - expense },
            all_time = new
            {
                expense = lifeExpense,
                income = lifeIncome,
                starting_balance = opening,
                current_net = opening + lifeIncome - lifeExpense,
            },
            by_category = byCategory,
            over_time = SeriesFill(byBucket, granularity, window.From, window.To),
            budgets,
        };
    }

    public record Point(string d, double total);

    // Zero-fills a series from the window start to today or the newest entry, capped at the window end.
    public static List<Point> SeriesFill(Dictionary<string, double> values, string granularity, string? from, string? to)
    {
        if (from == null && values.Count == 0) return [];

        var monthly = granularity == "month";
        var today = monthly ? DateTime.Now.ToString("yyyy-MM") : AppInfo.Today();
        var start = from != null ? (monthly ? from[..7] : from) : values.Keys.Min()!;

        var end = today;
        if (values.Count > 0 && string.CompareOrdinal(values.Keys.Max(), end) > 0) end = values.Keys.Max()!;
        if (to != null)
        {
            var cap = monthly ? to[..7] : to;
            if (string.CompareOrdinal(end, cap) > 0) end = cap;
        }
        if (string.CompareOrdinal(end, start) < 0) end = start;

        var result = new List<Point>();
        var cursor = Date(monthly ? start + "-01" : start);
        var last = Date(monthly ? end + "-01" : end);
        while (cursor <= last)
        {
            var key = monthly ? cursor.ToString("yyyy-MM") : cursor.ToString("yyyy-MM-dd");
            result.Add(new Point(key, values.GetValueOrDefault(key)));
            cursor = monthly ? cursor.AddMonths(1) : cursor.AddDays(1);
        }
        return result;
    }

    // A database number (which may come back as a decimal string) as a double.
    public static double Number(object? value) => value switch
    {
        null => 0,
        string s => Input.LeadingNumber(s),
        _ => Convert.ToDouble(value, CultureInfo.InvariantCulture),
    };

    // Parses a YYYY-MM-DD date.
    static DateTime Date(string value) => DateTime.ParseExact(value, "yyyy-MM-dd", CultureInfo.InvariantCulture);
}
