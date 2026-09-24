using System.Globalization;
using System.Text.Json;
using Inphub.Core;
using Inphub.Services;

namespace Inphub.Endpoints;

public static class SyncRepos
{
    // POST /api/sync_repos: pulls repos from GitHub and upserts them with health and staleness.
    public static void Map(WebApplication app) =>
        app.MapMethods("/api/sync_repos", ["GET", "POST"], Api.HandleAsync(Run));

    // Lists, enriches and upserts every repo.
    static async Task<object?> Run(Req req)
    {
        var uid = req.Uid;
        var username = (Settings.Get(uid, "github_username", "") ?? "").Trim();
        var token = (Settings.Get(uid, "github_token", "") ?? "").Trim();
        string? tokenOrNull = token == "" ? null : token;

        if (username == "" && tokenOrNull == null) throw Api.Fail("Set a GitHub username (and optionally a token) in Settings first.", 422);

        var (repos, error) = await GitHub.ListRepos(username, tokenOrNull);
        if (error != null)
        {
            if (error.Contains("rate limit", StringComparison.OrdinalIgnoreCase))
            {
                throw Api.Fail("GitHub rate limit reached — wait a bit and sync again"
                    + (tokenOrNull == null ? ", or add a token in Settings for a higher limit" : "") + ".", 502);
            }
            throw Api.Fail("GitHub sync failed: " + error, 502);
        }

        var synced = 0;
        foreach (var repo in repos)
        {
            var fullName = Text(repo, "full_name");
            if (string.IsNullOrEmpty(fullName)) continue;

            string? pushedAt = null;
            int? staleness = null;
            if (Text(repo, "pushed_at") is { Length: > 0 } pushed)
            {
                var local = DateTimeOffset.Parse(pushed, CultureInfo.InvariantCulture).ToLocalTime().DateTime;
                pushedAt = local.ToString("yyyy-MM-dd HH:mm:ss");
                staleness = (int)Math.Floor((DateTime.Now - local).TotalDays);
            }

            var readme = await GitHub.Readme(fullName, tokenOrNull);
            var hasReadme = readme != null;
            var excerpt = readme?.Trim();
            if (excerpt != null && excerpt.EnumerateRunes().Count() > 4000) excerpt = string.Concat(excerpt.EnumerateRunes().Take(4000));
            var hasLicense = (repo.TryGetProperty("license", out var license) && license.ValueKind == JsonValueKind.Object)
                || await GitHub.HasLicense(fullName, tokenOrNull);
            var openIssues = Int(repo, "open_issues_count");

            Db.Execute(
                @"INSERT INTO repos
                    (user_id, github_id, name, full_name, description, url, language, stars, forks, open_issues,
                     default_branch, is_archived, is_private, has_readme, has_license, readme_excerpt,
                     health_score, staleness_days, last_pushed_at, last_synced_at)
                  VALUES
                    (@uid, @github_id, @name, @full_name, @description, @url, @language, @stars, @forks, @open_issues,
                     @default_branch, @is_archived, @is_private, @has_readme, @has_license, @readme_excerpt,
                     @health_score, @staleness_days, @last_pushed_at, NOW())
                  ON DUPLICATE KEY UPDATE
                    github_id = VALUES(github_id), name = VALUES(name), description = VALUES(description), url = VALUES(url),
                    language = VALUES(language), stars = VALUES(stars), forks = VALUES(forks), open_issues = VALUES(open_issues),
                    default_branch = VALUES(default_branch), is_archived = VALUES(is_archived), is_private = VALUES(is_private),
                    has_readme = VALUES(has_readme), has_license = VALUES(has_license), readme_excerpt = VALUES(readme_excerpt),
                    health_score = VALUES(health_score), staleness_days = VALUES(staleness_days),
                    last_pushed_at = VALUES(last_pushed_at), last_synced_at = NOW()",
                new
                {
                    uid,
                    github_id = repo.TryGetProperty("id", out var gid) && gid.ValueKind == JsonValueKind.Number ? gid.GetInt64() : (long?)null,
                    name = Text(repo, "name") ?? fullName,
                    full_name = fullName,
                    description = Text(repo, "description"),
                    url = Text(repo, "html_url"),
                    language = Text(repo, "language"),
                    stars = Int(repo, "stargazers_count"),
                    forks = Int(repo, "forks_count"),
                    open_issues = openIssues,
                    default_branch = Text(repo, "default_branch") ?? "main",
                    is_archived = Bool(repo, "archived") ? 1 : 0,
                    is_private = Bool(repo, "private") ? 1 : 0,
                    has_readme = hasReadme ? 1 : 0,
                    has_license = hasLicense ? 1 : 0,
                    readme_excerpt = excerpt,
                    health_score = GitHub.HealthScore(hasReadme, hasLicense, !string.IsNullOrEmpty(Text(repo, "description")), staleness, openIssues),
                    staleness_days = staleness,
                    last_pushed_at = pushedAt,
                });
            synced++;
        }

        Activity.Log(uid, "repos.synced", "repo", null, $"Synced {synced} repositories from GitHub", "system", new { count = synced });
        return new { synced };
    }

    // A string property, or null when missing or not a string.
    static string? Text(JsonElement obj, string name) =>
        obj.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() : null;

    // A number property as an int, 0 when missing.
    static int Int(JsonElement obj, string name) =>
        obj.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.Number ? v.GetInt32() : 0;

    // A bool property, false when missing.
    static bool Bool(JsonElement obj, string name) =>
        obj.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.True;
}
