using Inphub.Core;

namespace Inphub.Endpoints;

public static class Focus
{
    // GET/POST /api/focus: list (recent + totals + weekly bar), log, delete.
    public static void Map(WebApplication app) =>
        app.MapMethods("/api/focus", ["GET", "POST"], Api.Handle(Run));

    // Dispatches on ?action=.
    static object? Run(Req req)
    {
        var uid = req.Uid;
        var input = req.Input;

        switch (req.Action)
        {
            case "list":
                return List(uid);
            case "log":
            {
                var duration = input.Int("duration_minutes");
                if (duration <= 0) throw Api.Fail("duration_minutes must be positive.", 422);
                var todoId = input.IntOrNull("linked_todo_id");
                if (todoId != null) Api.FetchOwned("todos", todoId.Value, uid);

                var label = input.Str("label");
                var completed = input.Bool("completed", true);
                var id = Db.Insert(
                    @"INSERT INTO focus_sessions (user_id, label, linked_todo_id, duration_minutes, started_at, ended_at, completed)
                      VALUES (@uid, @label, @todoId, @duration, @started, @ended, @completed)",
                    new
                    {
                        uid, label, todoId, duration,
                        started = input.Str("started_at") ?? AppInfo.Now(),
                        ended = input.Str("ended_at") ?? AppInfo.Now(),
                        completed = completed ? 1 : 0,
                    });
                var summary = (completed ? $"Focused {duration} min" : $"Stopped after {duration} min") + (label != null ? ": " + label : "");
                Activity.Log(uid, completed ? "focus.completed" : "focus.stopped", "focus", id, summary);
                return new { id };
            }
            case "delete":
            {
                var session = Api.FetchOwned("focus_sessions", input.Int("id"), uid);
                var id = Convert.ToInt32(session["id"]);
                Db.Execute("DELETE FROM focus_sessions WHERE id = @id AND user_id = @uid", new { id, uid });
                Activity.Log(uid, "focus.deleted", "focus", id, $"Deleted a {session["duration_minutes"]} min session");
                return new { deleted = id };
            }
            default:
                throw Api.Fail("Unknown action.", 404);
        }
    }

    // Recent sessions plus today, week and all-time totals; interrupted sessions count too.
    static object List(int uid)
    {
        var sessions = Db.Rows(
            @"SELECT f.*, t.title AS todo_title
              FROM focus_sessions f
              LEFT JOIN todos t ON t.id = f.linked_todo_id AND t.user_id = f.user_id
              WHERE f.user_id = @uid
              ORDER BY f.started_at DESC LIMIT 30",
            new { uid });

        var todayTotal = Db.Scalar<int>(
            "SELECT COALESCE(SUM(duration_minutes), 0) FROM focus_sessions WHERE user_id = @uid AND DATE(started_at) = CURRENT_DATE",
            new { uid });

        var byDay = new Dictionary<string, int>();
        foreach (var row in Db.Rows(
            @"SELECT DATE(started_at) AS d, COALESCE(SUM(duration_minutes), 0) AS minutes
              FROM focus_sessions
              WHERE user_id = @uid AND started_at >= (CURRENT_DATE - INTERVAL 6 DAY)
              GROUP BY DATE(started_at)",
            new { uid }))
        {
            byDay[(string)row["d"]!] = Convert.ToInt32(row["minutes"]);
        }
        var weekly = new List<object>();
        for (var i = 6; i >= 0; i--)
        {
            var d = DateTime.Today.AddDays(-i).ToString("yyyy-MM-dd");
            weekly.Add(new { date = d, minutes = byDay.GetValueOrDefault(d) });
        }

        var totals = Db.Row(
            @"SELECT
                COALESCE(SUM(CASE WHEN started_at >= (CURRENT_DATE - INTERVAL 6 DAY) THEN duration_minutes END), 0) AS week,
                COALESCE(SUM(duration_minutes), 0) AS all_time,
                COUNT(*) AS sessions
              FROM focus_sessions WHERE user_id = @uid",
            new { uid })!;

        return new
        {
            sessions,
            today_total = todayTotal,
            week_total = Convert.ToInt32(totals["week"]),
            all_total = Convert.ToInt32(totals["all_time"]),
            session_count = Convert.ToInt32(totals["sessions"]),
            weekly,
        };
    }
}
