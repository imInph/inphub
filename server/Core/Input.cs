using System.Globalization;
using System.Text.Json;

namespace Inphub.Core;

public class Input
{
    readonly Dictionary<string, JsonElement> values = new();

    // Reads the query string and the JSON body into one bag; the body wins on clashes.
    public static async Task<Input> Read(HttpRequest request)
    {
        var input = new Input();
        foreach (var (key, value) in request.Query)
        {
            input.values[key] = JsonSerializer.SerializeToElement(value.ToString());
        }
        if (request.ContentLength is > 0 || request.Headers.TransferEncoding.Count > 0)
        {
            try
            {
                using var doc = await JsonDocument.ParseAsync(request.Body);
                if (doc.RootElement.ValueKind == JsonValueKind.Object)
                {
                    foreach (var prop in doc.RootElement.EnumerateObject())
                    {
                        input.values[prop.Name] = prop.Value.Clone();
                    }
                }
            }
            catch (JsonException)
            {
            }
        }
        return input;
    }

    // True when the key was sent at all, even as null.
    public bool Has(string key) => values.ContainsKey(key);

    // The raw JSON value, or null when missing or JSON null.
    public JsonElement? Raw(string key)
    {
        if (!values.TryGetValue(key, out var v) || v.ValueKind == JsonValueKind.Null) return null;
        return v;
    }

    // The value as text, like PHP's (string) cast.
    public string Text(string key, string fallback = "")
    {
        var v = Raw(key);
        if (v == null) return Has(key) ? "" : fallback;
        return v.Value.ValueKind switch
        {
            JsonValueKind.String => v.Value.GetString() ?? "",
            JsonValueKind.True => "1",
            JsonValueKind.False => "",
            JsonValueKind.Number => v.Value.GetRawText(),
            _ => v.Value.GetRawText(),
        };
    }

    // Trimmed text, or null when missing or blank.
    public string? Str(string key)
    {
        var v = Raw(key);
        if (v == null) return null;
        var s = Text(key).Trim();
        return s == "" ? null : s;
    }

    // Str(key) when the key was sent, otherwise the current value (for partial updates).
    public string? StrIfSent(string key, object? current) => Has(key) ? Str(key) : (string?)current;

    // IntOrNull(key) when the key was sent, otherwise the current value.
    public object? IntIfSent(string key, object? current) => Has(key) ? IntOrNull(key) : current;

    // NumOrNull(key) when the key was sent, otherwise the current value.
    public object? NumIfSent(string key, object? current) => Has(key) ? NumOrNull(key) : current;

    // The value as an int, like PHP's (int) cast.
    public int Int(string key, int fallback = 0)
    {
        var v = Raw(key);
        if (v == null) return Has(key) ? 0 : fallback;
        return ToInt(v.Value);
    }

    // An int, or null when missing or empty.
    public int? IntOrNull(string key)
    {
        var v = Raw(key);
        if (v == null) return null;
        if (v.Value.ValueKind == JsonValueKind.String && v.Value.GetString() == "") return null;
        return ToInt(v.Value);
    }

    // A number, or null when missing or empty.
    public double? NumOrNull(string key)
    {
        var v = Raw(key);
        if (v == null) return null;
        if (v.Value.ValueKind == JsonValueKind.String && v.Value.GetString() == "") return null;
        return ToDouble(v.Value);
    }

    // The value as a bool, like PHP's (bool) cast.
    public bool Bool(string key, bool fallback = false)
    {
        var v = Raw(key);
        if (v == null) return Has(key) ? false : fallback;
        return v.Value.ValueKind switch
        {
            JsonValueKind.True => true,
            JsonValueKind.False => false,
            JsonValueKind.Number => v.Value.GetDouble() != 0,
            JsonValueKind.String => v.Value.GetString() is not ("" or "0"),
            JsonValueKind.Array => v.Value.GetArrayLength() > 0,
            _ => true,
        };
    }

    // Converts a JSON value to an int the forgiving way PHP does ("12abc" => 12).
    public static int ToInt(JsonElement v)
    {
        var d = ToDouble(v);
        if (double.IsNaN(d) || double.IsInfinity(d)) return 0;
        return (int)Math.Clamp(Math.Truncate(d), int.MinValue, int.MaxValue);
    }

    // Converts a JSON value to a double the forgiving way PHP does.
    public static double ToDouble(JsonElement v)
    {
        switch (v.ValueKind)
        {
            case JsonValueKind.Number: return v.GetDouble();
            case JsonValueKind.True: return 1;
            case JsonValueKind.String: return LeadingNumber(v.GetString() ?? "");
            default: return 0;
        }
    }

    // Parses the number at the start of a string, 0 when there is none.
    public static double LeadingNumber(string s)
    {
        s = s.Trim();
        var end = 0;
        while (end < s.Length && (char.IsDigit(s[end]) || s[end] is '.' or '-' or '+' or 'e' or 'E')) end++;
        while (end > 0)
        {
            if (double.TryParse(s[..end], NumberStyles.Float, CultureInfo.InvariantCulture, out var d)) return d;
            end--;
        }
        return 0;
    }
}
