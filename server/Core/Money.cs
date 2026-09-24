using System.Globalization;
using System.Text.RegularExpressions;

namespace Inphub.Core;

public record MoneyWindow(string Period, string? From, string? To, string Label);

public static class Money
{
    public static readonly string[] Periods = ["month", "last_month", "3m", "6m", "year", "all"];

    static readonly Dictionary<string, string> CurrencyNames = new()
    {
        ["TRY"] = "Turkish lira", ["USD"] = "US dollars", ["EUR"] = "euro", ["GBP"] = "pounds sterling",
        ["CHF"] = "Swiss francs", ["JPY"] = "Japanese yen", ["CAD"] = "Canadian dollars",
        ["AUD"] = "Australian dollars", ["SEK"] = "Swedish krona", ["RUB"] = "Russian rubles",
        ["AZN"] = "Azerbaijani manat",
    };

    // The user's base currency, TRY when unset.
    public static string DefaultCurrency(int uid)
    {
        var value = Settings.Get(uid, "base_currency", "TRY");
        return string.IsNullOrEmpty(value) ? "TRY" : value;
    }

    // The user's opening balance, added to the all-time net.
    public static double StartingBalance(int uid) => Input.LeadingNumber(Settings.Get(uid, "starting_balance", "0") ?? "0");

    // Spelled-out currency name, or the code itself.
    public static string CurrencyName(string code)
    {
        code = code.Trim().ToUpperInvariant();
        return CurrencyNames.GetValueOrDefault(code, code);
    }

    // "2000.00 TRY": an amount for a machine reader, always with its currency.
    public static string Text(double amount, string currency) =>
        amount.ToString("0.00", CultureInfo.InvariantCulture) + " " + currency.Trim().ToUpperInvariant();

    // Turns a period key into an inclusive date window.
    public static MoneyWindow Range(string period, DateTime? now = null)
    {
        var today = (now ?? DateTime.Now).Date;
        var firstThis = new DateTime(today.Year, today.Month, 1);
        var endThis = firstThis.AddMonths(1).AddDays(-1);
        return period switch
        {
            "last_month" => new(period, D(firstThis.AddMonths(-1)), D(firstThis.AddDays(-1)), "Last month"),
            "3m" => new(period, D(firstThis.AddMonths(-2)), D(endThis), "Last 3 months"),
            "6m" => new(period, D(firstThis.AddMonths(-5)), D(endThis), "Last 6 months"),
            "year" => new(period, $"{today.Year}-01-01", $"{today.Year}-12-31", "This year"),
            "all" => new(period, null, null, "All time"),
            _ => new("month", D(firstThis), D(endThis), "This month"),
        };
    }

    // Turns a legacy month=YYYY-MM into a window, or null when malformed.
    public static MoneyWindow? MonthRange(string month, string period)
    {
        if (!Regex.IsMatch(month, @"^\d{4}-(0[1-9]|1[0-2])$")) return null;
        var first = DateTime.ParseExact(month + "-01", "yyyy-MM-dd", CultureInfo.InvariantCulture);
        var label = first.ToString("MMMM yyyy", CultureInfo.InvariantCulture);
        return new(period, D(first), D(first.AddMonths(1).AddDays(-1)), label);
    }

    // The window a request asks for: period wins, then month=YYYY-MM, then the default.
    public static MoneyWindow Window(Input input, string fallback = "month")
    {
        var period = input.Str("period");
        if (period != null)
        {
            var key = Periods.Contains(period) ? period : fallback;
            return Range(key) with { Period = key };
        }
        var month = input.Str("month");
        if (month != null)
        {
            var range = MonthRange(month, fallback);
            if (range != null) return range;
        }
        return Range(fallback) with { Period = fallback };
    }

    // Formats a date as YYYY-MM-DD.
    static string D(DateTime d) => d.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture);
}
