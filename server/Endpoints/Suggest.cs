using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using Inphub.Core;

namespace Inphub.Endpoints;

public static class Suggest
{
    const int MaxChars = 200;
    const int MaxItems = 8;

    static readonly HttpClient Http = new() { Timeout = TimeSpan.FromSeconds(3) };

    // GET /api/suggest: Google suggestions, proxied because Google sends no CORS headers.
    public static void Map(WebApplication app) =>
        app.MapMethods("/api/suggest", ["GET", "POST"], Api.HandleAsync(Run));

    // A slow or failing Google is never an error, just no items.
    static async Task<object?> Run(Req req)
    {
        if (req.Action != "suggest" && req.Action != "list") throw Api.Fail("Unknown action.", 404);

        var q = req.Input.Str("q") ?? "";
        var hl = req.Input.Str("hl") ?? "";
        if (!Regex.IsMatch(hl, "^[a-z]{2}(-[A-Z]{2})?$")) hl = "en";
        if (q == "" || q.EnumerateRunes().Count() > MaxChars) return new { q, items = Array.Empty<string>() };

        return new { q, items = await GoogleSuggestions(q, hl) };
    }

    // Up to MaxItems suggestions, empty on any failure.
    static async Task<List<string>> GoogleSuggestions(string q, string hl)
    {
        var url = "https://suggestqueries.google.com/complete/search?client=firefox&ie=utf-8&oe=utf-8"
            + "&hl=" + Uri.EscapeDataString(hl) + "&q=" + Uri.EscapeDataString(q);
        try
        {
            using var request = new HttpRequestMessage(HttpMethod.Get, url);
            request.Headers.UserAgent.ParseAdd("inphub");
            using var response = await Http.SendAsync(request);
            if ((int)response.StatusCode != 200) return [];

            var bytes = await response.Content.ReadAsByteArrayAsync();
            string text;
            try
            {
                text = new UTF8Encoding(false, true).GetString(bytes);
            }
            catch (DecoderFallbackException)
            {
                text = Encoding.GetEncoding("ISO-8859-9").GetString(bytes);
            }

            using var doc = JsonDocument.Parse(text);
            var root = doc.RootElement;
            if (root.ValueKind != JsonValueKind.Array || root.GetArrayLength() < 2 || root[1].ValueKind != JsonValueKind.Array) return [];

            var items = new List<string>();
            foreach (var s in root[1].EnumerateArray())
            {
                if (s.ValueKind == JsonValueKind.String && s.GetString()!.Trim() != "") items.Add(s.GetString()!);
                if (items.Count >= MaxItems) break;
            }
            return items;
        }
        catch (Exception)
        {
            return [];
        }
    }
}
