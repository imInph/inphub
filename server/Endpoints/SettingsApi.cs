using System.Globalization;
using System.Text.Json;
using Inphub.Core;

namespace Inphub.Endpoints;

public static class SettingsApi
{
    static readonly string[] AllowedKeys =
    [
        "theme", "base_currency", "starting_balance", "owner_name", "github_username", "github_token",
        "stale_repo_days", "ai_enabled", "ai_provider", "claude_api_key", "claude_model",
        "ollama_base_url", "ollama_model", "lmstudio_base_url", "lmstudio_model", "lmstudio_api_key",
        "dashboard_shortcuts", "dashboard_widgets",
        "ui_accent", "ui_wallpaper", "ui_wallpaper_url", "ui_transparency", "ui_logo_tint",
    ];

    static readonly Dictionary<string, string[]> EnumKeys = new()
    {
        ["ui_accent"] = Appearance.Accents,
        ["ui_wallpaper"] = Appearance.Wallpapers,
        ["ui_transparency"] = Appearance.Transparency,
        ["ui_logo_tint"] = Appearance.LogoTints,
    };

    static readonly string[] SecretKeys = ["github_token", "claude_api_key", "lmstudio_api_key"];
    static readonly string[] NumericKeys = ["starting_balance"];
    static readonly string[] AiProviders = ["claude", "ollama", "lmstudio"];

    // GET/POST /api/settings: get (secrets masked) and save.
    public static void Map(WebApplication app) =>
        app.MapMethods("/api/settings", ["GET", "POST"], Api.Handle(Run));

    // Dispatches on ?action=.
    static object? Run(Req req)
    {
        return req.Action switch
        {
            "get" => Get(req.Uid),
            "save" => Save(req.Uid, req.Input),
            _ => throw Api.Fail("Unknown action.", 404),
        };
    }

    // Every allowed setting; secrets come back as a mask plus a *_set flag.
    static Dictionary<string, object> Get(int uid)
    {
        var all = Settings.All(uid);
        var result = new Dictionary<string, object>();
        foreach (var key in AllowedKeys)
        {
            var value = all.GetValueOrDefault(key) ?? "";
            if (SecretKeys.Contains(key))
            {
                result[key] = Settings.MaskSecret(value);
                result[key + "_set"] = value != "";
            }
            else
            {
                result[key] = value;
            }
        }
        return result;
    }

    // Validates the whole request first, then writes the allowed keys.
    static object Save(int uid, Input input)
    {
        var raw = input.Raw("settings");
        if (raw == null) return new { saved = Array.Empty<string>() };
        if (raw.Value.ValueKind != JsonValueKind.Object) throw Api.Fail("settings must be an object.", 422);

        var settings = new Dictionary<string, string?>();
        JsonElement? widgets = null;
        foreach (var prop in raw.Value.EnumerateObject())
        {
            if (prop.Name == "dashboard_widgets") widgets = prop.Value;
            settings[prop.Name] = AsText(prop.Value);
        }

        if (settings.GetValueOrDefault("ai_provider") is { } provider && !AiProviders.Contains(provider))
        {
            throw Api.Fail("Unknown AI provider.", 422);
        }
        foreach (var (key, allowed) in EnumKeys)
        {
            if (settings.GetValueOrDefault(key) is { } value && !allowed.Contains(value))
            {
                throw Api.Fail($"Invalid value for {key}.", 422);
            }
        }
        if (settings.GetValueOrDefault("ui_wallpaper_url") is { } wallpaperUrl)
        {
            var url = wallpaperUrl.Trim();
            if (url != "" && !Appearance.IsHttpUrl(url)) throw Api.Fail("The wallpaper must be an http(s) image URL.", 422);
            settings["ui_wallpaper_url"] = url;
        }
        if (settings.GetValueOrDefault("ui_wallpaper") is "plain" or "custom")
        {
            settings["ui_logo_tint"] = "accent";
        }
        if (settings.ContainsKey("dashboard_widgets"))
        {
            var layout = Appearance.NormaliseLayout(widgets) ?? throw Api.Fail("dashboard_widgets must be a list of widgets.", 422);
            settings["dashboard_widgets"] = JsonSerializer.Serialize(layout, Api.Json);
        }

        var saved = new List<string>();
        foreach (var (key, original) in settings)
        {
            if (!AllowedKeys.Contains(key)) continue;
            if (SecretKeys.Contains(key) && original == Settings.SecretUnchanged) continue;

            var value = original;
            if (NumericKeys.Contains(key)) value = Input.LeadingNumber(value ?? "").ToString(CultureInfo.InvariantCulture);
            Settings.Set(uid, key, value ?? "");
            saved.Add(key);

            if (key == "ai_enabled" && value != "1")
            {
                Db.Execute("DELETE FROM daily_briefs WHERE user_id = @uid", new { uid });
            }
        }
        return new { saved };
    }

    // A JSON value as the text PHP would have stored (true => "1", false => "", null stays null).
    static string? AsText(JsonElement value) => value.ValueKind switch
    {
        JsonValueKind.String => value.GetString(),
        JsonValueKind.Null => null,
        JsonValueKind.True => "1",
        JsonValueKind.False => "",
        _ => value.GetRawText(),
    };
}
