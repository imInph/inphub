using System.Text.Json;
using Inphub.Core;
using Inphub.Services;

namespace Inphub.Tools;

// The import against a real, throwaway database: dotnet run -- backup-dbtest
// Setup: mysql -u root -e "CREATE DATABASE inphub_import_test" && mysql -u root inphub_import_test < inphub.sql
public static class BackupDbTest
{
    const string TestDb = "inphub_import_test";
    const int Uid = 1;

    // Runs every check and returns the exit code; refuses any database but the test one.
    public static int Run()
    {
        var builder = new MySqlConnector.MySqlConnectionStringBuilder(Db.ConnectionString) { Database = TestDb };
        Db.ConnectionString = builder.ConnectionString;
        var name = Db.Scalar<string>("SELECT DATABASE()");
        if (name != TestDb)
        {
            Console.Error.WriteLine($"refusing to run against '{name}'");
            return 1;
        }

        var t = new Checks();

        Backup.Apply(Uid, Backup.Parse(Sample()), "replace");
        t.Check("replace wrote the expense", Count("SELECT COUNT(*) FROM expenses WHERE user_id = @uid"), 1L);
        t.Check("replace kept the category id", Db.Scalar<long>("SELECT id FROM expense_categories WHERE name = 'Imported Food'"), 40L);
        t.Check("replace kept the todo id", Db.Scalar<long>("SELECT id FROM todos WHERE title = 'Imported task'"), 70L);
        t.Check("the foreign key still points at it", Db.Scalar<long>("SELECT category_id FROM expenses WHERE id = 50"), 40L);
        t.Check("focus session still points at its todo", Db.Scalar<long>("SELECT linked_todo_id FROM focus_sessions WHERE id = 60"), 70L);
        t.Check("datetime landed as MySQL wrote it", Db.Row("SELECT created_at FROM expenses WHERE id = 50")?["created_at"], "2026-09-10 09:15:00");
        t.Check("amount is a real decimal", Db.Scalar<decimal>("SELECT amount FROM expenses WHERE id = 50"), 42.50m);
        t.Check("Turkish survived the round trip", Db.Scalar<string>("SELECT description FROM expenses WHERE id = 50"), "Kahvaltı");
        t.Check("inphub's own 'ai' author survived", Db.Scalar<string>("SELECT created_by FROM todos WHERE id = 70"), "ai");
        t.Check("JSON column re-encoded", Db.Scalar<string>("SELECT metadata FROM activity_log WHERE id = 80"), "{\"count\":4}");
        t.Check("the seeded categories were cleared first", Count("SELECT COUNT(*) FROM expense_categories WHERE user_id = @uid"), 1L);
        t.Check("settings were written",
            Db.Scalar<string>("SELECT setting_value FROM settings WHERE user_id = @uid AND setting_key = 'base_currency'", new { uid = Uid }), "TRY");

        Backup.Apply(Uid, Backup.Parse(Sample()), "replace");
        t.Check("a second replace does not duplicate", Count("SELECT COUNT(*) FROM expenses WHERE user_id = @uid"), 1L);

        Backup.Apply(Uid, Backup.Parse(Sample()), "merge");
        t.Check("merge reused the category rather than making a second",
            Count("SELECT COUNT(*) FROM expense_categories WHERE user_id = @uid AND name = 'Imported Food'"), 1L);
        t.Check("merge added the expense with a new id", Count("SELECT COUNT(*) FROM expenses WHERE user_id = @uid"), 2L);
        t.Check("the new expense points at the existing category", Count("SELECT COUNT(DISTINCT category_id) FROM expenses WHERE user_id = @uid"), 1L);
        t.Check("merge deduped the activity row", Count("SELECT COUNT(*) FROM activity_log WHERE user_id = @uid AND type = 'repos.synced'"), 1L);
        t.Check("merge reused the habit rather than doubling it", Count("SELECT COUNT(*) FROM habits WHERE user_id = @uid AND name = 'Imported habit'"), 1L);
        t.Check("habit_logs collided rather than inserting twice", Count("SELECT COUNT(*) FROM habit_logs WHERE user_id = @uid"), 1L);
        t.Check("habit_logs kept max(count), not the sum", Count("SELECT count FROM habit_logs WHERE user_id = @uid"), 2L);
        t.Check("merge reused today's brief rather than failing", Count("SELECT COUNT(*) FROM daily_briefs WHERE user_id = @uid"), 1L);

        Backup.Apply(Uid, Backup.Parse(Sample(habitLogCount: 5)), "merge");
        t.Check("a higher count wins", Count("SELECT count FROM habit_logs WHERE user_id = @uid"), 5L);
        Backup.Apply(Uid, Backup.Parse(Sample(habitLogCount: 1)), "merge");
        t.Check("a lower count does not lower it", Count("SELECT count FROM habit_logs WHERE user_id = @uid"), 5L);
        t.Check("and no extra habits appeared along the way", Count("SELECT COUNT(*) FROM habits WHERE user_id = @uid"), 1L);

        var before = Count("SELECT COUNT(*) FROM notes WHERE user_id = @uid");
        try
        {
            Backup.Apply(Uid, Backup.Parse(Sample(brokenNotes: true)), "merge");
            t.Check("a bad row aborts the import", "completed", "threw");
        }
        catch (Exception)
        {
            t.Check("a bad row aborts the import", "threw", "threw");
        }
        t.Check("and rolls back the good row with it", Count("SELECT COUNT(*) FROM notes WHERE user_id = @uid"), before);

        return t.Finish();
    }

    // A one-number query scoped to the test user.
    static long Count(string sql) => Db.Scalar<long>(sql, new { uid = Uid });

    // A file with a parent, two children, a foreign key, a habit log and a brief.
    static string Sample(int habitLogCount = 2, bool brokenNotes = false)
    {
        object[] notes = brokenNotes
            ?
            [
                new { id = 1, title = "fine", content = "ok", pinned = 0, created_at = "2026-09-01T10:00:00", updated_at = "2026-09-01T10:00:00" },
                new { id = 2, title = new string('x', 900), content = "too long a title", pinned = 0, created_at = "2026-09-01T10:00:00", updated_at = "2026-09-01T10:00:00" },
            ]
            : [];

        var doc = new
        {
            format = Backup.Format,
            format_version = Backup.FormatVersion,
            app = "inphub-lite",
            app_version = "1.0.0",
            exported_at = "2026-09-21T20:00:00",
            counts = new { },
            data = new
            {
                settings = new[] { new { key = "base_currency", value = "TRY" } },
                expense_categories = new[]
                {
                    new { id = 40, name = "Imported Food", color = "#f97316", icon = "🍔", monthly_budget = 200, created_at = "2026-01-02T08:00:00" },
                },
                todos = new[]
                {
                    new
                    {
                        id = 70, title = "Imported task", status = "todo", priority = "high", sort_order = 0, created_by = "ai",
                        created_at = "2026-09-01T12:00:00", updated_at = "2026-09-01T12:00:00", completed_at = (string?)null,
                    },
                },
                habits = new[]
                {
                    new { id = 90, name = "Imported habit", frequency = "daily", target_per_period = 3, color = "#22c55e", is_active = 1, sort_order = 1, created_at = "2026-01-01T00:00:00" },
                },
                habit_logs = new[]
                {
                    new { id = 91, habit_id = 90, logged_date = "2026-09-10", count = habitLogCount, note = (string?)null, created_at = "2026-09-10T20:00:00" },
                },
                expenses = new[]
                {
                    new
                    {
                        id = 50, type = "expense", amount = 42.5, currency = "TRY", category_id = 40, description = "Kahvaltı",
                        spent_at = "2026-09-10", is_recurring = 0, created_by = "user", created_at = "2026-09-10T09:15:00",
                    },
                },
                focus_sessions = new[]
                {
                    new
                    {
                        id = 60, label = "Imported focus", linked_todo_id = 70, duration_minutes = 25, started_at = "2026-09-10T09:00:00",
                        ended_at = "2026-09-10T09:25:00", completed = 1, created_at = "2026-09-10T09:25:00",
                    },
                },
                activity_log = new[]
                {
                    new
                    {
                        id = 80, type = "repos.synced", entity_type = "repo", entity_id = (int?)null, summary = "Synced 4 repositories",
                        actor = "system", metadata = new { count = 4 }, created_at = "2026-09-20T21:39:12",
                    },
                },
                daily_briefs = new[]
                {
                    new { id = 5, brief_date = "2026-09-10", content = "**Morning**", provider = "ollama", model = "llama3.1", created_at = "2026-09-10T07:00:00" },
                },
                goals = Array.Empty<object>(),
                notes,
                repos = Array.Empty<object>(),
            },
        };
        return JsonSerializer.Serialize(doc);
    }
}
