using System.Text.Json;
using Inphub.Core;
using Inphub.Services;

namespace Inphub.Tools;

// The backup format checked against itself, with no server and no database: dotnet run -- backup-selftest
public static class BackupSelfTest
{
    // Runs every check and returns the exit code.
    public static int Run()
    {
        var t = new Checks();

        t.Check("datetime out", Backup.DatetimeOut("2026-09-20 21:39:12"), "2026-09-20T21:39:12");
        t.Check("datetime in", Backup.DatetimeIn("2026-09-20T21:39:12"), "2026-09-20 21:39:12");
        t.Check("datetime out keeps null", Backup.DatetimeOut(null), null);
        t.Check("datetime in keeps null", Backup.DatetimeIn(""), null);
        t.Check("datetime in tolerates a space", Backup.DatetimeIn("2026-09-20 21:39:12"), "2026-09-20 21:39:12");

        var fromDb = new Dictionary<string, object?>
        {
            ["id"] = "17", ["user_id"] = "1", ["type"] = "expense", ["amount"] = "42.50", ["currency"] = "TRY",
            ["category_id"] = "2", ["description"] = "Kahvaltı", ["spent_at"] = "2026-09-10", ["is_recurring"] = "0",
            ["created_at"] = "2026-09-20 21:39:12",
        };
        var output = Backup.RowOut("expenses", fromDb);
        t.Check("row_out drops user_id", output.ContainsKey("user_id"), false);
        t.Check("row_out ids are ints", output["id"], 17L);
        t.Check("row_out decimals are numbers", output["amount"], 42.5);
        t.Check("row_out booleans are ints", output["is_recurring"], 0L);
        t.Check("row_out datetimes carry a T", output["created_at"], "2026-09-20T21:39:12");
        t.Check("row_out keeps Turkish", output["description"], "Kahvaltı");

        var back = Backup.RowIn("expenses", AsJson(output));
        t.Check("row_in restores the space", back["created_at"], "2026-09-20 21:39:12");
        t.Check("row_in keeps the number", back["amount"], 42.5);

        var meta = Backup.RowOut("activity_log", new Dictionary<string, object?>
        {
            ["id"] = "3", ["user_id"] = "1", ["type"] = "repos.synced", ["summary"] = "Synced", ["actor"] = "system",
            ["metadata"] = "{\"count\":4}", ["created_at"] = "2026-09-20 10:00:00",
        });
        t.Check("row_out decodes JSON columns", (meta["metadata"] as JsonElement?)?.GetRawText(), "{\"count\":4}");
        t.Check("row_in re-encodes them", Backup.RowIn("activity_log", AsJson(meta))["metadata"], "{\"count\":4}");

        var doc = new Dictionary<string, object?>
        {
            ["format"] = Backup.Format,
            ["format_version"] = Backup.FormatVersion,
            ["app"] = "inphub-lite",
            ["app_version"] = "1.0.0",
            ["exported_at"] = "2026-09-21T17:40:00",
            ["counts"] = new { },
            ["data"] = new Dictionary<string, object?>
            {
                ["settings"] = new object[] { new { key = "base_currency", value = "TRY" }, new { key = "github_token", value = "ghp_secret" } },
                ["expense_categories"] = new object[]
                {
                    new { id = 1, name = "Food & Drink", color = "#f97316", icon = "🍔", monthly_budget = 200, created_at = "2026-09-01T10:00:00" },
                },
                ["expenses"] = new object[]
                {
                    new
                    {
                        id = 5, type = "expense", amount = 42.5, currency = "TRY", category_id = 1, description = "Kahvaltı",
                        spent_at = "2026-09-10", is_recurring = 0, created_at = "2026-09-10T09:00:00", bogus_column = "x",
                    },
                },
                ["todos"] = Array.Empty<object>(),
                ["not_a_real_table"] = new object[] { new { a = 1 } },
            },
        };
        var parsed = Backup.Parse(JsonSerializer.Serialize(doc));
        t.Check("parse counts expenses", parsed.Counts["expenses"], 1);
        t.Check("parse drops an unknown column", parsed.Rows["expenses"][0].ContainsKey("bogus_column"), false);
        t.Check("parse converts the datetime back", parsed.Rows["expenses"][0]["created_at"], "2026-09-10 09:00:00");
        t.Check("parse warns about an unknown table", parsed.Warnings.Count > 1 && parsed.Warnings[1].Contains("not_a_real_table"), true);
        t.Check("parse refuses a secret", parsed.Rows["settings"].Count, 1);
        t.Check("parse keeps the non-secret setting", parsed.Rows["settings"][0]["key"], "base_currency");
        t.Check("parse reads the source app", parsed.Meta["app"], "inphub-lite");

        Rejects(t, "not JSON", "hello");
        Rejects(t, "not an inphub backup", """{"format":"something-else"}""");
        Rejects(t, "a newer format version", """{"format":"inphub-backup","format_version":99,"data":[]}""");
        Rejects(t, "no data section", """{"format":"inphub-backup","format_version":1}""");
        Rejects(t, "a table that is not a list", """{"format":"inphub-backup","format_version":1,"data":{"todos":"nope"}}""");
        Rejects(t, "a row with no title", """{"format":"inphub-backup","format_version":1,"data":{"todos":[{"description":"orphan"}]}}""");

        var exported = Backup.TablesShared.Concat(Backup.TablesInphub).Order().ToList();
        var importable = Backup.ImportColumns.Keys.Append("settings").Order().ToList();
        t.Check("exporter and importer agree on the tables", string.Join(",", exported), string.Join(",", importable));
        t.Check("insert order covers every table", Backup.ImportOrder.Length, Backup.ImportColumns.Count);

        return t.Finish();
    }

    // Checks that parsing the text throws the 422 a bad file gets.
    static void Rejects(Checks t, string what, string json)
    {
        try
        {
            Backup.Parse(json);
            t.Check(what, "accepted", "rejected");
        }
        catch (ApiException)
        {
            t.Check(what, "rejected", "rejected");
        }
    }

    // A row as the JSON values Parse would have read from a file.
    static Dictionary<string, JsonElement> AsJson(Dictionary<string, object?> row) =>
        row.ToDictionary(p => p.Key, p => JsonSerializer.SerializeToElement(p.Value));
}
