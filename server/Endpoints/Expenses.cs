using Inphub.Core;

namespace Inphub.Endpoints;

public static class Expenses
{
    static readonly string[] Types = ["expense", "income"];

    // GET/POST /api/expenses: list (by period, category, type), create, update, delete.
    public static void Map(WebApplication app) =>
        app.MapMethods("/api/expenses", ["GET", "POST"], Api.Handle(Run));

    // Dispatches on ?action=.
    static object? Run(Req req)
    {
        var uid = req.Uid;
        var input = req.Input;

        switch (req.Action)
        {
            case "list":
            {
                var sql = @"SELECT e.*, c.name AS category_name, c.color AS category_color, c.icon AS category_icon
                            FROM expenses e
                            LEFT JOIN expense_categories c ON c.id = e.category_id
                            WHERE e.user_id = @uid";
                var window = Money.Window(input, "all");
                if (window.From != null) sql += " AND e.spent_at >= @from AND e.spent_at <= @to";
                var categoryId = input.IntOrNull("category_id");
                if (categoryId != null) sql += " AND e.category_id = @categoryId";
                var type = input.Str("type");
                if (type != null) sql += " AND e.type = @type";
                sql += " ORDER BY e.spent_at DESC, e.id DESC";
                return Db.Rows(sql, new
                {
                    uid, from = window.From, to = window.To, categoryId,
                    type = Api.ValidEnum(type, Types, "expense"),
                });
            }
            case "create":
            {
                var amount = input.NumOrNull("amount") ?? throw Api.Fail("Amount is required.", 422);
                var type = Api.ValidEnum(input.Text("type"), Types, "expense");
                var createdBy = input.Text("created_by") == "ai" ? "ai" : "user";
                var categoryId = input.IntOrNull("category_id");
                AssertCategoryOwned(categoryId, uid);

                var currencyText = input.Text("currency");
                var currency = Currency(string.IsNullOrEmpty(currencyText) || currencyText == "0" ? Money.DefaultCurrency(uid) : currencyText);
                var id = Db.Insert(
                    @"INSERT INTO expenses
                        (user_id, type, amount, currency, category_id, description, payment_method, spent_at, is_recurring, recurring_interval, created_by)
                      VALUES (@uid, @type, @amount, @currency, @categoryId, @description, @payment_method, @spent_at, @is_recurring, @recurring_interval, @createdBy)",
                    new
                    {
                        uid, type, amount, currency, categoryId, createdBy,
                        description = input.Str("description"),
                        payment_method = input.Str("payment_method"),
                        spent_at = input.Str("spent_at") ?? AppInfo.Today(),
                        is_recurring = input.Bool("is_recurring") ? 1 : 0,
                        recurring_interval = input.Str("recurring_interval"),
                    });
                var verb = type == "income" ? "Income" : "Spent";
                Activity.Log(uid, "expense.created", "expense", id, $"{verb} {Money.Text(amount, currency)}", createdBy);
                return new { id };
            }
            case "update":
            {
                var entry = Api.FetchOwned("expenses", input.Int("id"), uid);
                var id = Convert.ToInt32(entry["id"]);
                var categoryId = input.Has("category_id") ? input.IntOrNull("category_id") : entry["category_id"] as int?;
                AssertCategoryOwned(categoryId, uid);
                var type = (string)entry["type"]!;
                Db.Execute(
                    @"UPDATE expenses SET type = @type, amount = @amount, currency = @currency, category_id = @categoryId,
                        description = @description, payment_method = @payment_method, spent_at = @spent_at,
                        is_recurring = @is_recurring, recurring_interval = @recurring_interval
                      WHERE id = @id AND user_id = @uid",
                    new
                    {
                        id, uid, categoryId,
                        type = Api.ValidEnum(input.Str("type") ?? type, Types, type),
                        amount = input.NumOrNull("amount") ?? Input.LeadingNumber((string)entry["amount"]!),
                        currency = Currency(input.Has("currency") ? input.Text("currency") : (string)entry["currency"]!),
                        description = input.StrIfSent("description", entry["description"]),
                        payment_method = input.StrIfSent("payment_method", entry["payment_method"]),
                        spent_at = input.Str("spent_at") ?? (string)entry["spent_at"]!,
                        is_recurring = input.Bool("is_recurring", Convert.ToInt32(entry["is_recurring"]) != 0) ? 1 : 0,
                        recurring_interval = input.StrIfSent("recurring_interval", entry["recurring_interval"]),
                    });
                Activity.Log(uid, "expense.updated", "expense", id, "Updated an entry");
                return new { id };
            }
            case "delete":
            {
                var entry = Api.FetchOwned("expenses", input.Int("id"), uid);
                var id = Convert.ToInt32(entry["id"]);
                Db.Execute("DELETE FROM expenses WHERE id = @id AND user_id = @uid", new { id, uid });
                Activity.Log(uid, "expense.deleted", "expense", id, "Deleted an entry");
                return new { deleted = id };
            }
            default:
                throw Api.Fail("Unknown action.", 404);
        }
    }

    // A currency code: first three characters, upper case.
    static string Currency(string code) => (code.Length > 3 ? code[..3] : code).ToUpperInvariant();

    // Fails when a category id does not belong to the user.
    static void AssertCategoryOwned(int? categoryId, int uid)
    {
        if (categoryId == null) return;
        var found = Db.Scalar<int?>("SELECT 1 FROM expense_categories WHERE id = @categoryId AND user_id = @uid", new { categoryId, uid });
        if (found == null) throw Api.Fail("Unknown category.", 422);
    }
}
