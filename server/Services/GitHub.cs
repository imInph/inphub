using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;

namespace Inphub.Services;

public record GitHubResponse(int Status, JsonElement? Body, string? Error);

public static class GitHub
{
    static readonly HttpClient Http = new() { BaseAddress = new Uri("https://api.github.com"), Timeout = TimeSpan.FromSeconds(20) };

    // One GitHub REST call; never throws, failures come back as Status 0 with an Error.
    public static async Task<GitHubResponse> Request(string path, string? token)
    {
        try
        {
            using var request = new HttpRequestMessage(HttpMethod.Get, path);
            request.Headers.Accept.ParseAdd("application/vnd.github+json");
            request.Headers.UserAgent.ParseAdd("inphub");
            request.Headers.Add("X-GitHub-Api-Version", "2022-11-28");
            if (!string.IsNullOrEmpty(token)) request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);

            using var response = await Http.SendAsync(request);
            var status = (int)response.StatusCode;
            var raw = await response.Content.ReadAsStringAsync();
            JsonElement? body = null;
            try { body = JsonDocument.Parse(raw).RootElement.Clone(); }
            catch (JsonException) { }

            string? error = null;
            if (status >= 400)
            {
                error = body is { ValueKind: JsonValueKind.Object } b && b.TryGetProperty("message", out var m) ? m.GetString() : "GitHub error";
            }
            return new GitHubResponse(status, body, error);
        }
        catch (Exception e)
        {
            return new GitHubResponse(0, null, e.Message);
        }
    }

    // Every repo for the user (own repos incl. private with a token, public ones without), up to 10 pages.
    public static async Task<(List<JsonElement> Repos, string? Error)> ListRepos(string username, string? token)
    {
        var repos = new List<JsonElement>();
        var basePath = token != null
            ? "/user/repos?per_page=100&affiliation=owner&sort=pushed"
            : "/users/" + Uri.EscapeDataString(username) + "/repos?per_page=100&sort=pushed";

        for (var page = 1; page <= 10; page++)
        {
            var res = await Request(basePath + "&page=" + page, token);
            if (res.Status >= 400 || res.Status == 0 || res.Body is not { ValueKind: JsonValueKind.Array } batch)
            {
                if (page == 1) return ([], res.Error ?? "Could not list repos");
                break;
            }
            repos.AddRange(batch.EnumerateArray());
            if (batch.GetArrayLength() < 100) break;
        }
        return (repos, null);
    }

    // The repo's README as text, or null when there is none.
    public static async Task<string?> Readme(string fullName, string? token)
    {
        var res = await Request("/repos/" + fullName + "/readme", token);
        if (res.Status != 200 || res.Body is not { ValueKind: JsonValueKind.Object } body) return null;
        if (!body.TryGetProperty("content", out var content) || content.GetString() is not { Length: > 0 } encoded) return null;
        try
        {
            return Encoding.UTF8.GetString(Convert.FromBase64String(encoded.Replace("\n", "")));
        }
        catch (FormatException)
        {
            return null;
        }
    }

    // True when GitHub detects a license file.
    public static async Task<bool> HasLicense(string fullName, string? token) =>
        (await Request("/repos/" + fullName + "/license", token)).Status == 200;

    // 0-100: README 25, LICENSE 15, description 15, push recency 30, low issue backlog 15.
    public static int HealthScore(bool hasReadme, bool hasLicense, bool hasDescription, int? staleness, int openIssues)
    {
        var score = 0;
        if (hasReadme) score += 25;
        if (hasLicense) score += 15;
        if (hasDescription) score += 15;

        if (staleness is < 7) score += 30;
        else if (staleness is < 30) score += 22;
        else if (staleness is < 60) score += 15;
        else if (staleness is < 180) score += 8;

        if (openIssues == 0) score += 15;
        else if (openIssues <= 5) score += 10;
        else if (openIssues <= 15) score += 5;

        return Math.Clamp(score, 0, 100);
    }
}
