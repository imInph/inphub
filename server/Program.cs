using Inphub.Auth;
using Inphub.Core;
using Inphub.Endpoints;
using Microsoft.AspNetCore.Authentication.Cookies;

System.Text.Encoding.RegisterProvider(System.Text.CodePagesEncodingProvider.Instance);

var root = FindRepoRoot();
var builder = WebApplication.CreateBuilder(new WebApplicationOptions
{
    Args = args,
    ContentRootPath = Path.Combine(root, "server"),
    WebRootPath = Path.Combine(root, "public"),
});
builder.Configuration.AddJsonFile("appsettings.Local.json", optional: true, reloadOnChange: false);
builder.Configuration.AddEnvironmentVariables();

builder.Services.AddRazorPages();
builder.Services.AddHttpForwarder();
builder.Services.AddHttpClient();
builder.Services.AddAuthentication(CookieAuthenticationDefaults.AuthenticationScheme)
    .AddCookie(options =>
    {
        options.Cookie.Name = "inphub4_session";
        options.Cookie.HttpOnly = true;
        options.Cookie.SameSite = SameSiteMode.Lax;
        options.LoginPath = "/login";
    });

var app = builder.Build();
Db.Configure(app.Configuration);

app.UseStaticFiles();
app.UseAuthentication();
app.Use(async (ctx, next) =>
{
    if (ctx.UserId() == 0) await AuthService.TryRememberLogin(ctx);
    await next();
});

app.MapRazorPages();
app.MapGet("/logout", async (HttpContext ctx) =>
{
    await AuthService.Logout(ctx);
    return Results.Redirect("/login");
});
app.MapGet("/index.php", () => Results.Redirect("/"));
app.MapGet("/login.php", () => Results.Redirect("/login"));
app.MapGet("/logout.php", () => Results.Redirect("/logout"));

AuthApi.Map(app);
Users.Map(app);
Todos.Map(app);
Notes.Map(app);
Goals.Map(app);
Categories.Map(app);
Expenses.Map(app);
Focus.Map(app);
Habits.Map(app);
ActivityApi.Map(app);
Repos.Map(app);
SyncRepos.Map(app);
SettingsApi.Map(app);
Stats.Map(app);
Insights.Map(app);
Search.Map(app);
Suggest.Map(app);
Export.Map(app);
PhpBridge.Map(app);

app.Run();

// Walks up from the build output to the folder that holds public/assets.
static string FindRepoRoot()
{
    var dir = new DirectoryInfo(AppContext.BaseDirectory);
    while (dir != null && !Directory.Exists(Path.Combine(dir.FullName, "public", "assets")))
    {
        dir = dir.Parent;
    }
    return dir?.FullName ?? throw new InvalidOperationException("Could not find the inphub folder (public/assets).");
}
