using Inphub.Core;
using Inphub.Services;

namespace Inphub.Endpoints;

public static class AiApi
{
    // GET/POST /api/ai: status, test, brief, chat and sessions, models, repo analysis, quick add, weekly review.
    public static void Map(WebApplication app) =>
        app.MapMethods("/api/ai", ["GET", "POST"], Api.HandleAsync(Run));

    // Dispatches on ?action=; everything except status, test_connection and quick_add needs AI switched on.
    static async Task<object?> Run(Req req)
    {
        var uid = req.Uid;
        var input = req.Input;
        if (req.Action is not ("status" or "test_connection" or "quick_add") && Known(req.Action) && !Ai.Available(uid))
        {
            throw Api.Fail("AI is disabled. Enable it and configure a provider in Settings.", 403);
        }

        switch (req.Action)
        {
            case "status":
                return new { available = Ai.Available(uid) };
            case "test_connection":
            {
                var (ok, error, model) = await Ai.TestConnection(uid);
                if (!ok) throw Api.Fail("AI test failed: " + error, 502);
                return new { ok, error, model };
            }
            case "brief":
                return new { brief = Db.Row("SELECT * FROM daily_briefs WHERE user_id = @uid AND brief_date = CURRENT_DATE", new { uid }) };
            case "clear_brief":
                Db.Execute("DELETE FROM daily_briefs WHERE user_id = @uid", new { uid });
                return new { cleared = true };
            case "generate_brief":
                return new { brief = await Brief.Generate(uid) };
            case "chat_history":
            {
                var sid = input.Str("session_id");
                if (sid == null)
                {
                    Chat.BackfillLegacySession(uid);
                    sid = Db.Scalar<string>("SELECT session_id FROM chat_sessions WHERE user_id = @uid ORDER BY updated_at DESC LIMIT 1", new { uid });
                    if (sid == "" || sid == "0") sid = null;
                }
                if (sid == null) return new { session_id = (string?)null, messages = Array.Empty<object>() };
                var messages = Db.Rows(
                    @"SELECT id, role, content, actions, created_at FROM chat_messages
                      WHERE user_id = @uid AND session_id = @sid ORDER BY id ASC LIMIT 100",
                    new { uid, sid });
                return new { session_id = sid, messages };
            }
            case "list_sessions":
                Chat.BackfillLegacySession(uid);
                return new
                {
                    sessions = Db.Rows(
                        @"SELECT session_id, title, created_at, updated_at FROM chat_sessions
                          WHERE user_id = @uid ORDER BY updated_at DESC LIMIT 50",
                        new { uid }),
                };
            case "delete_session":
            {
                var sid = input.Str("session_id") ?? throw Api.Fail("session_id is required.", 422);
                Db.Execute("DELETE FROM chat_messages WHERE user_id = @uid AND session_id = @sid", new { uid, sid });
                Db.Execute("DELETE FROM chat_sessions WHERE user_id = @uid AND session_id = @sid", new { uid, sid });
                return new { deleted = true };
            }
            case "chat":
                return await Chat.Turn(uid, input.Str("message") ?? "", input.Str("model"), input.Str("session_id"));
            case "models":
                return await Ai.ListModels(uid);
            case "analyze_repo":
            {
                var repo = Api.FetchOwned("repos", input.Int("repo_id"), uid);
                var last = RepoAnalysis.LastAnalyzed(uid, Convert.ToInt32(repo["id"]));
                if (input.Text("force") != "1" && RepoAnalysis.IsFresh(last))
                {
                    var cached = Db.Rows("SELECT * FROM repo_suggestions WHERE repo_id = @id AND user_id = @uid ORDER BY id DESC", new { id = repo["id"], uid });
                    return new { suggestions = cached, cached = true, analyzed_at = last };
                }
                return new { suggestions = await RepoAnalysis.Analyze(uid, repo), cached = false, analyzed_at = AppInfo.Now() };
            }
            case "analyze_stale":
            {
                var repos = Db.Rows(
                    "SELECT * FROM repos WHERE user_id = @uid AND staleness_days >= @days ORDER BY staleness_days DESC LIMIT 10",
                    new { uid, days = Repos.StaleDays(uid) });
                int analyzed = 0, skipped = 0, failed = 0;
                foreach (var repo in repos)
                {
                    if (RepoAnalysis.IsFresh(RepoAnalysis.LastAnalyzed(uid, Convert.ToInt32(repo["id"]))))
                    {
                        skipped++;
                        continue;
                    }
                    try
                    {
                        await RepoAnalysis.Analyze(uid, repo);
                        analyzed++;
                    }
                    catch (Exception)
                    {
                        failed++;
                    }
                }
                return new { analyzed, skipped, failed };
            }
            case "quick_add":
                return await QuickAdd.Add(uid, input.Str("text") ?? "");
            case "weekly_review":
                return new { review = await Brief.WeeklyReview(uid) };
            default:
                throw Api.Fail("Unknown action.", 404);
        }
    }

    // True for an action this endpoint has, so an unknown one gets a 404 rather than the AI gate's 403.
    static bool Known(string action) => action is "brief" or "clear_brief" or "generate_brief" or "chat_history"
        or "list_sessions" or "delete_session" or "chat" or "models" or "analyze_repo" or "analyze_stale" or "weekly_review";
}
