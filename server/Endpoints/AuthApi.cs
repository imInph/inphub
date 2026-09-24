using Inphub.Auth;
using Inphub.Core;

namespace Inphub.Endpoints;

public static class AuthApi
{
    // GET/POST /api/auth: login, logout, me, change_password.
    public static void Map(WebApplication app) =>
        app.MapMethods("/api/auth", ["GET", "POST"], Api.HandleAsync(Run, requireAuth: false));

    // Dispatches on ?action=.
    static async Task<object?> Run(Req req)
    {
        switch (req.Action)
        {
            case "login":
            {
                Api.RequirePost(req, "Use POST to log in.");
                var username = req.Input.Text("username").Trim();
                var password = req.Input.Text("password");
                if (username == "" || password == "") throw Api.Fail("Username and password are required.", 422);
                var error = await AuthService.Login(req.Http, username, password, req.Input.Bool("remember"));
                if (error != null) throw Api.Fail(error, 401);
                return new { user = AuthService.CurrentUser(req.Http.UserId()) };
            }
            case "logout":
                await AuthService.Logout(req.Http);
                return new { loggedOut = true };
            case "me":
                return new { user = AuthService.CurrentUser(req.Uid) };
            case "change_password":
            {
                if (req.Uid == 0) throw Api.Fail("Not authenticated.", 401);
                Api.RequirePost(req, "Use POST to change a password.");
                var error = await AuthService.ChangePassword(req.Http, req.Uid, req.Input.Text("current"), req.Input.Text("next"));
                if (error != null) throw Api.Fail(error, 422);
                return new { changed = true };
            }
            default:
                throw Api.Fail("Unknown action.", 404);
        }
    }
}
