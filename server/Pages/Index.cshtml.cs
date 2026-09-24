using System.Text.Json;
using Inphub.Auth;
using Inphub.Core;
using Microsoft.AspNetCore.Html;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.Mvc.RazorPages;

namespace Inphub.Pages;

public class IndexModel(IWebHostEnvironment env) : PageModel
{
    public static readonly (string Id, string Label, string Key)[] Nav =
    [
        ("dashboard", "Dashboard", "d"), ("todos", "To-Do", "t"), ("expenses", "Money", "e"),
        ("repos", "Repos", "r"), ("habits", "Habits", "h"), ("goals", "Goals", "g"),
        ("notes", "Notes", "n"), ("focus", "Focus", "f"), ("insights", "Insights", "i"),
        ("activity", "History", "a"), ("settings", "Settings", "s"),
    ];

    static readonly Dictionary<string, string> Icons = new()
    {
        ["dashboard"] = """<rect x="3.5" y="3.5" width="7" height="7" rx="2"/><rect x="13.5" y="3.5" width="7" height="7" rx="2"/><rect x="3.5" y="13.5" width="7" height="7" rx="2"/><rect x="13.5" y="13.5" width="7" height="7" rx="2"/>""",
        ["todos"] = """<path d="M4 6.5l1.6 1.6L8.8 5M4 12.5l1.6 1.6 3.2-3.1M4 18.5l1.6 1.6 3.2-3.1"/><path d="M12.5 7H20M12.5 13H20M12.5 19H20"/>""",
        ["expenses"] = """<rect x="3" y="6.5" width="18" height="13.5" rx="3"/><path d="M3 10.5h18M16 15.5h1.5M6 6.5l8.5-3 1.5 3"/>""",
        ["repos"] = """<circle cx="6" cy="5.5" r="2"/><circle cx="6" cy="18.5" r="2"/><circle cx="18" cy="8" r="2"/><path d="M6 7.5v9M18 10c0 4-6.5 3.5-11 7"/>""",
        ["habits"] = """<path d="M12 21c-3.9 0-7-2.7-7-6.5 0-3.6 2.7-5.5 3.9-8.4.6 2 1.8 3 3.1 3.4.1-3.4 1.1-5.4 3.1-6.5.2 3.1 3.9 5.8 3.9 11.3 0 3.8-3.1 6.7-7 6.7z"/>""",
        ["goals"] = """<circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="12" r="4.8"/><circle cx="12" cy="12" r="1.2"/>""",
        ["notes"] = """<path d="M6.5 3.5h8l4 4v11a2 2 0 0 1-2 2h-10a2 2 0 0 1-2-2v-13a2 2 0 0 1 2-2z"/><path d="M14 3.5V8h4.5M8.5 13h7M8.5 16.5h4.5"/>""",
        ["focus"] = """<circle cx="12" cy="13" r="7.5"/><path d="M12 9.5V13l2.5 2M9.5 2.8h5"/>""",
        ["insights"] = """<path d="M3.5 20.5h17M6.5 17v-5M10.5 17V6.5M14.5 17V9.5M18.5 17v-3"/>""",
        ["activity"] = """<path d="M3.8 12a8.2 8.2 0 1 0 2.4-5.8L3.8 8.5"/><path d="M3.8 4v4.5h4.5M12 7.5V12l3 2"/>""",
        ["settings"] = """<path d="M4 6.5h9M17.5 6.5H20M4 12h3M11.5 12H20M4 17.5h11M19.5 17.5h.5"/><circle cx="15.5" cy="6.5" r="2"/><circle cx="9" cy="12" r="2"/><circle cx="17.5" cy="17.5" r="2"/>""",
        ["chat"] = """<path d="M20.5 11.5a8 8 0 0 1-11.7 7.1L4 19.8l1.2-4.4a8 8 0 1 1 15.3-3.9z"/>""",
        ["search"] = """<circle cx="11" cy="11" r="6.5"/><path d="M20 20l-4.2-4.2"/>""",
        ["logout"] = """<path d="M14.5 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3"/><path d="M10 16.5L5.5 12 10 7.5M5.5 12H15"/>""",
        ["theme"] = """<circle cx="12" cy="12" r="8"/><path d="M12 4a8 8 0 0 1 0 16z" fill="currentColor"/>""",
        ["menu"] = """<path d="M4 7h16M4 12h16M4 17h16"/>""",
    };

    public string Theme { get; private set; } = "dark";
    public Look Look { get; private set; } = null!;
    public string WallpaperStyle { get; private set; } = "";
    public string BootJson { get; private set; } = "{}";
    public string CssVersion { get; private set; } = "";
    public string JsVersion { get; private set; } = "";
    public bool HasAppJs { get; private set; }

    // Loads the user, theme and appearance, and works out the asset versions.
    public IActionResult OnGet()
    {
        var uid = HttpContext.UserId();
        var user = AuthService.CurrentUser(uid);
        if (user == null) return Redirect("/login");

        var theme = Settings.Get(uid, "theme", "dark");
        Theme = string.IsNullOrEmpty(theme) ? "dark" : theme;
        Look = Appearance.For(uid);
        WallpaperStyle = Look.wallpaper_url != "" ? "--wp-image: " + Appearance.CssUrl(Look.wallpaper_url) : "";

        var boot = new
        {
            user = new { id = uid, username = user["username"], display_name = user["display_name"], role = user["role"] },
            theme = Theme,
            appearance = Look,
        };
        BootJson = JsonSerializer.Serialize(boot);

        CssVersion = FileVersion("assets/css/app.css");
        JsVersion = BuildId();
        HasAppJs = System.IO.File.Exists(WebFile("assets/js/app.js"));
        return Page();
    }

    // An inline SVG icon from the Icons table.
    public static IHtmlContent Icon(string name) => new HtmlString(
        """<svg class="ico" viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">"""
        + Icons.GetValueOrDefault(name, "") + "</svg>");

    // A file's modified time as a cache-busting version.
    public string FileVersion(string path)
    {
        var file = WebFile(path);
        return System.IO.File.Exists(file)
            ? new DateTimeOffset(System.IO.File.GetLastWriteTimeUtc(file)).ToUnixTimeSeconds().ToString()
            : DateTimeOffset.Now.ToUnixTimeSeconds().ToString();
    }

    // The build id stamped into every module import; must match or app.js loads twice.
    string BuildId()
    {
        var stamp = WebFile("assets/js/build-id.txt");
        var id = System.IO.File.Exists(stamp) ? System.IO.File.ReadAllText(stamp).Trim() : "";
        if (id != "") return id;

        var dir = WebFile("assets/js");
        var newest = Directory.Exists(dir)
            ? Directory.GetFiles(dir, "*.js").Select(System.IO.File.GetLastWriteTimeUtc).DefaultIfEmpty(DateTime.UtcNow).Max()
            : DateTime.UtcNow;
        return new DateTimeOffset(newest).ToUnixTimeSeconds().ToString();
    }

    // Absolute path of a file under public/.
    string WebFile(string path) => Path.Combine(env.WebRootPath, path);
}
