using Inphub.Core;

namespace Inphub.Endpoints;

public static class Repos
{
    // GET/POST /api/repos: list, detail, pin, delete, suggestion_status. Syncing is in SyncRepos.
    public static void Map(WebApplication app) =>
        app.MapMethods("/api/repos", ["GET", "POST"], Api.Handle(Run));

    // Dispatches on ?action=.
    static object? Run(Req req)
    {
        var uid = req.Uid;
        var input = req.Input;
        var staleDays = StaleDays(uid);

        switch (req.Action)
        {
            case "list":
            {
                var repos = Db.Rows(
                    @"SELECT * FROM repos WHERE user_id = @uid
                      ORDER BY pinned DESC, (staleness_days IS NULL), staleness_days DESC, name ASC",
                    new { uid });
                foreach (var repo in repos) repo["is_stale"] = IsStale(repo, staleDays);
                return new { repos, stale_repo_days = staleDays };
            }
            case "detail":
            {
                var repo = Api.FetchOwned("repos", input.Int("id"), uid);
                var suggestions = Db.Rows(
                    @"SELECT * FROM repo_suggestions WHERE repo_id = @id AND user_id = @uid
                      ORDER BY FIELD(status, 'open', 'done', 'dismissed'), FIELD(priority, 'high', 'medium', 'low'), id DESC",
                    new { id = repo["id"], uid });
                repo["is_stale"] = IsStale(repo, staleDays);
                return new { repo, suggestions };
            }
            case "pin":
            {
                var repo = Api.FetchOwned("repos", input.Int("id"), uid);
                var id = Convert.ToInt32(repo["id"]);
                var pinned = input.Has("pinned") ? input.Bool("pinned") : Convert.ToInt32(repo["pinned"]) == 0;
                Db.Execute("UPDATE repos SET pinned = @pinned WHERE id = @id AND user_id = @uid", new { pinned = pinned ? 1 : 0, id, uid });
                return new { id, pinned };
            }
            case "delete":
            {
                var repo = Api.FetchOwned("repos", input.Int("id"), uid);
                var id = Convert.ToInt32(repo["id"]);
                Db.Execute("DELETE FROM repos WHERE id = @id AND user_id = @uid", new { id, uid });
                return new { deleted = id };
            }
            case "suggestion_status":
            {
                var suggestion = Api.FetchOwned("repo_suggestions", input.Int("id"), uid);
                var id = Convert.ToInt32(suggestion["id"]);
                var status = Api.ValidEnum(input.Text("status"), ["open", "done", "dismissed"], "open");
                Db.Execute("UPDATE repo_suggestions SET status = @status WHERE id = @id AND user_id = @uid", new { status, id, uid });
                return new { id, status };
            }
            default:
                throw Api.Fail("Unknown action.", 404);
        }
    }

    // The user's stale_repo_days setting, 60 when unset or zero.
    public static int StaleDays(int uid)
    {
        var days = (int)Input.LeadingNumber(Settings.Get(uid, "stale_repo_days", "60") ?? "60");
        return days == 0 ? 60 : days;
    }

    // True when the repo has not been pushed to for at least staleDays.
    static bool IsStale(Dictionary<string, object?> repo, int staleDays) =>
        repo["staleness_days"] != null && Convert.ToInt32(repo["staleness_days"]) >= staleDays;
}
