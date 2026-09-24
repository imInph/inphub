using Inphub.Auth;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.Mvc.RazorPages;

namespace Inphub.Pages;

public class LoginModel(IWebHostEnvironment env) : PageModel
{
    public string? Error { get; private set; }
    public string CssVersion { get; private set; } = "";

    // Shows the form, or goes home when already signed in.
    public IActionResult OnGet()
    {
        if (HttpContext.UserId() != 0) return Redirect("/");
        CssVersion = CssFileVersion();
        return Page();
    }

    // Checks the credentials and signs in.
    public async Task<IActionResult> OnPost(string? username, string? password, string? remember)
    {
        Error = await AuthService.Login(HttpContext, (username ?? "").Trim(), password ?? "", remember != null);
        if (Error == null) return Redirect("/");
        CssVersion = CssFileVersion();
        return Page();
    }

    // app.css's modified time, for cache busting.
    string CssFileVersion()
    {
        var file = Path.Combine(env.WebRootPath, "assets/css/app.css");
        var time = System.IO.File.Exists(file) ? System.IO.File.GetLastWriteTimeUtc(file) : DateTime.UtcNow;
        return new DateTimeOffset(time).ToUnixTimeSeconds().ToString();
    }
}
