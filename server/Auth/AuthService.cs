using System.Security.Claims;
using System.Security.Cryptography;
using System.Text;
using Inphub.Core;
using Microsoft.AspNetCore.Authentication;
using Microsoft.AspNetCore.Authentication.Cookies;

namespace Inphub.Auth;

public static class AuthService
{
    // Not "inphub_remember": cookies ignore the port, so the PHP app on :80 would rotate this one away.
    public const string RememberCookie = "inphub4_remember";
    public const int RememberDays = 365;

    // The signed-in user's id, 0 when nobody is signed in.
    public static int UserId(this HttpContext ctx)
    {
        var claim = ctx.User.FindFirst("uid")?.Value;
        return int.TryParse(claim, out var id) ? id : 0;
    }

    // The signed-in user's role, empty when nobody is signed in.
    public static string Role(this HttpContext ctx) => ctx.User.FindFirst(ClaimTypes.Role)?.Value ?? "";

    // The current user row (never the password hash), or null.
    public static Dictionary<string, object?>? CurrentUser(int uid)
    {
        if (uid == 0) return null;
        return Db.Row("SELECT id, username, display_name, role, is_active FROM users WHERE id = @uid", new { uid });
    }

    // Checks a username and password, signs in, and returns an error message or null on success.
    public static async Task<string?> Login(HttpContext ctx, string username, string password, bool remember)
    {
        var user = Db.Row("SELECT * FROM users WHERE username = @username LIMIT 1", new { username });
        if (user == null || !VerifyPassword(password, (string)user["password_hash"]!))
        {
            return "Invalid username or password.";
        }
        if (Convert.ToInt32(user["is_active"]) != 1)
        {
            return "This account is deactivated.";
        }

        var uid = Convert.ToInt32(user["id"]);
        await SignIn(ctx, uid, (string)user["role"]!);
        Db.Execute("UPDATE users SET last_login_at = NOW() WHERE id = @uid", new { uid });
        Provisioning.Run(uid);
        if (remember) IssueRememberToken(ctx, uid);
        Activity.Log(uid, "auth.login", "user", uid, "Logged in", "system");
        return null;
    }

    // Issues the session cookie and makes the user visible to the rest of this request.
    public static async Task SignIn(HttpContext ctx, int uid, string role)
    {
        var identity = new ClaimsIdentity(
            [new Claim("uid", uid.ToString()), new Claim(ClaimTypes.Role, role)],
            CookieAuthenticationDefaults.AuthenticationScheme);
        var principal = new ClaimsPrincipal(identity);
        await ctx.SignInAsync(CookieAuthenticationDefaults.AuthenticationScheme, principal,
            new AuthenticationProperties { IsPersistent = false });
        ctx.User = principal;
    }

    // Stores a hash of a fresh random token and puts the raw token in a cookie.
    public static void IssueRememberToken(HttpContext ctx, int uid)
    {
        var raw = Convert.ToHexStringLower(RandomNumberGenerator.GetBytes(32));
        var userAgent = ctx.Request.Headers.UserAgent.ToString();
        if (userAgent.Length > 255) userAgent = userAgent[..255];

        Db.Execute(
            @"INSERT INTO remember_tokens (user_id, token_hash, expires_at, user_agent)
              VALUES (@uid, @hash, @expires, @userAgent)",
            new { uid, hash = Hash(raw), expires = DateTime.Now.AddDays(RememberDays), userAgent });

        ctx.Response.Cookies.Append(RememberCookie, raw, new CookieOptions
        {
            Expires = DateTimeOffset.Now.AddDays(RememberDays),
            Path = "/",
            HttpOnly = true,
            SameSite = SameSiteMode.Lax,
        });
    }

    // Signs in from a valid remember cookie and rotates the token.
    public static async Task TryRememberLogin(HttpContext ctx)
    {
        var raw = ctx.Request.Cookies[RememberCookie];
        if (string.IsNullOrEmpty(raw)) return;

        var row = Db.Row(
            @"SELECT rt.id, rt.user_id, u.role, u.is_active
                FROM remember_tokens rt
                JOIN users u ON u.id = rt.user_id
               WHERE rt.token_hash = @hash AND rt.expires_at > NOW()
               LIMIT 1",
            new { hash = Hash(raw) });

        if (row == null || Convert.ToInt32(row["is_active"]) != 1)
        {
            ClearRememberCookie(ctx);
            return;
        }

        Db.Execute("DELETE FROM remember_tokens WHERE id = @id", new { id = row["id"] });
        var uid = Convert.ToInt32(row["user_id"]);
        await SignIn(ctx, uid, (string)row["role"]!);
        IssueRememberToken(ctx, uid);
    }

    // Changes the password and logs out every other remembered device. Returns an error or null.
    public static async Task<string?> ChangePassword(HttpContext ctx, int uid, string current, string next)
    {
        if (uid <= 0) return "Not signed in.";
        if (next.Length < 8) return "New password must be at least 8 characters.";

        var hash = Db.Scalar<string>("SELECT password_hash FROM users WHERE id = @uid LIMIT 1", new { uid });
        if (hash == null || !VerifyPassword(current, hash)) return "Current password is incorrect.";
        if (VerifyPassword(next, hash)) return "That is already your password.";

        Db.Execute("UPDATE users SET password_hash = @hash WHERE id = @uid", new { hash = BCrypt.Net.BCrypt.HashPassword(next), uid });

        var hadCookie = !string.IsNullOrEmpty(ctx.Request.Cookies[RememberCookie]);
        Db.Execute("DELETE FROM remember_tokens WHERE user_id = @uid", new { uid });
        ClearRememberCookie(ctx);
        if (hadCookie) IssueRememberToken(ctx, uid);

        await SignIn(ctx, uid, ctx.Role());
        Activity.Log(uid, "auth.password_changed", "user", uid, "Changed account password");
        return null;
    }

    // Ends the session and deletes the remember token.
    public static async Task Logout(HttpContext ctx)
    {
        var raw = ctx.Request.Cookies[RememberCookie];
        if (!string.IsNullOrEmpty(raw))
        {
            Db.Execute("DELETE FROM remember_tokens WHERE token_hash = @hash", new { hash = Hash(raw) });
        }
        ClearRememberCookie(ctx);
        await ctx.SignOutAsync(CookieAuthenticationDefaults.AuthenticationScheme);
    }

    // Deletes the remember cookie from the browser.
    static void ClearRememberCookie(HttpContext ctx)
    {
        ctx.Response.Cookies.Delete(RememberCookie, new CookieOptions { Path = "/", HttpOnly = true, SameSite = SameSiteMode.Lax });
    }

    // Checks a password against a bcrypt hash (PHP's $2y$ hashes work too).
    static bool VerifyPassword(string password, string hash)
    {
        try
        {
            return BCrypt.Net.BCrypt.Verify(password, hash);
        }
        catch (Exception)
        {
            return false;
        }
    }

    // SHA-256 of a raw remember token, as lowercase hex.
    static string Hash(string raw) => Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(raw)));
}
