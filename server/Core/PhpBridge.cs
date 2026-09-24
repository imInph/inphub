using System.Net;
using Inphub.Auth;
using Yarp.ReverseProxy.Forwarder;

namespace Inphub.Core;

// Until v4.1 the AI and backup endpoints still live in PHP; these forward to the XAMPP copy.
public static class PhpBridge
{
    static readonly HttpMessageInvoker Client = new(new SocketsHttpHandler
    {
        UseProxy = false,
        AllowAutoRedirect = false,
        UseCookies = false,
        AutomaticDecompression = DecompressionMethods.None,
    });

    static string phpApiUrl = "";
    static string bridgeKey = "";

    // /api/ai and /api/import: forwarded to PHP as they are.
    public static void Map(WebApplication app)
    {
        phpApiUrl = app.Configuration["Inphub:PhpApiUrl"] ?? "http://localhost/inphub/api/";
        bridgeKey = app.Configuration["Inphub:BridgeKey"] ?? "";

        app.MapMethods("/api/ai", ["GET", "POST"], (HttpContext ctx, IHttpForwarder forwarder) => Forward(ctx, forwarder, "ai.php"));
        app.MapMethods("/api/import", ["GET", "POST"], (HttpContext ctx, IHttpForwarder forwarder) => Forward(ctx, forwarder, "import.php"));
    }

    // Sends this request to a PHP file with the user id and the shared bridge key.
    public static async Task<IResult> Forward(HttpContext ctx, IHttpForwarder forwarder, string phpFile)
    {
        var uid = ctx.UserId();
        if (uid == 0) return Api.Error("Not authenticated.", 401);
        if (bridgeKey == "") return Api.Error("The PHP bridge is not configured: set Inphub:BridgeKey and bridge_key in config/config.php.", 503);

        var transformer = new BridgeTransformer(phpApiUrl + phpFile, uid, bridgeKey);
        var error = await forwarder.SendAsync(ctx, phpApiUrl, Client, ForwarderRequestConfig.Empty, transformer);
        if (error != ForwarderError.None && !ctx.Response.HasStarted)
        {
            return Api.Error("The PHP backend is not reachable. Is XAMPP running?", 502);
        }
        return Results.Empty;
    }

    class BridgeTransformer(string target, int uid, string key) : HttpTransformer
    {
        // Points the request at the PHP file, drops our cookies, and adds the bridge headers.
        public override async ValueTask TransformRequestAsync(HttpContext ctx, HttpRequestMessage proxyRequest,
            string destinationPrefix, CancellationToken cancellationToken)
        {
            await base.TransformRequestAsync(ctx, proxyRequest, destinationPrefix, cancellationToken);
            proxyRequest.RequestUri = new Uri(target + ctx.Request.QueryString);
            proxyRequest.Headers.Remove("Cookie");
            proxyRequest.Headers.Host = null;
            proxyRequest.Headers.Add("X-Inphub-User", uid.ToString());
            proxyRequest.Headers.Add("X-Inphub-Key", key);
        }

        // Keeps PHP's session cookie out of the browser.
        public override async ValueTask<bool> TransformResponseAsync(HttpContext ctx, HttpResponseMessage? proxyResponse,
            CancellationToken cancellationToken)
        {
            var result = await base.TransformResponseAsync(ctx, proxyResponse, cancellationToken);
            ctx.Response.Headers.Remove("Set-Cookie");
            return result;
        }
    }
}
