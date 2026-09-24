using Inphub.Core;
using MySqlConnector;

namespace Inphub.Endpoints;

public static class Categories
{
    // GET/POST /api/categories: list, create, update, delete (expenses keep, category set to NULL).
    public static void Map(WebApplication app) =>
        app.MapMethods("/api/categories", ["GET", "POST"], Api.Handle(Run));

    // Dispatches on ?action=.
    static object? Run(Req req)
    {
        var uid = req.Uid;
        var input = req.Input;

        switch (req.Action)
        {
            case "list":
                return Db.Rows("SELECT * FROM expense_categories WHERE user_id = @uid ORDER BY name ASC", new { uid });
            case "create":
            {
                var name = input.Str("name") ?? throw Api.Fail("Category name is required.", 422);
                try
                {
                    var id = Db.Insert(
                        @"INSERT INTO expense_categories (user_id, name, color, icon, monthly_budget)
                          VALUES (@uid, @name, @color, @icon, @budget)",
                        new
                        {
                            uid, name,
                            color = input.Str("color") ?? "#6b7280",
                            icon = input.Str("icon"),
                            budget = input.NumOrNull("monthly_budget"),
                        });
                    return new { id };
                }
                catch (MySqlException e) when (e.ErrorCode == MySqlErrorCode.DuplicateKeyEntry)
                {
                    throw Api.Fail("A category with that name already exists.", 409);
                }
            }
            case "update":
            {
                var cat = Api.FetchOwned("expense_categories", input.Int("id"), uid);
                var id = Convert.ToInt32(cat["id"]);
                Db.Execute(
                    "UPDATE expense_categories SET name = @name, color = @color, icon = @icon, monthly_budget = @budget WHERE id = @id AND user_id = @uid",
                    new
                    {
                        id, uid,
                        name = input.Str("name") ?? (string)cat["name"]!,
                        color = input.Str("color") ?? (string)cat["color"]!,
                        icon = input.StrIfSent("icon", cat["icon"]),
                        budget = input.NumIfSent("monthly_budget", cat["monthly_budget"]),
                    });
                return new { id };
            }
            case "delete":
            {
                var cat = Api.FetchOwned("expense_categories", input.Int("id"), uid);
                var id = Convert.ToInt32(cat["id"]);
                Db.Execute("DELETE FROM expense_categories WHERE id = @id AND user_id = @uid", new { id, uid });
                return new { deleted = id };
            }
            default:
                throw Api.Fail("Unknown action.", 404);
        }
    }
}
