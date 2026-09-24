using System.Text.Encodings.Web;
using Inphub.Auth;
using System.Text.Json;

namespace Inphub.Core;

public class ApiException(string message, int status = 400) : Exception(message)
{
    public int Status { get; } = status;
}

public class Req
{
    public required HttpContext Http { get; init; }
    public required Input Input { get; init; }
    public required int Uid { get; init; }
    public required string Method { get; init; }
    public required string Action { get; init; }
    public bool IsPost => Method == "POST";
}

public static class Api
{
    public static readonly JsonSerializerOptions Json = new()
    {
        Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping,
    };

    // Wraps a handler: reads input, checks login, and turns the result or error into the envelope.
    public static Func<HttpContext, Task<IResult>> Handle(Func<Req, object?> handler, bool requireAuth = true)
    {
        return HandleAsync(req => Task.FromResult(handler(req)), requireAuth);
    }

    // Same as Handle, for handlers that await something (HTTP calls).
    public static Func<HttpContext, Task<IResult>> HandleAsync(Func<Req, Task<object?>> handler, bool requireAuth = true)
    {
        return async ctx =>
        {
            var uid = ctx.UserId();
            if (requireAuth && uid == 0) return Error("Not authenticated.", 401);
            try
            {
                var input = await Input.Read(ctx.Request);
                var method = ctx.Request.Method.ToUpperInvariant();
                var req = new Req
                {
                    Http = ctx,
                    Input = input,
                    Uid = uid,
                    Method = method,
                    Action = input.Text("action", method == "GET" ? "list" : ""),
                };
                var result = await handler(req);
                return result as IResult ?? Results.Json(new { ok = true, data = result }, Json);
            }
            catch (ApiException e)
            {
                return Error(e.Message, e.Status);
            }
            catch (Exception e)
            {
                return Error(e.Message, 500);
            }
        };
    }

    // The failure envelope with a status code.
    public static IResult Error(string message, int status) =>
        Results.Json(new { ok = false, error = message }, Json, statusCode: status);

    // Stops the handler with an error response.
    public static ApiException Fail(string message, int status = 400) => new(message, status);

    // Throws when the request is not a POST.
    public static void RequirePost(Req req, string message = "Use POST.")
    {
        if (!req.IsPost) throw Fail(message, 405);
    }

    // Returns value when it is one of allowed, otherwise the fallback.
    public static string ValidEnum(string? value, string[] allowed, string fallback) =>
        value != null && allowed.Contains(value) ? value : fallback;

    static readonly string[] OwnedTables =
    [
        "todos", "expenses", "expense_categories", "repos", "repo_suggestions",
        "habits", "habit_logs", "goals", "notes", "focus_sessions",
    ];

    // Loads one row by id that belongs to the user, or fails with 404.
    public static Dictionary<string, object?> FetchOwned(string table, int id, int uid)
    {
        if (!OwnedTables.Contains(table)) throw Fail("Invalid table.", 500);
        if (id <= 0) throw Fail("Missing or invalid id.", 422);
        var row = Db.Row($"SELECT * FROM `{table}` WHERE id = @id AND user_id = @uid LIMIT 1", new { id, uid });
        return row ?? throw Fail("Not found.", 404);
    }
}
