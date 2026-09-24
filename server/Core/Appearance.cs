using System.Text.Json;

namespace Inphub.Core;

public record Widget(string id, string size);

public record Look(string accent, string wallpaper, string wallpaper_url, string transparency, string logo_tint);

public static class Appearance
{
    // Must list exactly the ids in WIDGETS in src/widgets.ts, in default order.
    public static readonly (string Id, string Size)[] DashboardWidgets =
    [
        ("clock", "normal"), ("capture", "normal"), ("todos", "normal"), ("upcoming", "normal"),
        ("habits", "normal"), ("money", "normal"), ("wallet", "normal"), ("goals", "normal"),
        ("focus", "normal"), ("brief", "wide"), ("activity", "normal"), ("repos", "normal"),
    ];

    public static readonly string[] WidgetSizes = ["normal", "wide"];
    public static readonly string[] Accents = ["blue", "indigo", "purple", "pink", "red", "orange", "green", "teal", "graphite"];
    public static readonly string[] Wallpapers = ["aurora", "sunset", "ocean", "forest", "graphite", "plain", "custom"];
    public static readonly string[] Transparency = ["full", "reduced"];
    public static readonly string[] LogoTints = ["accent", "wallpaper"];

    // Cleans a client-sent layout; drops unknown and duplicate ids. Null when it is not a list.
    public static List<Widget>? NormaliseLayout(JsonElement? raw)
    {
        if (raw == null) return null;
        var value = raw.Value;
        if (value.ValueKind == JsonValueKind.String)
        {
            try { value = JsonDocument.Parse(value.GetString() ?? "").RootElement; }
            catch (JsonException) { return null; }
        }
        if (value.ValueKind != JsonValueKind.Array) return null;

        var result = new List<Widget>();
        foreach (var item in value.EnumerateArray())
        {
            var id = item.ValueKind switch
            {
                JsonValueKind.Object when item.TryGetProperty("id", out var p) => p.ToString(),
                JsonValueKind.String => item.GetString() ?? "",
                _ => "",
            };
            var known = DashboardWidgets.FirstOrDefault(w => w.Id == id);
            if (known.Id == null || result.Any(w => w.id == id)) continue;

            var size = item.ValueKind == JsonValueKind.Object && item.TryGetProperty("size", out var s) ? s.ToString() : "";
            result.Add(new Widget(id, WidgetSizes.Contains(size) ? size : known.Size));
        }
        return result;
    }

    // The user's widget layout, or every widget in default order when unset.
    public static List<Widget> DashboardLayout(int uid)
    {
        var stored = Settings.Get(uid, "dashboard_widgets");
        if (!string.IsNullOrEmpty(stored))
        {
            var layout = NormaliseLayout(JsonSerializer.SerializeToElement(stored));
            if (layout != null) return layout;
        }
        return DashboardWidgets.Select(w => new Widget(w.Id, w.Size)).ToList();
    }

    // True for an absolute http(s) URL, the only thing a wallpaper may point at.
    public static bool IsHttpUrl(string url) =>
        Uri.TryCreate(url, UriKind.Absolute, out var uri) && (uri.Scheme == "http" || uri.Scheme == "https");

    // Appearance settings with whitelisted fallbacks, for the page and boot payload.
    public static Look For(int uid)
    {
        var all = Settings.All(uid);
        string Pick(string key, string[] allowed, string fallback)
        {
            var v = all.GetValueOrDefault(key) ?? "";
            return allowed.Contains(v) ? v : fallback;
        }
        var url = all.GetValueOrDefault("ui_wallpaper_url") ?? "";
        var wallpaper = Pick("ui_wallpaper", Wallpapers, "aurora");
        return new Look(
            accent: Pick("ui_accent", Accents, "blue"),
            wallpaper: wallpaper,
            wallpaper_url: IsHttpUrl(url) ? url : "",
            transparency: Pick("ui_transparency", Transparency, "full"),
            logo_tint: wallpaper is "plain" or "custom" ? "accent" : Pick("ui_logo_tint", LogoTints, "accent"));
    }

    // A URL made safe to sit inside CSS url("…").
    public static string CssUrl(string url)
    {
        var safe = url.Replace("\\", "%5C").Replace("\"", "%22").Replace("'", "%27")
            .Replace("(", "%28").Replace(")", "%29").Replace(" ", "%20")
            .Replace("\n", "").Replace("\r", "").Replace("\t", "");
        return $"url(\"{safe}\")";
    }
}
