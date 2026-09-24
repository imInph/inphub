namespace Inphub.Core;

public static class Settings
{
    public const string SecretUnchanged = "••••••••";

    // Every setting for a user as key => value.
    public static Dictionary<string, string?> All(int uid)
    {
        var result = new Dictionary<string, string?>();
        foreach (var row in Db.Rows("SELECT setting_key, setting_value FROM settings WHERE user_id = @uid", new { uid }))
        {
            result[(string)row["setting_key"]!] = (string?)row["setting_value"];
        }
        return result;
    }

    // One setting value, or the fallback when the row is missing.
    public static string? Get(int uid, string key, string? fallback = null)
    {
        var row = Db.Row("SELECT setting_value FROM settings WHERE user_id = @uid AND setting_key = @key", new { uid, key });
        return row == null ? fallback : (string?)row["setting_value"];
    }

    // Inserts or updates one setting.
    public static void Set(int uid, string key, string? value)
    {
        Db.Execute(
            @"INSERT INTO settings (user_id, setting_key, setting_value) VALUES (@uid, @key, @value)
              ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value)",
            new { uid, key, value });
    }

    // A placeholder for a stored secret, empty when nothing is stored.
    public static string MaskSecret(string? value) => string.IsNullOrEmpty(value) ? "" : SecretUnchanged;
}
