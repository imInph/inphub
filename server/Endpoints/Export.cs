using System.Text;
using System.Text.Encodings.Web;
using System.Text.Json;
using Inphub.Auth;
using Inphub.Core;
using Yarp.ReverseProxy.Forwarder;

namespace Inphub.Endpoints;

public static class Export
{
    static readonly JsonSerializerOptions Pretty = new() { WriteIndented = true, IndentSize = 4, Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping };

    // GET /api/export: file downloads. The backup format is still PHP's (shared with inphub lite), so it is forwarded.
    public static void Map(WebApplication app) =>
        app.MapGet("/api/export", Run);

    // Picks the export by ?action=; not signed in means a trip to the login page.
    static async Task<IResult> Run(HttpContext ctx, IHttpForwarder forwarder)
    {
        var uid = ctx.UserId();
        if (uid == 0) return Results.Redirect("/login");

        var action = ctx.Request.Query["action"].ToString();
        if (action == "") action = "backup";
        var stamp = AppInfo.Today();

        if (action == "expenses_csv") return ExpensesCsv(uid, stamp);
        if (action.StartsWith("todos_")) return TodosExport(uid, action, stamp);
        return await PhpBridge.Forward(ctx, forwarder, "export.php");
    }

    // The expenses ledger as CSV.
    static IResult ExpensesCsv(int uid, string stamp)
    {
        var rows = Db.Rows(
            @"SELECT e.spent_at, e.type, e.amount, e.currency, c.name AS category,
                     e.description, e.payment_method, e.is_recurring
              FROM expenses e LEFT JOIN expense_categories c ON c.id = e.category_id
              WHERE e.user_id = @uid ORDER BY e.spent_at DESC, e.id DESC",
            new { uid });
        var csv = Csv(["date", "type", "amount", "currency", "category", "description", "payment_method", "is_recurring"], rows);
        return Download(csv, "text/csv; charset=utf-8", $"inphub-expenses-{stamp}.csv");
    }

    // The to-do list as CSV, JSON or a Markdown checklist grouped by status.
    static IResult TodosExport(int uid, string action, string stamp)
    {
        var todos = Db.Rows(
            @"SELECT title, description, status, priority, project, tags, due_date,
                     recurring, created_at, completed_at
              FROM todos WHERE user_id = @uid
              ORDER BY (status = 'done'), sort_order ASC, (due_date IS NULL), due_date ASC, id DESC",
            new { uid });

        if (action == "todos_csv")
        {
            var csv = Csv(["title", "description", "status", "priority", "project", "tags", "due_date", "recurring", "created_at", "completed_at"], todos);
            return Download(csv, "text/csv; charset=utf-8", $"inphub-todos-{stamp}.csv");
        }
        if (action == "todos_json")
        {
            var json = JsonSerializer.Serialize(new { exported_at = DateTimeOffset.Now.ToString("yyyy-MM-ddTHH:mm:sszzz"), todos }, Pretty);
            return Download(json, "application/json; charset=utf-8", $"inphub-todos-{stamp}.json");
        }

        var labels = new (string Status, string Label)[] { ("todo", "To do"), ("in_progress", "In progress"), ("done", "Done"), ("archived", "Archived") };
        var md = new StringBuilder($"# inphub — To-Do list ({stamp})\n");
        foreach (var (status, label) in labels)
        {
            var items = todos.Where(t => (string)t["status"]! == status).ToList();
            if (items.Count == 0) continue;
            md.Append($"\n## {label}\n\n");
            foreach (var t in items)
            {
                var box = status is "done" or "archived" ? "x" : " ";
                var meta = new List<string>();
                if ((string)t["priority"]! != "medium") meta.Add((string)t["priority"]!);
                if (t["project"] is string { Length: > 0 } project) meta.Add(project);
                if (t["due_date"] != null) meta.Add("due " + t["due_date"]);
                if (t["completed_at"] is string completed) meta.Add("completed " + completed[..10]);
                md.Append($"- [{box}] {t["title"]}" + (meta.Count > 0 ? " _(" + string.Join(" · ", meta) + ")_" : "") + "\n");
            }
        }
        return Download(md.ToString(), "text/markdown; charset=utf-8", $"inphub-todos-{stamp}.md");
    }

    // A header line plus one line per row, quoted the way PHP's fputcsv does.
    static string Csv(string[] header, List<Dictionary<string, object?>> rows)
    {
        var sb = new StringBuilder();
        sb.Append(string.Join(",", header.Select(CsvField))).Append('\n');
        foreach (var row in rows)
        {
            sb.Append(string.Join(",", row.Values.Select(v => CsvField(Convert.ToString(v, System.Globalization.CultureInfo.InvariantCulture) ?? "")))).Append('\n');
        }
        return sb.ToString();
    }

    // One CSV field, in quotes only when it has to be.
    static string CsvField(string value)
    {
        var needsQuotes = value.IndexOfAny([',', '"', '\\', '\n', '\r', '\t', ' ']) >= 0;
        return needsQuotes ? "\"" + value.Replace("\"", "\"\"") + "\"" : value;
    }

    // A text body sent as a file download.
    static IResult Download(string body, string contentType, string fileName) =>
        Results.File(new UTF8Encoding(false).GetBytes(body), contentType, fileName);
}
