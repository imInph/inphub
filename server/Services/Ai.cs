using System.Globalization;
using System.Text;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Inphub.Core;

namespace Inphub.Services;

public record AiConfig(
    bool Enabled, string Provider,
    string ClaudeApiKey, string ClaudeModel,
    string OllamaBaseUrl, string OllamaModel,
    string LmStudioBaseUrl, string LmStudioModel, string LmStudioApiKey);

// The provider-agnostic AI layer: Claude, Ollama or LM Studio, chosen in the user's settings.
public static class Ai
{
    static readonly HttpClient Http = new(new SocketsHttpHandler { ConnectTimeout = TimeSpan.FromSeconds(15) })
    {
        Timeout = Timeout.InfiniteTimeSpan,
    };

    // The user's AI settings with their defaults.
    public static AiConfig Config(int uid)
    {
        var s = Settings.All(uid);
        string Get(string key, string fallback) => s.TryGetValue(key, out var v) ? v ?? "" : fallback;
        return new AiConfig(
            Enabled: Get("ai_enabled", "0") == "1",
            Provider: Get("ai_provider", "claude"),
            ClaudeApiKey: Get("claude_api_key", ""),
            ClaudeModel: Get("claude_model", "claude-sonnet-5"),
            OllamaBaseUrl: Get("ollama_base_url", "http://127.0.0.1:11434"),
            OllamaModel: Get("ollama_model", "llama3.1"),
            LmStudioBaseUrl: Get("lmstudio_base_url", "http://127.0.0.1:1234"),
            LmStudioModel: Get("lmstudio_model", ""),
            LmStudioApiKey: Get("lmstudio_api_key", ""));
    }

    // The model the configured provider will use; the one place a provider maps to a model setting.
    public static string ActiveModel(AiConfig c) => c.Provider switch
    {
        "ollama" => c.OllamaModel,
        "lmstudio" => c.LmStudioModel,
        _ => c.ClaudeModel,
    };

    // The one gate for every AI feature: switched on and the chosen provider configured enough to call.
    public static bool Available(int uid)
    {
        var c = Config(uid);
        if (!c.Enabled) return false;
        return c.Provider switch
        {
            "claude" => c.ClaudeApiKey != "" && c.ClaudeModel != "",
            "ollama" => c.OllamaBaseUrl != "" && c.OllamaModel != "",
            "lmstudio" => c.LmStudioBaseUrl != "" && c.LmStudioModel != "",
            _ => false,
        };
    }

    // Asks the configured provider; model overrides the setting for this call only and is never saved.
    public static async Task<string> Generate(int uid, string system, string prompt,
        int maxTokens = 1024, int timeout = 60, string? model = null, bool rawSystem = false)
    {
        var c = Config(uid);
        if (!rawSystem) system = LocalePreamble(uid) + "\n\n" + system;

        var overrideModel = model?.Trim() ?? "";
        if (overrideModel != "")
        {
            c = c with { ClaudeModel = overrideModel, OllamaModel = overrideModel, LmStudioModel = overrideModel };
        }

        return c.Provider switch
        {
            "ollama" => await CallOllama(c, system, prompt, maxTokens, timeout),
            "lmstudio" => await CallLmStudio(c, system, prompt, timeout),
            _ => await CallClaude(c, system, prompt, maxTokens, timeout),
        };
    }

    // Facts every prompt gets: today's date and the currency, so "2000.00" is never read as dollars.
    public static string LocalePreamble(int uid)
    {
        var currency = Money.DefaultCurrency(uid);
        var name = Money.CurrencyName(currency);
        var now = DateTime.Now;
        return "Context for this conversation:\n"
            + $"- Today is {now:yyyy-MM-dd} ({now.ToString("dddd", CultureInfo.InvariantCulture)}).\n"
            + $"- Every money amount in this app — and in anything you are shown below — is in {currency} ({name}). "
            + $"Amounts are written like \"2000.00 {currency}\".\n"
            + $"- Never assume dollars, never convert an amount into another currency, and never prefix an amount "
            + $"with a currency symbol other than {currency}'s.";
    }

    // The models the chat's picker offers: live from Ollama / LM Studio, a short list for Claude.
    public static async Task<object> ListModels(int uid)
    {
        var c = Config(uid);
        if (c.Provider == "ollama")
        {
            var body = await GetJson(c.OllamaBaseUrl.TrimEnd('/') + "/api/tags", []);
            var models = ModelJson.Items(ModelJson.At(body, "models"))
                .Select(m => ModelJson.StringOrNull(ModelJson.At(m, "name")))
                .OfType<string>()
                .ToList();
            return new { provider = "ollama", @default = c.OllamaModel, models };
        }
        if (c.Provider == "lmstudio")
        {
            var body = await GetJson(LmStudioBase(c) + "/v1/models", LmStudioHeaders(c));
            var models = ModelJson.Items(ModelJson.At(body, "data"))
                .Select(m => ModelJson.StringOrNull(ModelJson.At(m, "id")))
                .OfType<string>()
                .Where(id => !id.Contains("embed", StringComparison.OrdinalIgnoreCase))
                .ToList();
            return new { provider = "lmstudio", @default = c.LmStudioModel, models };
        }
        return new
        {
            provider = "claude",
            @default = c.ClaudeModel,
            models = new[] { "claude-fable-5", "claude-opus-4-8", "claude-sonnet-5", "claude-haiku-4-5-20251001" },
        };
    }

    // Pings the provider; returns ok plus the model, or the error.
    public static async Task<(bool Ok, string? Error, string? Model)> TestConnection(int uid)
    {
        var c = Config(uid);
        try
        {
            await Generate(uid, "You are a connectivity test.", "Reply with the single word: ok", maxTokens: 16, timeout: 30, rawSystem: true);
            return (true, null, ActiveModel(c));
        }
        catch (Exception e)
        {
            return (false, e.Message, null);
        }
    }

    // One Claude Messages API call.
    static async Task<string> CallClaude(AiConfig c, string system, string prompt, int maxTokens, int timeout)
    {
        if (c.ClaudeApiKey == "") throw new InvalidOperationException("Claude API key is not set.");
        var payload = new JsonObject
        {
            ["model"] = c.ClaudeModel,
            ["max_tokens"] = maxTokens,
            ["system"] = system,
            ["messages"] = new JsonArray(new JsonObject { ["role"] = "user", ["content"] = prompt }),
        };
        var (status, body, error) = await PostJson("https://api.anthropic.com/v1/messages",
            [("x-api-key", c.ClaudeApiKey), ("anthropic-version", "2023-06-01")], payload, timeout);

        if (error != null) throw new InvalidOperationException("Claude request failed: " + error);
        if (status >= 400)
        {
            var message = ModelJson.At(body, "error", "message") is JsonValue m ? ModelJson.Text(m) : "HTTP " + status;
            throw new InvalidOperationException("Claude error: " + message);
        }
        return ModelJson.StringOrNull(ModelJson.At(body, "content", "0", "text"))
            ?? throw new InvalidOperationException("Claude returned an unexpected response.");
    }

    // One Ollama /api/chat call.
    static async Task<string> CallOllama(AiConfig c, string system, string prompt, int maxTokens, int timeout)
    {
        var payload = new JsonObject
        {
            ["model"] = c.OllamaModel,
            ["stream"] = false,
            ["messages"] = new JsonArray(
                new JsonObject { ["role"] = "system", ["content"] = system },
                new JsonObject { ["role"] = "user", ["content"] = prompt }),
            ["options"] = new JsonObject { ["num_predict"] = maxTokens },
        };
        var (status, body, error) = await PostJson(c.OllamaBaseUrl.TrimEnd('/') + "/api/chat", [], payload, timeout);

        if (error != null) throw new InvalidOperationException("Ollama request failed: " + error);
        if (status >= 400)
        {
            var message = ModelJson.At(body, "error") is { } e ? ModelJson.Text(e) : "HTTP " + status;
            throw new InvalidOperationException("Ollama error: " + message);
        }
        return ModelJson.StringOrNull(ModelJson.At(body, "message", "content"))
            ?? throw new InvalidOperationException("Ollama returned an unexpected response.");
    }

    // One LM Studio call (OpenAI-compatible); no max_tokens so a local reasoning model is never cut off mid-thought.
    static async Task<string> CallLmStudio(AiConfig c, string system, string prompt, int timeout)
    {
        var payload = new JsonObject
        {
            ["model"] = c.LmStudioModel,
            ["stream"] = false,
            ["messages"] = new JsonArray(
                new JsonObject { ["role"] = "system", ["content"] = system },
                new JsonObject { ["role"] = "user", ["content"] = prompt }),
        };
        var (status, body, error) = await PostJson(LmStudioBase(c) + "/v1/chat/completions", LmStudioHeaders(c), payload, timeout);

        if (error != null) throw new InvalidOperationException("LM Studio request failed: " + error);
        if (status >= 400)
        {
            var e = ModelJson.At(body, "error");
            var reason = e is JsonObject && ModelJson.At(e, "message") != null ? ModelJson.Text(ModelJson.At(e, "message"))
                : ModelJson.StringOrNull(e) ?? "HTTP " + status;
            throw new InvalidOperationException("LM Studio error: " + reason);
        }
        if (ModelJson.At(body, "choices", "0", "message") is not JsonObject message)
        {
            throw new InvalidOperationException("LM Studio returned an unexpected response.");
        }
        var content = ModelJson.StringOrNull(ModelJson.At(message, "content")) ?? "";
        return ThinkBlock.Replace(content, "", 1).TrimStart();
    }

    static readonly Regex ThinkBlock = new(@"^\s*<think>.*?</think>", RegexOptions.Singleline);

    // LM Studio's base URL without a trailing slash or /v1, since its server tab shows ".../v1".
    static string LmStudioBase(AiConfig c) => Regex.Replace(c.LmStudioBaseUrl.TrimEnd('/'), "/v1$", "");

    // The bearer header, only when an LM Studio key is set.
    static (string, string)[] LmStudioHeaders(AiConfig c) =>
        c.LmStudioApiKey != "" ? [("Authorization", "Bearer " + c.LmStudioApiKey)] : [];

    // POSTs JSON; returns the status, the parsed body (or null) and a transport error (or null).
    static async Task<(int Status, JsonNode? Body, string? Error)> PostJson(string url, (string Name, string Value)[] headers,
        JsonObject payload, int timeout)
    {
        using var request = new HttpRequestMessage(HttpMethod.Post, url)
        {
            Content = new StringContent(ModelJson.ToText(payload), Encoding.UTF8, "application/json"),
        };
        foreach (var (name, value) in headers) request.Headers.TryAddWithoutValidation(name, value);
        return await Send(request, timeout);
    }

    // GETs JSON, returning the parsed body or null on any failure.
    static async Task<JsonNode?> GetJson(string url, (string Name, string Value)[] headers)
    {
        using var request = new HttpRequestMessage(HttpMethod.Get, url);
        foreach (var (name, value) in headers) request.Headers.TryAddWithoutValidation(name, value);
        var (_, body, _) = await Send(request, 15);
        return body;
    }

    // Sends a request with a timeout in seconds; never throws, a failure comes back as the error text.
    static async Task<(int Status, JsonNode? Body, string? Error)> Send(HttpRequestMessage request, int timeout)
    {
        using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(timeout));
        try
        {
            using var response = await Http.SendAsync(request, cts.Token);
            var raw = await response.Content.ReadAsStringAsync(cts.Token);
            return ((int)response.StatusCode, ModelJson.Parse(raw), null);
        }
        catch (OperationCanceledException)
        {
            return (0, null, $"Operation timed out after {timeout} seconds");
        }
        catch (HttpRequestException e)
        {
            return (0, null, e.Message);
        }
    }
}
