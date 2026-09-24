using System.Text.Json;
using Inphub.Core;

namespace Inphub.Endpoints;

public static class Todos
{
    static readonly string[] Statuses = ["todo", "in_progress", "done", "archived"];
    static readonly string[] Priorities = ["low", "medium", "high", "urgent"];

    // GET/POST /api/todos: list, create, update, complete, reorder, delete.
    public static void Map(WebApplication app) =>
        app.MapMethods("/api/todos", ["GET", "POST"], Api.Handle(Run));

    // Dispatches on ?action=.
    static object? Run(Req req)
    {
        var uid = req.Uid;
        var input = req.Input;

        switch (req.Action)
        {
            case "list":
            {
                var sql = "SELECT * FROM todos WHERE user_id = @uid";
                var status = input.Str("status");
                var project = input.Str("project");
                if (status != null) sql += " AND status = @status";
                if (project != null) sql += " AND project = @project";
                sql += " ORDER BY sort_order ASC, (due_date IS NULL), due_date ASC, id DESC";
                return Db.Rows(sql, new { uid, status, project });
            }
            case "create":
            {
                var title = input.Str("title") ?? throw Api.Fail("Title is required.", 422);
                var createdBy = input.Text("created_by") == "ai" ? "ai" : "user";
                var id = Db.Insert(
                    @"INSERT INTO todos
                        (user_id, title, description, status, priority, project, tags, due_date, recurring, sort_order, created_by)
                      VALUES (@uid, @title, @description, @status, @priority, @project, @tags, @due_date, @recurring, @sort_order, @createdBy)",
                    new
                    {
                        uid, title,
                        description = input.Str("description"),
                        status = Api.ValidEnum(input.Text("status"), Statuses, "todo"),
                        priority = Api.ValidEnum(input.Text("priority"), Priorities, "medium"),
                        project = input.Str("project"),
                        tags = input.Str("tags"),
                        due_date = input.Str("due_date"),
                        recurring = input.Str("recurring"),
                        sort_order = input.Int("sort_order"),
                        createdBy,
                    });
                Activity.Log(uid, "todo.created", "todo", id, "Added todo: " + title, createdBy);
                return new { id };
            }
            case "update":
            {
                var todo = Api.FetchOwned("todos", input.Int("id"), uid);
                var id = Convert.ToInt32(todo["id"]);
                var title = input.Str("title") ?? (string)todo["title"]!;
                var status = Api.ValidEnum(input.Str("status") ?? (string)todo["status"]!, Statuses, (string)todo["status"]!);
                Db.Execute(
                    @"UPDATE todos SET title = @title, description = @description, status = @status, priority = @priority,
                        project = @project, tags = @tags, due_date = @due_date, recurring = @recurring,
                        completed_at = CASE WHEN @status = 'done' THEN COALESCE(completed_at, NOW()) ELSE NULL END
                      WHERE id = @id AND user_id = @uid",
                    new
                    {
                        title, status, id, uid,
                        description = input.StrIfSent("description", todo["description"]),
                        priority = Api.ValidEnum(input.Str("priority") ?? (string)todo["priority"]!, Priorities, (string)todo["priority"]!),
                        project = input.StrIfSent("project", todo["project"]),
                        tags = input.StrIfSent("tags", todo["tags"]),
                        due_date = input.StrIfSent("due_date", todo["due_date"]),
                        recurring = input.StrIfSent("recurring", todo["recurring"]),
                    });
                Activity.Log(uid, "todo.updated", "todo", id, "Updated todo: " + title);
                return new { id };
            }
            case "complete":
            {
                var todo = Api.FetchOwned("todos", input.Int("id"), uid);
                var id = Convert.ToInt32(todo["id"]);
                Db.Execute("UPDATE todos SET status = 'done', completed_at = NOW() WHERE id = @id AND user_id = @uid", new { id, uid });
                Activity.Log(uid, "todo.completed", "todo", id, "Completed: " + todo["title"]);

                int? newId = null;
                if (!string.IsNullOrEmpty(todo["recurring"] as string)) newId = RegenerateRecurring(uid, todo);
                return new { id, regenerated = newId };
            }
            case "reorder":
            {
                var order = input.Raw("order");
                if (order == null || order.Value.ValueKind != JsonValueKind.Array) throw Api.Fail("order must be an array of ids.", 422);
                var position = 0;
                foreach (var item in order.Value.EnumerateArray())
                {
                    Db.Execute("UPDATE todos SET sort_order = @position WHERE id = @id AND user_id = @uid",
                        new { position, id = Input.ToInt(item), uid });
                    position++;
                }
                return new { reordered = position };
            }
            case "delete":
            {
                var todo = Api.FetchOwned("todos", input.Int("id"), uid);
                var id = Convert.ToInt32(todo["id"]);
                Db.Execute("DELETE FROM todos WHERE id = @id AND user_id = @uid", new { id, uid });
                Activity.Log(uid, "todo.deleted", "todo", id, "Deleted todo: " + todo["title"]);
                return new { deleted = id };
            }
            default:
                throw Api.Fail("Unknown action.", 404);
        }
    }

    // Inserts a fresh open copy of a recurring todo with the next due date.
    static int RegenerateRecurring(int uid, Dictionary<string, object?> todo)
    {
        var dueText = todo["due_date"] as string;
        var baseDate = string.IsNullOrEmpty(dueText) ? DateTime.Today : DateTime.Parse(dueText);
        DateTime? next = (todo["recurring"] as string) switch
        {
            "daily" => baseDate.AddDays(1),
            "weekly" => baseDate.AddDays(7),
            "monthly" => baseDate.AddMonths(1),
            _ => null,
        };
        if (next == null) return 0;

        return Db.Insert(
            @"INSERT INTO todos
                (user_id, title, description, status, priority, project, tags, due_date, recurring, sort_order, created_by)
              VALUES (@uid, @title, @description, 'todo', @priority, @project, @tags, @due, @recurring, @sort_order, @created_by)",
            new
            {
                uid,
                title = todo["title"], description = todo["description"], priority = todo["priority"],
                project = todo["project"], tags = todo["tags"], due = next.Value.ToString("yyyy-MM-dd"),
                recurring = todo["recurring"], sort_order = todo["sort_order"], created_by = todo["created_by"],
            });
    }
}
