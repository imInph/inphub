using System.Globalization;
using Inphub.Core;

namespace Inphub.Endpoints;

public static class Habits
{
    static readonly string[] Frequencies = ["daily", "weekly"];

    // GET/POST /api/habits: list (with streaks), create, update, delete, log.
    public static void Map(WebApplication app) =>
        app.MapMethods("/api/habits", ["GET", "POST"], Api.Handle(Run));

    // Dispatches on ?action=.
    static object? Run(Req req)
    {
        var uid = req.Uid;
        var input = req.Input;

        switch (req.Action)
        {
            case "list":
                return List(uid);
            case "create":
            {
                var name = input.Str("name") ?? throw Api.Fail("Habit name is required.", 422);
                var id = Db.Insert(
                    @"INSERT INTO habits (user_id, name, description, frequency, target_per_period, color, icon, sort_order)
                      VALUES (@uid, @name, @description, @frequency, @target, @color, @icon, @sort_order)",
                    new
                    {
                        uid, name,
                        description = input.Str("description"),
                        frequency = Api.ValidEnum(input.Text("frequency"), Frequencies, "daily"),
                        target = Math.Max(1, input.Int("target_per_period", 1)),
                        color = input.Str("color") ?? "#4f8cff",
                        icon = input.Str("icon"),
                        sort_order = input.Int("sort_order"),
                    });
                return new { id };
            }
            case "update":
            {
                var habit = Api.FetchOwned("habits", input.Int("id"), uid);
                var id = Convert.ToInt32(habit["id"]);
                var frequency = (string)habit["frequency"]!;
                Db.Execute(
                    @"UPDATE habits SET name = @name, description = @description, frequency = @frequency, target_per_period = @target,
                        color = @color, icon = @icon, is_active = @is_active, sort_order = @sort_order
                      WHERE id = @id AND user_id = @uid",
                    new
                    {
                        id, uid,
                        name = input.Str("name") ?? (string)habit["name"]!,
                        description = input.StrIfSent("description", habit["description"]),
                        frequency = Api.ValidEnum(input.Str("frequency") ?? frequency, Frequencies, frequency),
                        target = Math.Max(1, input.Int("target_per_period", Convert.ToInt32(habit["target_per_period"]))),
                        color = input.Str("color") ?? (string)habit["color"]!,
                        icon = input.StrIfSent("icon", habit["icon"]),
                        is_active = input.Bool("is_active", Convert.ToInt32(habit["is_active"]) != 0) ? 1 : 0,
                        sort_order = input.Int("sort_order", Convert.ToInt32(habit["sort_order"])),
                    });
                return new { id };
            }
            case "delete":
            {
                var habit = Api.FetchOwned("habits", input.Int("id"), uid);
                var id = Convert.ToInt32(habit["id"]);
                Db.Execute("DELETE FROM habits WHERE id = @id AND user_id = @uid", new { id, uid });
                return new { deleted = id };
            }
            case "log":
                return Log(uid, input);
            default:
                throw Api.Fail("Unknown action.", 404);
        }
    }

    // Every habit with its recent logs, today's count and streaks.
    static object List(int uid)
    {
        var habits = Db.Rows("SELECT * FROM habits WHERE user_id = @uid ORDER BY sort_order ASC, id ASC", new { uid });
        var logs = Db.Rows(
            @"SELECT habit_id, logged_date, count FROM habit_logs
              WHERE user_id = @uid AND logged_date >= (CURRENT_DATE - INTERVAL 140 DAY)
              ORDER BY logged_date ASC",
            new { uid });

        var today = AppInfo.Today();
        foreach (var habit in habits)
        {
            var id = Convert.ToInt32(habit["id"]);
            var target = Math.Max(1, Convert.ToInt32(habit["target_per_period"]));
            var own = logs.Where(l => Convert.ToInt32(l["habit_id"]) == id).ToList();

            var doneDates = new List<string>();
            var todayCount = 0;
            foreach (var log in own)
            {
                var date = (string)log["logged_date"]!;
                var count = Convert.ToInt32(log["count"]);
                if (count >= target) doneDates.Add(date);
                if (date == today) todayCount = count;
            }

            var (current, best) = habit["frequency"] as string == "weekly" ? WeekStreaks(doneDates) : DayStreaks(doneDates);
            habit["logs"] = own;
            habit["target"] = target;
            habit["today_count"] = todayCount;
            habit["logged_today"] = todayCount >= target;
            habit["current_streak"] = current;
            habit["best_streak"] = best;
        }
        return habits;
    }

    // One tap: counts the day up toward the target; the tap after the target clears it.
    static object Log(int uid, Input input)
    {
        var habit = Api.FetchOwned("habits", input.Int("id"), uid);
        var id = Convert.ToInt32(habit["id"]);
        var name = (string)habit["name"]!;
        var date = input.Str("date") ?? AppInfo.Today();
        var target = Math.Max(1, Convert.ToInt32(habit["target_per_period"]));

        var row = Db.Row("SELECT id, count FROM habit_logs WHERE habit_id = @id AND logged_date = @date", new { id, date });
        if (row == null)
        {
            Db.Execute("INSERT INTO habit_logs (user_id, habit_id, logged_date, count, note) VALUES (@uid, @id, @date, 1, @note)",
                new { uid, id, date, note = input.Str("note") });
            Activity.Log(uid, "habit.logged", "habit", id, "Logged habit: " + name + (target > 1 ? $" (1/{target})" : ""));
            return new { logged = true, count = 1, target, date };
        }

        var count = Convert.ToInt32(row["count"]);
        if (count < target)
        {
            var next = count + 1;
            Db.Execute("UPDATE habit_logs SET count = @next WHERE id = @logId", new { next, logId = row["id"] });
            Activity.Log(uid, "habit.logged", "habit", id, $"Logged habit: {name} ({next}/{target})");
            return new { logged = true, count = next, target, date };
        }

        Db.Execute("DELETE FROM habit_logs WHERE id = @logId", new { logId = row["id"] });
        Activity.Log(uid, "habit.unlogged", "habit", id, $"Cleared habit: {name} on {date}");
        return new { logged = false, count = 0, target, date };
    }

    // Current and best runs of consecutive days.
    static (int Current, int Best) DayStreaks(List<string> dates)
    {
        var days = dates.Select(d => DateTime.ParseExact(d, "yyyy-MM-dd", CultureInfo.InvariantCulture)).ToHashSet();
        return Runs(days, DateTime.Today, d => d.AddDays(1), d => d.AddDays(-1));
    }

    // Current and best runs of consecutive ISO weeks with at least one done day.
    static (int Current, int Best) WeekStreaks(List<string> dates)
    {
        var weeks = dates.Select(d => WeekStart(DateTime.ParseExact(d, "yyyy-MM-dd", CultureInfo.InvariantCulture))).ToHashSet();
        return Runs(weeks, WeekStart(DateTime.Today), w => w.AddDays(7), w => w.AddDays(-7));
    }

    // Longest run anywhere, and the run ending now (or one step back if now isn't done yet).
    static (int Current, int Best) Runs(HashSet<DateTime> set, DateTime now, Func<DateTime, DateTime> next, Func<DateTime, DateTime> prev)
    {
        var best = 0;
        foreach (var start in set)
        {
            if (set.Contains(prev(start))) continue;
            var length = 1;
            var cursor = start;
            while (set.Contains(next(cursor)))
            {
                cursor = next(cursor);
                length++;
            }
            best = Math.Max(best, length);
        }

        var current = 0;
        var at = set.Contains(now) ? now : prev(now);
        while (set.Contains(at))
        {
            current++;
            at = prev(at);
        }
        return (current, best);
    }

    // The Monday that starts a date's ISO week.
    static DateTime WeekStart(DateTime d) => d.Date.AddDays(-(((int)d.DayOfWeek + 6) % 7));
}
