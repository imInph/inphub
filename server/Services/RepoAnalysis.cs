using System.Globalization;
using System.Text.Json.Nodes;
using Inphub.Core;

namespace Inphub.Services;

// AI suggestions for a repository, cached for CooldownHours so a re-click doesn't burn tokens.
public static class RepoAnalysis
{
    public const int CooldownHours = 6;

    static readonly string[] Categories = ["feature", "docs", "refactor", "testing", "ci", "security", "other"];
    static readonly string[] Priorities = ["low", "medium", "high"];

    // When the repo was last analysed (its newest suggestion), or null.
    public static string? LastAnalyzed(int uid, int repoId)
    {
        var at = Db.Row("SELECT MAX(created_at) AS at FROM repo_suggestions WHERE repo_id = @repoId AND user_id = @uid", new { repoId, uid })?["at"];
        return at is string { Length: > 0 } s ? s : null;
    }

    // True when the last analysis is inside the cooldown window.
    public static bool IsFresh(string? lastAnalyzed) =>
        lastAnalyzed != null
        && DateTime.ParseExact(lastAnalyzed, "yyyy-MM-dd HH:mm:ss", CultureInfo.InvariantCulture) > DateTime.Now.AddHours(-CooldownHours);

    // Asks the model for 3-5 suggestions and replaces the open ones; a garbled reply keeps the old ones.
    public static async Task<List<Dictionary<string, object?>>> Analyze(int uid, Dictionary<string, object?> repo)
    {
        var id = Convert.ToInt32(repo["id"]);
        var readme = repo["readme_excerpt"] as string ?? "";
        if (readme.Length > 2500) readme = readme[..2500];
        var meta = $"Repository: {repo["full_name"]}\n"
            + "Language: " + (repo["language"] ?? "unknown") + "\n"
            + "Description: " + (repo["description"] ?? "(none)") + "\n"
            + $"Stars: {repo["stars"]}, open issues: {repo["open_issues"]}\n"
            + "Has README: " + (Brief.Truthy(repo["has_readme"]) ? "yes" : "no") + ", has license: " + (Brief.Truthy(repo["has_license"]) ? "yes" : "no") + "\n"
            + "Days since last push: " + (repo["staleness_days"] ?? "unknown") + "\n\n"
            + "README excerpt:\n" + (readme != "" && readme != "0" ? readme : "(no README)");

        var system = """
            You are a senior engineer reviewing a GitHub repository. Suggest 3 to 5
            concrete, high-value improvements, specific to THIS repository — refer to what
            the metadata and README below actually show, never generic advice.

            Reply with a JSON array and nothing else: no prose before or after it, no code
            fence, no explanation. The array holds one object per suggestion:

            [
              {"title":"...","detail":"...","category":"docs","priority":"high"},
              {"title":"...","detail":"...","category":"testing","priority":"medium"}
            ]

            Every field is required on every object:
            - "title"    a short imperative summary, under 80 characters.
            - "detail"   two or three sentences on what to do and why it is worth doing.
            - "category" exactly one of: feature, docs, refactor, testing, ci, security, other.
            - "priority" exactly one of: low, medium, high.

            Use those exact spellings in lowercase. Do not add other fields, and do not
            wrap the array in an object.
            """;

        var raw = await Ai.Generate(uid, system, meta, maxTokens: 900, rawSystem: true);
        var items = ModelJson.ParseArray(raw);
        if (items.Count == 0)
        {
            throw new InvalidOperationException($"The model returned no usable suggestions for {repo["name"]} — kept the previous analysis.");
        }

        Db.Execute("DELETE FROM repo_suggestions WHERE repo_id = @id AND user_id = @uid AND status = 'open'", new { id, uid });
        var saved = 0;
        foreach (var item in items)
        {
            var o = item as JsonObject;
            var title = o == null ? "" : ModelJson.Text(o["title"]).Trim();
            if (title == "") continue;
            Db.Execute(
                @"INSERT INTO repo_suggestions (user_id, repo_id, title, detail, category, priority)
                  VALUES (@uid, @id, @title, @detail, @category, @priority)",
                new
                {
                    uid, id, title,
                    detail = o!["detail"] != null ? ModelJson.Text(o["detail"]) : null,
                    category = OneOf(o["category"], Categories, "other"),
                    priority = OneOf(o["priority"], Priorities, "medium"),
                });
            saved++;
        }
        Activity.Log(uid, "ai.repo_analyzed", "repo", id, $"Analyzed {repo["name"]}: {saved} suggestions", "ai");
        return Db.Rows("SELECT * FROM repo_suggestions WHERE repo_id = @id AND user_id = @uid ORDER BY id DESC", new { id, uid });
    }

    // The value when it is one of allowed, otherwise the fallback.
    static string OneOf(JsonNode? value, string[] allowed, string fallback) =>
        value != null && allowed.Contains(ModelJson.Text(value)) ? ModelJson.Text(value) : fallback;
}
