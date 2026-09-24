using Inphub.Core;

namespace Inphub.Endpoints;

public static class Goals
{
    static readonly string[] Statuses = ["active", "completed", "paused"];

    // GET/POST /api/goals: list, create, update, nudge, delete.
    public static void Map(WebApplication app) =>
        app.MapMethods("/api/goals", ["GET", "POST"], Api.Handle(Run));

    // Dispatches on ?action=.
    static object? Run(Req req)
    {
        var uid = req.Uid;
        var input = req.Input;

        switch (req.Action)
        {
            case "list":
                return Db.Rows(
                    "SELECT * FROM goals WHERE user_id = @uid ORDER BY status ASC, (target_date IS NULL), target_date ASC, id DESC",
                    new { uid });
            case "create":
            {
                var title = input.Str("title") ?? throw Api.Fail("Goal title is required.", 422);
                var id = Db.Insert(
                    @"INSERT INTO goals (user_id, title, description, category, target_value, current_value, unit, target_date, status)
                      VALUES (@uid, @title, @description, @category, @target_value, @current_value, @unit, @target_date, @status)",
                    new
                    {
                        uid, title,
                        description = input.Str("description"),
                        category = input.Str("category"),
                        target_value = input.IntOrNull("target_value"),
                        current_value = input.Int("current_value"),
                        unit = input.Str("unit"),
                        target_date = input.Str("target_date"),
                        status = Api.ValidEnum(input.Text("status"), Statuses, "active"),
                    });
                Activity.Log(uid, "goal.created", "goal", id, "New goal: " + title);
                return new { id };
            }
            case "update":
            {
                var goal = Api.FetchOwned("goals", input.Int("id"), uid);
                var id = Convert.ToInt32(goal["id"]);
                var status = (string)goal["status"]!;
                Db.Execute(
                    @"UPDATE goals SET title = @title, description = @description, category = @category, target_value = @target_value,
                        current_value = @current_value, unit = @unit, target_date = @target_date, status = @status
                      WHERE id = @id AND user_id = @uid",
                    new
                    {
                        id, uid,
                        title = input.Str("title") ?? (string)goal["title"]!,
                        description = input.StrIfSent("description", goal["description"]),
                        category = input.StrIfSent("category", goal["category"]),
                        target_value = input.IntIfSent("target_value", goal["target_value"]),
                        current_value = input.Int("current_value", Convert.ToInt32(goal["current_value"])),
                        unit = input.StrIfSent("unit", goal["unit"]),
                        target_date = input.StrIfSent("target_date", goal["target_date"]),
                        status = Api.ValidEnum(input.Str("status") ?? status, Statuses, status),
                    });
                return new { id };
            }
            case "nudge":
            {
                var goal = Api.FetchOwned("goals", input.Int("id"), uid);
                var id = Convert.ToInt32(goal["id"]);
                var newValue = Math.Max(0, Convert.ToInt32(goal["current_value"]) + input.Int("delta"));
                var status = (string)goal["status"]!;
                if (goal["target_value"] != null && newValue >= Convert.ToInt32(goal["target_value"]) && status == "active")
                {
                    status = "completed";
                }
                Db.Execute("UPDATE goals SET current_value = @newValue, status = @status WHERE id = @id AND user_id = @uid",
                    new { newValue, status, id, uid });
                var unit = goal["unit"] as string;
                Activity.Log(uid, "goal.progress", "goal", id, $"{goal["title"]} → {newValue}" + (string.IsNullOrEmpty(unit) ? "" : " " + unit));
                return new { id, current_value = newValue, status };
            }
            case "delete":
            {
                var goal = Api.FetchOwned("goals", input.Int("id"), uid);
                var id = Convert.ToInt32(goal["id"]);
                Db.Execute("DELETE FROM goals WHERE id = @id AND user_id = @uid", new { id, uid });
                return new { deleted = id };
            }
            default:
                throw Api.Fail("Unknown action.", 404);
        }
    }
}
