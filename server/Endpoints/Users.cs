using Inphub.Auth;
using Inphub.Core;

namespace Inphub.Endpoints;

public static class Users
{
    // GET/POST /api/users: admin-only account list and activation.
    public static void Map(WebApplication app) =>
        app.MapMethods("/api/users", ["GET", "POST"], Api.Handle(Run));

    // Dispatches on ?action=.
    static object? Run(Req req)
    {
        if ((string?)AuthService.CurrentUser(req.Uid)?["role"] != "admin") throw Api.Fail("Forbidden.", 403);

        switch (req.Action)
        {
            case "list":
                return Db.Rows(
                    @"SELECT id, username, display_name, role, is_active, created_at, last_login_at
                      FROM users ORDER BY id ASC");
            case "set_active":
            {
                var id = req.Input.Int("id");
                var active = req.Input.Bool("active", true) ? 1 : 0;
                if (id <= 0) throw Api.Fail("Missing user id.", 422);
                if (id == req.Uid && active == 0) throw Api.Fail("You cannot deactivate your own account.", 422);
                Db.Execute("UPDATE users SET is_active = @active WHERE id = @id", new { active, id });
                Activity.Log(req.Uid, "admin.user_active", "user", id, $"{(active == 1 ? "Activated" : "Deactivated")} account #{id}");
                return new { id, is_active = active == 1 };
            }
            default:
                throw Api.Fail("Unknown action.", 404);
        }
    }
}
