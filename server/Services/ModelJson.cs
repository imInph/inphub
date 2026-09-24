using System.Globalization;
using System.Text.Encodings.Web;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

namespace Inphub.Services;

// Reads the loose JSON language models write, with the same forgiving rules the PHP version used.
public static class ModelJson
{
    public static readonly JsonSerializerOptions Options = new() { Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping };

    // Any fence tag, not just json: small models pick their own (gemma writes ```tool_code).
    public static readonly Regex Fence = new(@"```[A-Za-z0-9_+-]*[ \t]*\r?\n?(.*?)```", RegexOptions.Singleline);

    // Parses text as JSON, or null when it isn't valid JSON (or is the literal null).
    public static JsonNode? Parse(string text)
    {
        try
        {
            return JsonNode.Parse(text);
        }
        catch (JsonException)
        {
            return null;
        }
    }

    // True when text is valid JSON that isn't the literal null.
    public static bool IsJson(string text) => Parse(text) != null;

    // A node as compact JSON text with letters left unescaped.
    public static string ToText(JsonNode? node) => node?.ToJsonString(Options) ?? "null";

    // The value under key, or null when missing or JSON null (PHP's isset).
    public static JsonNode? Get(JsonObject obj, string key) => obj.TryGetPropertyValue(key, out var v) ? v : null;

    // Walks object keys and list indexes ("choices", "0", "message"); null as soon as a step is missing.
    public static JsonNode? At(JsonNode? node, params string[] path)
    {
        foreach (var step in path)
        {
            node = node switch
            {
                JsonObject obj => obj.TryGetPropertyValue(step, out var v) ? v : null,
                JsonArray list when int.TryParse(step, out var i) && i >= 0 && i < list.Count => list[i],
                _ => null,
            };
            if (node == null) return null;
        }
        return node;
    }

    // The node's string value, or null when it isn't a JSON string.
    public static string? StringOrNull(JsonNode? node) =>
        node is JsonValue v && v.GetValueKind() == JsonValueKind.String ? v.GetValue<string>() : null;

    // True when the key is present, even as null (PHP's array_key_exists).
    public static bool Has(JsonObject obj, string key) => obj.ContainsKey(key);

    // A value as text, like PHP's (string) cast.
    public static string Text(JsonNode? node)
    {
        if (node is not JsonValue value) return node == null ? "" : "Array";
        return value.GetValueKind() switch
        {
            JsonValueKind.String => value.GetValue<string>(),
            JsonValueKind.True => "1",
            JsonValueKind.False => "",
            JsonValueKind.Number => value.ToJsonString(),
            _ => "",
        };
    }

    // True for a number or a numeric string, like PHP's is_numeric.
    public static bool IsNumeric(JsonNode? node)
    {
        if (node is not JsonValue value) return false;
        if (value.GetValueKind() == JsonValueKind.Number) return true;
        if (value.GetValueKind() != JsonValueKind.String) return false;
        var s = value.GetValue<string>().TrimStart(' ', '\t', '\n', '\r', '\v', '\f').TrimEnd(' ', '\t', '\n', '\r', '\v', '\f');
        return Regex.IsMatch(s, @"^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$");
    }

    // A value as a double, like PHP's (float) cast.
    public static double Number(JsonNode? node)
    {
        if (node is not JsonValue value) return node == null ? 0 : 1;
        return value.GetValueKind() switch
        {
            JsonValueKind.Number => value.GetValue<double>(),
            JsonValueKind.True => 1,
            JsonValueKind.String => Core.Input.LeadingNumber(value.GetValue<string>()),
            _ => 0,
        };
    }

    // A value as an int, like PHP's (int) cast.
    public static int Int(JsonNode? node)
    {
        var d = Number(node);
        if (double.IsNaN(d) || double.IsInfinity(d)) return 0;
        return (int)Math.Clamp(Math.Truncate(d), int.MinValue, int.MaxValue);
    }

    // False for null, false, 0, "", "0" and empty lists/objects, like PHP's empty() in reverse.
    public static bool Truthy(JsonNode? node) => node switch
    {
        null => false,
        JsonObject o => o.Count > 0,
        JsonArray a => a.Count > 0,
        JsonValue v => v.GetValueKind() switch
        {
            JsonValueKind.True => true,
            JsonValueKind.Number => v.GetValue<double>() != 0,
            JsonValueKind.String => v.GetValue<string>() is not ("" or "0"),
            _ => false,
        },
        _ => false,
    };

    // True for a string, number or bool, like PHP's is_scalar.
    public static bool IsScalar(JsonNode? node) =>
        node is JsonValue v && v.GetValueKind() is JsonValueKind.String or JsonValueKind.Number or JsonValueKind.True or JsonValueKind.False;

    // A list as an object keyed "0", "1", …, the way PHP sees any JSON array; objects pass through.
    public static JsonObject AsObject(JsonNode? node)
    {
        if (node is JsonObject obj) return obj;
        var result = new JsonObject();
        if (node is JsonArray list)
        {
            for (var i = 0; i < list.Count; i++) result[i.ToString(CultureInfo.InvariantCulture)] = list[i]?.DeepClone();
        }
        return result;
    }

    // The items of a list, or the values of an object.
    public static IEnumerable<JsonNode?> Items(JsonNode? node) => node switch
    {
        JsonArray list => list,
        JsonObject obj => obj.Select(p => p.Value),
        _ => [],
    };

    // True for an empty list or object (PHP decodes both to []).
    public static bool IsEmptyContainer(JsonNode? node) =>
        (node is JsonArray a && a.Count == 0) || (node is JsonObject o && o.Count == 0);

    // The first complete JSON object or array in the text, found by string-aware brace matching.
    public static string? ExtractBalanced(string text)
    {
        for (var i = 0; i < text.Length; i++)
        {
            if (text[i] != '{' && text[i] != '[') continue;
            var depth = 0;
            var inString = false;
            var escaped = false;
            for (var j = i; j < text.Length; j++)
            {
                var c = text[j];
                if (inString)
                {
                    if (escaped) escaped = false;
                    else if (c == '\\') escaped = true;
                    else if (c == '"') inString = false;
                    continue;
                }
                if (c == '"') inString = true;
                else if (c is '{' or '[') depth++;
                else if (c is '}' or ']')
                {
                    if (--depth == 0)
                    {
                        var candidate = text.Substring(i, j - i + 1);
                        if (IsJson(candidate)) return candidate;
                        break;
                    }
                }
            }
        }
        return null;
    }

    // The first JSON object in model text: a fenced block, then brace matching, then first { to last }.
    public static string ExtractObject(string text)
    {
        var m = Fence.Match(text);
        if (m.Success)
        {
            var inner = m.Groups[1].Value.Trim();
            if (IsJson(inner)) return inner;
        }
        var balanced = ExtractBalanced(text);
        if (balanced != null) return balanced;
        var start = text.IndexOf('{');
        var end = text.LastIndexOf('}');
        return start >= 0 && end > start ? text.Substring(start, end - start + 1) : text;
    }

    // A JSON array from model text; an object wrapping one ({"suggestions":[…]}) gives its first list.
    public static List<JsonNode?> ParseArray(string text)
    {
        string? candidate = null;
        var m = Fence.Match(text);
        if (m.Success)
        {
            var inner = m.Groups[1].Value.Trim();
            if (IsJson(inner)) candidate = inner;
        }
        candidate ??= ExtractBalanced(text);
        if (candidate == null)
        {
            var start = text.IndexOf('[');
            var end = text.LastIndexOf(']');
            candidate = start >= 0 && end > start ? text.Substring(start, end - start + 1) : text;
        }

        var decoded = Parse(candidate);
        if (decoded is JsonArray list) return list.ToList();
        if (decoded is JsonObject obj)
        {
            foreach (var (_, value) in obj)
            {
                if (value is JsonArray inner) return inner.ToList();
            }
        }
        return [];
    }
}
