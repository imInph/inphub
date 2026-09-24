using System.Globalization;
using Inphub.Core;

namespace Inphub.Endpoints;

public static class Insights
{
    // GET /api/insights: summary, the whole Insights view in one call; nothing is stored.
    public static void Map(WebApplication app) =>
        app.MapMethods("/api/insights", ["GET", "POST"], Api.Handle(Run));

    // Builds every chart for the requested period.
    static object? Run(Req req)
    {
        if (req.Action != "summary" && req.Action != "list") throw Api.Fail("Unknown action.", 404);

        var uid = req.Uid;
        var window = Money.Window(req.Input);
        var from = window.From;
        var to = window.To;
        var ranged = from != null;
        string Range(string column) => ranged ? $" AND {column} >= @from AND {column} <= @to" : "";
        var args = new { uid, from, to };
        var timeArgs = new { uid, from = from + " 00:00:00", to = to + " 23:59:59" };

        var money = Db.Row(
            @"SELECT COALESCE(SUM(CASE WHEN type = 'expense' THEN amount END), 0) AS spend,
                     COALESCE(SUM(CASE WHEN type = 'income' THEN amount END), 0) AS income
              FROM expenses WHERE user_id = @uid" + Range("spent_at"),
            args)!;
        var tasksDone = Db.Scalar<int>("SELECT COUNT(*) FROM todos WHERE user_id = @uid AND completed_at IS NOT NULL" + Range("DATE(completed_at)"), args);
        var focusMinutes = Db.Scalar<int>("SELECT COALESCE(SUM(duration_minutes), 0) FROM focus_sessions WHERE user_id = @uid" + Range("DATE(started_at)"), args);
        var notes = Db.Scalar<int>("SELECT COUNT(*) FROM notes WHERE user_id = @uid" + Range("DATE(created_at)"), args);

        var byWeekday = new Dictionary<int, (double Total, int Count)>();
        foreach (var row in Db.Rows(
            @"SELECT WEEKDAY(spent_at) AS dow, COALESCE(SUM(amount), 0) AS total, COUNT(*) AS n
              FROM expenses WHERE user_id = @uid AND type = 'expense'" + Range("spent_at") + " GROUP BY dow ORDER BY dow",
            args))
        {
            byWeekday[Convert.ToInt32(row["dow"])] = (Stats.Number(row["total"]), Convert.ToInt32(row["n"]));
        }
        var weekdays = Enumerable.Range(0, 7).Select(i => new
        {
            dow = i,
            total = byWeekday.TryGetValue(i, out var w) ? w.Total : 0.0,
            count = byWeekday.TryGetValue(i, out var c) ? c.Count : 0,
        }).ToList();

        var habitRows = Db.Rows(
            @"SELECT h.id, h.name, h.color, GREATEST(h.target_per_period, 1) AS target,
                     COUNT(DISTINCT CASE WHEN hl.count >= GREATEST(h.target_per_period, 1) THEN hl.logged_date END) AS done_days
              FROM habits h
              LEFT JOIN habit_logs hl ON hl.habit_id = h.id AND hl.user_id = h.user_id" + Range("hl.logged_date") + @"
              WHERE h.user_id = @uid AND h.is_active = 1
              GROUP BY h.id ORDER BY done_days DESC, h.sort_order ASC",
            args);

        int days;
        if (ranged)
        {
            var end = Date(to!) < DateTime.Today ? Date(to!) : DateTime.Today;
            days = Math.Max(1, (end - Date(from!)).Days + 1);
        }
        else
        {
            var first = Db.Scalar<DateTime?>("SELECT MIN(logged_date) FROM habit_logs WHERE user_id = @uid", new { uid });
            days = first == null ? 1 : Math.Max(1, (DateTime.Today - first.Value.Date).Days + 1);
        }

        var rateTotal = 0.0;
        var habits = new List<object>();
        foreach (var row in habitRows)
        {
            var doneDays = Convert.ToInt32(row["done_days"]);
            var rate = Math.Min(1.0, (double)doneDays / days);
            rateTotal += rate;
            var color = row["color"] as string;
            habits.Add(new
            {
                id = Convert.ToInt32(row["id"]),
                name = (string)row["name"]!,
                color = string.IsNullOrEmpty(color) ? "#4f8cff" : color,
                done_days = doneDays,
                rate = Math.Round(rate, 4),
            });
        }

        var spanDays = ranged ? (Date(to!) - Date(from!)).Days + 1 : int.MaxValue;
        var granularity = spanDays <= 62 ? "day" : "month";
        string Bucket(string column) => granularity == "day" ? $"DATE({column})" : $"DATE_FORMAT({column}, '%Y-%m')";

        var focus = Series(
            $"SELECT {Bucket("started_at")} AS d, COALESCE(SUM(duration_minutes), 0) AS v FROM focus_sessions WHERE user_id = @uid"
            + Range("DATE(started_at)") + " GROUP BY d ORDER BY d",
            args, granularity, from, to);
        var velocity = Series(
            $"SELECT {Bucket("completed_at")} AS d, COUNT(*) AS v FROM todos WHERE user_id = @uid AND completed_at IS NOT NULL"
            + Range("DATE(completed_at)") + " GROUP BY d ORDER BY d",
            args, granularity, from, to);

        var byHour = new Dictionary<int, int>();
        foreach (var row in Db.Rows(
            "SELECT HOUR(created_at) AS h, COUNT(*) AS n FROM activity_log WHERE user_id = @uid" + Range("created_at") + " GROUP BY h ORDER BY h",
            timeArgs))
        {
            byHour[Convert.ToInt32(row["h"])] = Convert.ToInt32(row["n"]);
        }
        var hours = Enumerable.Range(0, 24).Select(h => new { hour = h, count = byHour.GetValueOrDefault(h) }).ToList();

        var categories = Db.Rows(
            @"SELECT c.name, c.color, COALESCE(SUM(e.amount), 0) AS total
              FROM expense_categories c
              LEFT JOIN expenses e ON e.category_id = c.id AND e.user_id = c.user_id AND e.type = 'expense'" + Range("e.spent_at") + @"
              WHERE c.user_id = @uid
              GROUP BY c.id HAVING total > 0 ORDER BY total DESC LIMIT 8",
            args);

        return new
        {
            period = window.Period,
            label = window.Label,
            from,
            to,
            days,
            currency = Money.DefaultCurrency(uid),
            granularity,
            totals = new
            {
                spend = Stats.Number(money["spend"]),
                income = Stats.Number(money["income"]),
                tasks_done = tasksDone,
                focus_minutes = focusMinutes,
                notes,
                habit_rate = habits.Count > 0 ? Math.Round(rateTotal / habits.Count, 4) : 0.0,
            },
            weekday = weekdays,
            habits,
            focus,
            velocity,
            hours,
            categories,
        };
    }

    // Runs a (d, v) query and zero-fills it like the Money chart does.
    static List<object> Series(string sql, object args, string granularity, string? from, string? to)
    {
        var values = new Dictionary<string, double>();
        foreach (var row in Db.Rows(sql, args)) values[(string)row["d"]!] = Stats.Number(row["v"]);
        return Stats.SeriesFill(values, granularity, from, to).Select(p => (object)new { p.d, value = p.total }).ToList();
    }

    // Parses a YYYY-MM-DD date.
    static DateTime Date(string value) => DateTime.ParseExact(value, "yyyy-MM-dd", CultureInfo.InvariantCulture);
}
