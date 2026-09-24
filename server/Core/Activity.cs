using System.Text.Json;

namespace Inphub.Core;

public static class Activity
{
    // Writes one activity_log row; the dashboard, brief and weekly review read these.
    public static void Log(int uid, string type, string? entityType, int? entityId, string summary,
        string actor = "user", object? metadata = null)
    {
        if (summary.Length > 500) summary = summary[..500];
        Db.Execute(
            @"INSERT INTO activity_log (user_id, type, entity_type, entity_id, summary, actor, metadata)
              VALUES (@uid, @type, @entityType, @entityId, @summary, @actor, @meta)",
            new
            {
                uid, type, entityType, entityId, summary, actor,
                meta = metadata == null ? null : JsonSerializer.Serialize(metadata, Api.Json),
            });
    }
}
