using System.Globalization;
using System.Text.Encodings.Web;
using System.Text.Json;
using Inphub.Core;
using MySqlConnector;

namespace Inphub.Services;

public record ParsedBackup(
    Dictionary<string, int> Counts,
    List<string> Warnings,
    Dictionary<string, List<Dictionary<string, object?>>> Rows,
    Dictionary<string, string> Meta);

// BACKUP-FORMAT.md is the contract and inphub lite has an identical copy; change both or neither.
public static class Backup
{
    public const string Format = "inphub-backup";
    public const int FormatVersion = 1;

    public static readonly string[] TablesShared =
    [
        "settings", "expense_categories", "todos", "habits", "goals", "notes", "repos",
        "expenses", "habit_logs", "focus_sessions", "activity_log",
    ];

    public static readonly string[] TablesInphub = ["repo_suggestions", "daily_briefs", "chat_sessions", "chat_messages"];

    public static readonly string[] SecretKeys = ["github_token", "claude_api_key", "lmstudio_api_key"];

    static readonly Dictionary<string, string[]> DatetimeColumns = new()
    {
        ["todos"] = ["created_at", "updated_at", "completed_at"],
        ["expenses"] = ["created_at"],
        ["expense_categories"] = ["created_at"],
        ["repos"] = ["last_pushed_at", "last_synced_at", "created_at"],
        ["habits"] = ["created_at"],
        ["habit_logs"] = ["created_at"],
        ["goals"] = ["created_at", "updated_at"],
        ["notes"] = ["created_at", "updated_at"],
        ["focus_sessions"] = ["started_at", "ended_at", "created_at"],
        ["activity_log"] = ["created_at"],
        ["repo_suggestions"] = ["created_at"],
        ["daily_briefs"] = ["created_at"],
        ["chat_sessions"] = ["created_at", "updated_at"],
        ["chat_messages"] = ["created_at"],
    };

    static readonly Dictionary<string, string[]> IntColumns = new()
    {
        ["todos"] = ["id", "sort_order"],
        ["expense_categories"] = ["id"],
        ["expenses"] = ["id", "category_id", "is_recurring"],
        ["repos"] =
        [
            "id", "github_id", "stars", "forks", "open_issues", "is_archived", "is_private", "has_readme",
            "has_license", "health_score", "staleness_days", "pinned",
        ],
        ["habits"] = ["id", "target_per_period", "is_active", "sort_order"],
        ["habit_logs"] = ["id", "habit_id", "count"],
        ["goals"] = ["id", "target_value", "current_value"],
        ["notes"] = ["id", "pinned"],
        ["focus_sessions"] = ["id", "linked_todo_id", "duration_minutes", "completed"],
        ["activity_log"] = ["id", "entity_id"],
        ["repo_suggestions"] = ["id", "repo_id"],
        ["daily_briefs"] = ["id"],
        ["chat_sessions"] = ["id"],
        ["chat_messages"] = ["id"],
    };

    static readonly Dictionary<string, string[]> DecimalColumns = new()
    {
        ["expenses"] = ["amount"],
        ["expense_categories"] = ["monthly_budget"],
    };

    static readonly Dictionary<string, string[]> JsonColumns = new()
    {
        ["activity_log"] = ["metadata"],
        ["chat_messages"] = ["actions"],
    };

    public static readonly Dictionary<string, string[]> ImportColumns = new()
    {
        ["expense_categories"] = ["id", "name", "color", "icon", "monthly_budget", "created_at"],
        ["todos"] =
        [
            "id", "title", "description", "status", "priority", "project", "tags", "due_date", "recurring",
            "sort_order", "created_by", "created_at", "updated_at", "completed_at",
        ],
        ["habits"] = ["id", "name", "description", "frequency", "target_per_period", "color", "icon", "is_active", "sort_order", "created_at"],
        ["goals"] = ["id", "title", "description", "category", "target_value", "current_value", "unit", "target_date", "status", "created_at", "updated_at"],
        ["notes"] = ["id", "title", "content", "tags", "pinned", "created_at", "updated_at"],
        ["repos"] =
        [
            "id", "github_id", "name", "full_name", "description", "url", "language", "stars", "forks",
            "open_issues", "default_branch", "is_archived", "is_private", "has_readme", "has_license",
            "readme_excerpt", "health_score", "staleness_days", "last_pushed_at", "last_synced_at", "pinned", "created_at",
        ],
        ["expenses"] =
        [
            "id", "type", "amount", "currency", "category_id", "description", "payment_method", "spent_at",
            "is_recurring", "recurring_interval", "created_by", "created_at",
        ],
        ["habit_logs"] = ["id", "habit_id", "logged_date", "count", "note", "created_at"],
        ["focus_sessions"] = ["id", "label", "linked_todo_id", "duration_minutes", "started_at", "ended_at", "completed", "created_at"],
        ["activity_log"] = ["id", "type", "entity_type", "entity_id", "summary", "actor", "metadata", "created_at"],
        ["repo_suggestions"] = ["id", "repo_id", "title", "detail", "category", "priority", "status", "created_at"],
        ["daily_briefs"] = ["id", "brief_date", "content", "provider", "model", "created_at"],
        ["chat_sessions"] = ["id", "session_id", "title", "created_at", "updated_at"],
        ["chat_messages"] = ["id", "session_id", "role", "content", "actions", "created_at"],
    };

    static readonly Dictionary<string, string[]> ImportRequired = new()
    {
        ["expense_categories"] = ["name"],
        ["todos"] = ["title"],
        ["habits"] = ["name"],
        ["goals"] = ["title"],
        ["notes"] = ["content"],
        ["repos"] = ["name", "full_name"],
        ["expenses"] = ["amount", "spent_at"],
        ["habit_logs"] = ["habit_id", "logged_date"],
        ["focus_sessions"] = ["duration_minutes", "started_at"],
        ["activity_log"] = ["type", "summary"],
        ["repo_suggestions"] = ["repo_id", "title"],
        ["daily_briefs"] = ["brief_date", "content"],
        ["chat_sessions"] = ["session_id"],
        ["chat_messages"] = ["role", "content"],
    };

    static readonly Dictionary<string, (string Table, string Column)> ImportParents = new()
    {
        ["expenses"] = ("expense_categories", "category_id"),
        ["habit_logs"] = ("habits", "habit_id"),
        ["focus_sessions"] = ("todos", "linked_todo_id"),
        ["repo_suggestions"] = ("repos", "repo_id"),
    };

    public static readonly string[] ImportOrder =
    [
        "expense_categories", "todos", "habits", "goals", "notes", "repos", "chat_sessions",
        "expenses", "habit_logs", "focus_sessions", "repo_suggestions",
        "activity_log", "daily_briefs", "chat_messages",
    ];

    static readonly JsonSerializerOptions FileJson = new()
    {
        WriteIndented = true,
        IndentSize = 4,
        Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping,
    };

    // "YYYY-MM-DD HH:MM:SS" to "YYYY-MM-DDTHH:MM:SS"; null and empty stay null.
    public static string? DatetimeOut(string? value) =>
        string.IsNullOrEmpty(value) ? null : Clip(value, 19).Replace(' ', 'T');

    // The reverse, and fine with a file that already used a space.
    public static string? DatetimeIn(string? value) =>
        string.IsNullOrEmpty(value) ? null : Clip(value, 19).Replace('T', ' ');

    // One database row in file shapes: no user_id, T datetimes, numbers as numbers, JSON as JSON.
    public static Dictionary<string, object?> RowOut(string table, Dictionary<string, object?> row)
    {
        var result = new Dictionary<string, object?>(row);
        result.Remove("user_id");

        foreach (var col in DatetimeColumns.GetValueOrDefault(table, []))
        {
            if (result.TryGetValue(col, out var v)) result[col] = DatetimeOut(v?.ToString());
        }
        foreach (var col in IntColumns.GetValueOrDefault(table, []))
        {
            if (result.TryGetValue(col, out var v)) result[col] = v == null ? null : ToLong(v);
        }
        foreach (var col in DecimalColumns.GetValueOrDefault(table, []))
        {
            if (result.TryGetValue(col, out var v)) result[col] = v == null ? null : Round2(ToDouble(v));
        }
        foreach (var col in JsonColumns.GetValueOrDefault(table, []))
        {
            if (result.TryGetValue(col, out var v) && v is string text) result[col] = DecodeJson(text);
        }
        return result;
    }

    // The whole document for one account; the secret settings are left out, not masked.
    public static Dictionary<string, object?> Build(int uid)
    {
        var data = new Dictionary<string, object?>();
        var counts = new Dictionary<string, int>();

        foreach (var table in TablesShared.Concat(TablesInphub))
        {
            var rows = Db.Rows($"SELECT * FROM `{table}` WHERE user_id = @uid", new { uid });
            if (table == "settings")
            {
                var settings = rows
                    .Where(r => !SecretKeys.Contains((string)r["setting_key"]!))
                    .Select(r => new Dictionary<string, object?> { ["key"] = r["setting_key"], ["value"] = r["setting_value"] as string ?? "" })
                    .ToList();
                data[table] = settings;
                counts[table] = settings.Count;
                continue;
            }
            data[table] = rows.Select(r => RowOut(table, r)).ToList();
            counts[table] = rows.Count;
        }

        return new Dictionary<string, object?>
        {
            ["format"] = Format,
            ["format_version"] = FormatVersion,
            ["app"] = "inphub",
            ["app_version"] = AppInfo.Version,
            ["exported_at"] = DateTime.Now.ToString("yyyy-MM-ddTHH:mm:ss", CultureInfo.InvariantCulture),
            ["counts"] = counts,
            ["data"] = data,
        };
    }

    // The document as the file's text: 4-space indent, and letters and emoji written as themselves, like PHP did.
    public static string ToFileText(Dictionary<string, object?> document) =>
        EscapedPair.Replace(JsonSerializer.Serialize(document, FileJson), m =>
            char.ConvertFromUtf32(char.ConvertToUtf32(
                (char)Convert.ToInt32(m.Groups[1].Value, 16), (char)Convert.ToInt32(m.Groups[2].Value, 16))));

    // .NET always escapes emoji as a 🍔 pair; this finds one that isn't itself behind a backslash.
    static readonly System.Text.RegularExpressions.Regex EscapedPair =
        new(@"(?<=(?:^|[^\\])(?:\\\\)*)\\u(D[89AB][0-9A-F]{2})\\u(D[C-F][0-9A-F]{2})", System.Text.RegularExpressions.RegexOptions.IgnoreCase);

    // The filename both apps use.
    public static string FileName() => $"inphub-backup-{AppInfo.Today()}.txt";

    // Reads and checks a file without touching the database; anything structural throws a 422.
    public static ParsedBackup Parse(string text)
    {
        JsonElement doc;
        try
        {
            doc = JsonDocument.Parse(text.Trim()).RootElement.Clone();
        }
        catch (JsonException)
        {
            throw Api.Fail("That file is not valid JSON.", 422);
        }
        if (doc.ValueKind is not (JsonValueKind.Object or JsonValueKind.Array)) throw Api.Fail("That file is not valid JSON.", 422);
        if (doc.ValueKind != JsonValueKind.Object || Prop(doc, "format") is not { ValueKind: JsonValueKind.String } format || format.GetString() != Format)
        {
            throw Api.Fail("That is not an inphub backup file.", 422);
        }
        var version = Prop(doc, "format_version") is { } v ? Input.ToInt(v) : 0;
        if (version > FormatVersion)
        {
            throw Api.Fail($"That backup was written by a newer version (format {version}). Update inphub first.", 422);
        }
        if (Prop(doc, "data") is not { ValueKind: JsonValueKind.Object or JsonValueKind.Array } data)
        {
            throw Api.Fail("That backup has no data section.", 422);
        }

        var warnings = new List<string>();
        var rows = new Dictionary<string, List<Dictionary<string, object?>>>();
        var counts = new Dictionary<string, int>();

        foreach (var (table, list) in Entries(data))
        {
            if (table == "settings")
            {
                if (list.ValueKind is not (JsonValueKind.Array or JsonValueKind.Object)) throw Api.Fail("settings is not a list.", 422);
                var settings = new List<Dictionary<string, object?>>();
                foreach (var (_, row) in Entries(list))
                {
                    if (row.ValueKind != JsonValueKind.Object || Prop(row, "key") is not { } key || key.ValueKind == JsonValueKind.Null) continue;
                    if (key.ValueKind == JsonValueKind.String && SecretKeys.Contains(key.GetString()))
                    {
                        warnings.Add($"Ignored the stored value for {key.GetString()}; re-enter it in Settings.");
                        continue;
                    }
                    var value = Prop(row, "value") is { ValueKind: not JsonValueKind.Null } val ? Text(val) : "";
                    settings.Add(new Dictionary<string, object?> { ["key"] = Text(key), ["value"] = value });
                }
                rows["settings"] = settings;
                counts["settings"] = settings.Count;
                continue;
            }

            if (!ImportColumns.TryGetValue(table, out var allowed))
            {
                warnings.Add($"Skipped an unknown table: {table}.");
                continue;
            }
            if (list.ValueKind is not (JsonValueKind.Array or JsonValueKind.Object)) throw Api.Fail($"{table} is not a list.", 422);

            var clean = new List<Dictionary<string, object?>>();
            foreach (var (i, row) in Entries(list))
            {
                if (row.ValueKind != JsonValueKind.Object) throw Api.Fail($"{table} row {i} is not an object.", 422);
                foreach (var required in ImportRequired.GetValueOrDefault(table, []))
                {
                    var r = Prop(row, required);
                    if (r == null || r.Value.ValueKind == JsonValueKind.Null || (r.Value.ValueKind == JsonValueKind.String && r.Value.GetString() == ""))
                    {
                        throw Api.Fail($"{table} row {i} has no {required}.", 422);
                    }
                }
                var kept = new Dictionary<string, JsonElement>();
                foreach (var col in allowed)
                {
                    if (Prop(row, col) is { } value) kept[col] = value;
                }
                clean.Add(RowIn(table, kept));
            }
            rows[table] = clean;
            counts[table] = clean.Count;
        }

        return new ParsedBackup(counts, warnings, rows, new Dictionary<string, string>
        {
            ["app"] = Prop(doc, "app") is { ValueKind: not JsonValueKind.Null } app ? Text(app) : "unknown",
            ["app_version"] = Prop(doc, "app_version") is { ValueKind: not JsonValueKind.Null } appVersion ? Text(appVersion) : "",
            ["exported_at"] = Prop(doc, "exported_at") is { ValueKind: not JsonValueKind.Null } exportedAt ? Text(exportedAt) : "",
        });
    }

    // File shapes back into database values; the mirror of RowOut.
    public static Dictionary<string, object?> RowIn(string table, Dictionary<string, JsonElement> row)
    {
        var result = new Dictionary<string, object?>();
        foreach (var (col, value) in row) result[col] = Plain(value);

        foreach (var col in DatetimeColumns.GetValueOrDefault(table, []))
        {
            if (row.TryGetValue(col, out var v)) result[col] = v.ValueKind == JsonValueKind.Null ? null : DatetimeIn(Text(v));
        }
        foreach (var col in IntColumns.GetValueOrDefault(table, []))
        {
            if (row.TryGetValue(col, out var v)) result[col] = IsBlank(v) ? null : (long)Input.ToDouble(v);
        }
        foreach (var col in DecimalColumns.GetValueOrDefault(table, []))
        {
            if (row.TryGetValue(col, out var v)) result[col] = IsBlank(v) ? null : Round2(Input.ToDouble(v));
        }
        foreach (var col in JsonColumns.GetValueOrDefault(table, []))
        {
            if (row.TryGetValue(col, out var v))
            {
                result[col] = v.ValueKind switch
                {
                    JsonValueKind.Null => null,
                    JsonValueKind.String => v.GetString(),
                    _ => JsonSerializer.Serialize(v, FileJsonCompact),
                };
            }
        }
        return result;
    }

    static readonly JsonSerializerOptions FileJsonCompact = new() { Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping };

    // Writes a parsed backup into one account in a single transaction; returns rows written per table.
    public static Dictionary<string, int> Apply(int uid, ParsedBackup parsed, string mode)
    {
        mode = mode == "merge" ? "merge" : "replace";
        using var tx = Db.Begin();
        using var conn = tx.Connection!;
        try
        {
            if (mode == "replace")
            {
                foreach (var table in ImportOrder.Reverse())
                {
                    Db.Execute($"DELETE FROM `{table}` WHERE user_id = @uid", new { uid }, tx);
                }
                Db.Execute("DELETE FROM settings WHERE user_id = @uid AND setting_key NOT IN (@s0, @s1, @s2)",
                    new { uid, s0 = SecretKeys[0], s1 = SecretKeys[1], s2 = SecretKeys[2] }, tx);
            }

            var remap = new Dictionary<string, Dictionary<long, long>>();
            var written = new Dictionary<string, int>();
            foreach (var table in ImportOrder)
            {
                var list = parsed.Rows.GetValueOrDefault(table);
                if (list == null || list.Count == 0) continue;
                written[table] = InsertTable(tx, uid, table, list, mode, remap);
            }

            if (parsed.Rows.TryGetValue("settings", out var settings))
            {
                foreach (var row in settings)
                {
                    Db.Execute(
                        @"INSERT INTO settings (user_id, setting_key, setting_value) VALUES (@uid, @key, @value)
                          ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value)",
                        new { uid, key = row["key"], value = row["value"] }, tx);
                }
                written["settings"] = settings.Count;
            }

            tx.Commit();
            return written;
        }
        catch
        {
            tx.Rollback();
            throw;
        }
    }

    // Inserts one table's rows; merge mode drops ids, reuses colliding rows and remaps children.
    static int InsertTable(MySqlTransaction tx, int uid, string table, List<Dictionary<string, object?>> rows, string mode,
        Dictionary<string, Dictionary<long, long>> remap)
    {
        var keepIds = mode == "replace";
        var hasParent = ImportParents.TryGetValue(table, out var parent);
        if (!remap.ContainsKey(table)) remap[table] = new Dictionary<long, long>();
        var written = 0;

        foreach (var original in rows)
        {
            var row = new Dictionary<string, object?>(original);
            long? oldId = row.GetValueOrDefault("id") is long id ? id : null;
            if (!keepIds) row.Remove("id");

            if (hasParent && row.GetValueOrDefault(parent.Column) is long fk && fk != 0)
            {
                var parentMap = remap.GetValueOrDefault(parent.Table);
                if (parentMap != null && parentMap.TryGetValue(fk, out var moved)) row[parent.Column] = moved;
                else row[parent.Column] = keepIds ? fk : null;
            }

            row["user_id"] = uid;

            if (mode == "merge")
            {
                var existing = FindExisting(tx, uid, table, row);
                if (existing != null)
                {
                    if (oldId != null) remap[table][oldId.Value] = existing.Value;
                    MergeExisting(tx, table, existing.Value, row);
                    continue;
                }
            }

            var cols = row.Keys.ToList();
            var sql = $"INSERT INTO `{table}` (`{string.Join("`,`", cols)}`) VALUES ({string.Join(",", cols.Select(c => "@" + c))})";
            var newId = Db.Insert(sql, row, tx);
            if (oldId != null) remap[table][oldId.Value] = newId;
            written++;
        }
        return written;
    }

    // The row a merge would collide with (unique columns, plus the activity dedupe), or null.
    static long? FindExisting(MySqlTransaction tx, int uid, string table, Dictionary<string, object?> row)
    {
        var sql = table switch
        {
            "expense_categories" => "SELECT id FROM expense_categories WHERE user_id = @uid AND name = @name",
            "habits" => "SELECT id FROM habits WHERE user_id = @uid AND name = @name",
            "repos" => "SELECT id FROM repos WHERE user_id = @uid AND full_name = @full_name",
            "habit_logs" => "SELECT id FROM habit_logs WHERE habit_id = @habit_id AND logged_date = @logged_date",
            "chat_sessions" => "SELECT id FROM chat_sessions WHERE user_id = @uid AND session_id = @session_id",
            "daily_briefs" => "SELECT id FROM daily_briefs WHERE user_id = @uid AND brief_date = @brief_date",
            "activity_log" => "SELECT id FROM activity_log WHERE user_id = @uid AND created_at = @created_at AND type = @type AND summary = @summary",
            _ => null,
        };
        if (sql == null) return null;
        return Db.Scalar<long?>(sql, new
        {
            uid,
            name = row.GetValueOrDefault("name"),
            full_name = row.GetValueOrDefault("full_name"),
            habit_id = row.GetValueOrDefault("habit_id"),
            logged_date = row.GetValueOrDefault("logged_date"),
            session_id = row.GetValueOrDefault("session_id"),
            brief_date = row.GetValueOrDefault("brief_date"),
            created_at = row.GetValueOrDefault("created_at"),
            type = row.GetValueOrDefault("type"),
            summary = row.GetValueOrDefault("summary"),
        }, tx);
    }

    // On a collision the existing row wins, except habit_logs, which keeps max(count), never the sum.
    static void MergeExisting(MySqlTransaction tx, string table, long existingId, Dictionary<string, object?> row)
    {
        if (table != "habit_logs") return;
        var count = row.GetValueOrDefault("count") is long c ? c : 1;
        Db.Execute("UPDATE habit_logs SET count = GREATEST(count, @count) WHERE id = @existingId", new { count, existingId }, tx);
    }

    // A property of a JSON object, or null when missing.
    static JsonElement? Prop(JsonElement obj, string name) =>
        obj.ValueKind == JsonValueKind.Object && obj.TryGetProperty(name, out var v) ? v : null;

    // The (key, value) pairs of a JSON object, or (index, value) of an array.
    static IEnumerable<(string Key, JsonElement Value)> Entries(JsonElement container)
    {
        if (container.ValueKind == JsonValueKind.Object)
        {
            foreach (var p in container.EnumerateObject()) yield return (p.Name, p.Value);
        }
        else if (container.ValueKind == JsonValueKind.Array)
        {
            var i = 0;
            foreach (var item in container.EnumerateArray()) yield return ((i++).ToString(), item);
        }
    }

    // A JSON value as a plain database value (objects and arrays stay JSON text).
    static object? Plain(JsonElement v) => v.ValueKind switch
    {
        JsonValueKind.String => v.GetString(),
        JsonValueKind.Number => v.TryGetInt64(out var l) ? l : v.GetDouble(),
        JsonValueKind.True => 1,
        JsonValueKind.False => 0,
        JsonValueKind.Null => null,
        _ => v.GetRawText(),
    };

    // A JSON value as text, like PHP's (string) cast.
    static string Text(JsonElement v) => v.ValueKind switch
    {
        JsonValueKind.String => v.GetString() ?? "",
        JsonValueKind.True => "1",
        JsonValueKind.False or JsonValueKind.Null => "",
        _ => v.GetRawText(),
    };

    // True for null or an empty string.
    static bool IsBlank(JsonElement v) => v.ValueKind == JsonValueKind.Null || (v.ValueKind == JsonValueKind.String && v.GetString() == "");

    // Decodes a JSON column; only objects and arrays count, anything else is null.
    static JsonElement? DecodeJson(string text)
    {
        try
        {
            var value = JsonDocument.Parse(text).RootElement.Clone();
            return value.ValueKind is JsonValueKind.Object or JsonValueKind.Array ? value : null;
        }
        catch (JsonException)
        {
            return null;
        }
    }

    // A database number (int, long or decimal string) as a long.
    static long ToLong(object v) => v is string s ? (long)Input.LeadingNumber(s) : Convert.ToInt64(v, CultureInfo.InvariantCulture);

    // A database number as a double.
    static double ToDouble(object v) => v is string s ? Input.LeadingNumber(s) : Convert.ToDouble(v, CultureInfo.InvariantCulture);

    // Rounds half away from zero at 2dp, like PHP's round().
    static double Round2(double v) => Math.Round(v, 2, MidpointRounding.AwayFromZero);

    // The first n characters of a string.
    static string Clip(string s, int n) => s.Length > n ? s[..n] : s;
}
