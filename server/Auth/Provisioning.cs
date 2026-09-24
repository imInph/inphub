using Inphub.Core;

namespace Inphub.Auth;

// These defaults mirror the seed block for user 1 in inphub.sql; change both together.
public static class Provisioning
{
    static readonly (string Key, string Value)[] DefaultSettings =
    [
        ("theme", "dark"), ("base_currency", "TRY"), ("starting_balance", "0"), ("owner_name", ""),
        ("github_username", ""), ("github_token", ""), ("stale_repo_days", "60"), ("ai_enabled", "0"),
        ("ai_provider", "claude"), ("claude_api_key", ""), ("claude_model", "claude-sonnet-5"),
        ("ollama_base_url", "http://127.0.0.1:11434"), ("ollama_model", "llama3.1"),
        ("lmstudio_base_url", "http://127.0.0.1:1234"), ("lmstudio_model", ""), ("lmstudio_api_key", ""),
    ];

    static readonly (string Name, string Color, string Icon)[] DefaultCategories =
    [
        ("Food & Drink", "#f97316", "🍔"), ("Transport", "#3b82f6", "🚌"), ("Tech & Gadgets", "#8b5cf6", "💻"),
        ("Cubing", "#22c55e", "🧩"), ("Games", "#ec4899", "🎮"), ("Subscriptions", "#eab308", "🔁"),
        ("Education", "#14b8a6", "📚"), ("Other", "#6b7280", "📦"),
    ];

    static readonly (string Name, string Description, string Color, string Icon, int Sort)[] DefaultHabits =
    [
        ("Cube practice", "Timed solves / algorithm drills", "#22c55e", "🧩", 1),
        ("Ship code", "Commit something to a repo", "#8b5cf6", "💾", 2),
        ("Read", "Read anything non-screen", "#14b8a6", "📖", 3),
        ("Move", "Exercise / walk", "#f97316", "🏃", 4),
    ];

    // Seeds settings, categories and habits for a user who has none yet. Safe to call on every login.
    public static void Run(int uid)
    {
        if (Db.Scalar<long>("SELECT COUNT(*) FROM settings WHERE user_id = @uid", new { uid }) == 0)
        {
            var user = Db.Row("SELECT display_name, username FROM users WHERE id = @uid", new { uid });
            var ownerName = "";
            if (user != null)
            {
                var display = user["display_name"] as string;
                ownerName = string.IsNullOrEmpty(display) ? (string)user["username"]! : display;
            }
            foreach (var (key, value) in DefaultSettings)
            {
                Db.Execute("INSERT INTO settings (user_id, setting_key, setting_value) VALUES (@uid, @key, @value)",
                    new { uid, key, value = key == "owner_name" ? ownerName : value });
            }
        }

        if (Db.Scalar<long>("SELECT COUNT(*) FROM expense_categories WHERE user_id = @uid", new { uid }) == 0)
        {
            foreach (var (name, color, icon) in DefaultCategories)
            {
                Db.Execute("INSERT INTO expense_categories (user_id, name, color, icon) VALUES (@uid, @name, @color, @icon)",
                    new { uid, name, color, icon });
            }
        }

        if (Db.Scalar<long>("SELECT COUNT(*) FROM habits WHERE user_id = @uid", new { uid }) == 0)
        {
            foreach (var (name, description, color, icon, sort) in DefaultHabits)
            {
                Db.Execute(
                    @"INSERT INTO habits (user_id, name, description, frequency, target_per_period, color, icon, sort_order)
                      VALUES (@uid, @name, @description, 'daily', 1, @color, @icon, @sort)",
                    new { uid, name, description, color, icon, sort });
            }
        }
    }
}
