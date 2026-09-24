using Inphub.Core;

namespace Inphub.Endpoints;

public static class ActivityApi
{
    static readonly string[] Actors = ["user", "ai", "system"];

    // GET /api/activity: the history feed, filterable by type and actor.
    public static void Map(WebApplication app) =>
        app.MapMethods("/api/activity", ["GET", "POST"], Api.Handle(Run));

    // Dispatches on ?action=.
    static object? Run(Req req)
    {
        if (req.Action != "list") throw Api.Fail("Unknown action.", 404);

        var input = req.Input;
        var sql = "SELECT * FROM activity_log WHERE user_id = @uid";
        var type = input.Str("type");
        var actor = input.Str("actor");
        if (type != null) sql += " AND type = @type";
        if (actor != null) sql += " AND actor = @actor";
        var limit = Math.Clamp(input.Int("limit", 100), 1, 500);
        sql += $" ORDER BY created_at DESC, id DESC LIMIT {limit}";
        return Db.Rows(sql, new { uid = req.Uid, type, actor = Api.ValidEnum(actor, Actors, "user") });
    }
}
