using System.Globalization;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Inphub.Core;

namespace Inphub.Services;

// Free text from the capture box, filed as a task, an expense or a note (by the model, or by prefixes without AI).
public static class QuickAdd
{
    // Files the text and says where it went.
    public static async Task<object> Add(int uid, string text)
    {
        text = text.Trim();
        if (text == "") throw Api.Fail("Nothing to add.", 422);

        var parsed = (Ai.Available(uid) ? await ByModel(uid, text) : ByPrefix(text)) ?? new JsonObject { ["kind"] = "note", ["content"] = text };
        var kind = parsed["kind"] != null ? ModelJson.Text(parsed["kind"]) : "note";

        if (kind == "todo")
        {
            var title = parsed["title"] != null ? ModelJson.Text(parsed["title"]) : text;
            var id = Db.Insert(
                "INSERT INTO todos (user_id, title, priority, due_date, created_by) VALUES (@uid, @title, @priority, @due, 'ai')",
                new
                {
                    uid, title,
                    priority = OneOf(parsed["priority"], ["low", "medium", "high", "urgent"], "medium"),
                    due = parsed["due_date"] != null ? ModelJson.Text(parsed["due_date"]) : null,
                });
            Activity.Log(uid, "todo.created", "todo", id, "Added todo: " + title, "ai");
            return new { kind = "todo", id, summary = "Added a task" };
        }

        if (kind == "expense")
        {
            var amount = parsed["amount"] != null ? ModelJson.Number(parsed["amount"]) : 0.0;
            if (amount <= 0) return new { kind = "note", id = SaveNote(uid, text), summary = "Saved as a note" };

            var currency = Money.DefaultCurrency(uid);
            var id = Db.Insert(
                @"INSERT INTO expenses (user_id, type, amount, currency, description, spent_at, created_by)
                  VALUES (@uid, @type, @amount, @currency, @description, @spentAt, 'ai')",
                new
                {
                    uid, amount, currency,
                    type = OneOf(parsed["type"], ["expense", "income"], "expense"),
                    description = parsed["description"] != null ? ModelJson.Text(parsed["description"]) : text,
                    spentAt = parsed["spent_at"] != null ? ModelJson.Text(parsed["spent_at"]) : AppInfo.Today(),
                });
            Activity.Log(uid, "expense.created", "expense", id, "Spent " + Money.Text(amount, currency), "ai");
            return new { kind = "expense", id, summary = "Logged an expense" };
        }

        var content = parsed["content"] != null ? ModelJson.Text(parsed["content"]) : text;
        var noteTitle = parsed["title"] != null ? ModelJson.Text(parsed["title"]) : null;
        return new { kind = "note", id = SaveNote(uid, content, noteTitle), summary = "Saved a note" };
    }

    // Saves a note from the capture box.
    static int SaveNote(int uid, string content, string? title = null)
    {
        var id = Db.Insert("INSERT INTO notes (user_id, title, content) VALUES (@uid, @title, @content)", new { uid, title, content });
        Activity.Log(uid, "note.created", "note", id, "Quick note", "ai");
        return id;
    }

    // Asks the model to classify the text; a failed call falls back to the prefix rules.
    static async Task<JsonObject?> ByModel(int uid, string text)
    {
        var today = AppInfo.Today();
        var tomorrow = DateTime.Today.AddDays(1).ToString("yyyy-MM-dd");
        var currency = Money.DefaultCurrency(uid);
        var system = $$"""
            You sort ONE line of the user's text into exactly one of three kinds, and reply
            with a single JSON object and nothing else — no prose, no code fence, no
            explanation before or after.

            Pick the kind that fits best:
            - "todo"    — something the user has to DO later.
            - "expense" — money spent or received. Only when there is an amount.
            - "note"    — anything worth remembering that is neither of the above.
                          Use this when you are unsure.

            Reply with exactly one of these shapes:
            {"kind":"todo","title":"...","priority":"low|medium|high|urgent","due_date":"YYYY-MM-DD"}
            {"kind":"expense","amount":0,"type":"expense|income","description":"..."}
            {"kind":"note","title":"...","content":"..."}

            Only "kind" and the first field are required; drop any optional field you are
            not confident about rather than inventing a value. "amount" is a plain number
            with no currency symbol and no thousands separator — amounts are in {{currency}}.

            Examples:
            "buy milk tomorrow"            -> {"kind":"todo","title":"Buy milk","due_date":"{{tomorrow}}"}
            "call the bank, urgent"        -> {"kind":"todo","title":"Call the bank","priority":"urgent"}
            "spent 250 on coffee"          -> {"kind":"expense","amount":250,"description":"Coffee"}
            "got paid 5000 for the site"   -> {"kind":"expense","amount":5000,"type":"income","description":"Site payment"}
            "gan 14 is better on light springs" -> {"kind":"note","content":"GAN 14 is better on light springs"}

            Today is {{today}}.
            """;
        try
        {
            var raw = await Ai.Generate(uid, system, text, maxTokens: 300, rawSystem: true);
            var decoded = ModelJson.Parse(ModelJson.ExtractObject(raw));
            return decoded is JsonObject or JsonArray ? ModelJson.AsObject(decoded) : null;
        }
        catch (Exception)
        {
            return ByPrefix(text);
        }
    }

    // Without AI: "todo: …", "note: …", "spent 12 on lunch", "income 100 from …".
    static JsonObject? ByPrefix(string text)
    {
        var m = Regex.Match(text, @"^todo:\s*(.+)$", RegexOptions.IgnoreCase | RegexOptions.Singleline);
        if (m.Success) return new JsonObject { ["kind"] = "todo", ["title"] = m.Groups[1].Value.Trim() };

        m = Regex.Match(text, @"^note:\s*(.+)$", RegexOptions.IgnoreCase | RegexOptions.Singleline);
        if (m.Success) return new JsonObject { ["kind"] = "note", ["content"] = m.Groups[1].Value.Trim() };

        m = Regex.Match(text, @"^(spent|paid)\s+([0-9]+(?:\.[0-9]+)?)\s*(?:on\s+)?(.*)$", RegexOptions.IgnoreCase | RegexOptions.Singleline);
        if (m.Success) return Expense("expense", m);

        m = Regex.Match(text, @"^(income|earned|got)\s+([0-9]+(?:\.[0-9]+)?)\s*(?:from\s+)?(.*)$", RegexOptions.IgnoreCase | RegexOptions.Singleline);
        if (m.Success) return Expense("income", m);

        return null;
    }

    // An expense or income parsed from a prefix match (amount in group 2, description in group 3).
    static JsonObject Expense(string type, Match m)
    {
        var description = m.Groups[3].Value.Trim();
        return new JsonObject
        {
            ["kind"] = "expense",
            ["type"] = type,
            ["amount"] = double.Parse(m.Groups[2].Value, CultureInfo.InvariantCulture),
            ["description"] = description == "" || description == "0" ? null : description,
        };
    }

    // The value when it is one of allowed, otherwise the fallback.
    static string OneOf(JsonNode? value, string[] allowed, string fallback) =>
        value != null && allowed.Contains(ModelJson.Text(value)) ? ModelJson.Text(value) : fallback;
}
