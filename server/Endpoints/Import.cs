using Inphub.Core;
using Inphub.Services;

namespace Inphub.Endpoints;

public static class Import
{
    // POST /api/import: inspect (parse and report, writes nothing) or apply (one transaction).
    public static void Map(WebApplication app) =>
        app.MapMethods("/api/import", ["GET", "POST"], Api.Handle(Run));

    // Parses the file, then reports on it or writes it.
    static object? Run(Req req)
    {
        var text = req.Input.Text("file");
        if (text.Trim() == "") throw Api.Fail("No file was given.", 422);
        var parsed = Backup.Parse(text);

        if (req.Action == "inspect")
        {
            return new { counts = parsed.Counts, warnings = parsed.Warnings, meta = parsed.Meta };
        }

        var mode = req.Input.Text("mode") == "merge" ? "merge" : "replace";
        Dictionary<string, int> written;
        try
        {
            written = Backup.Apply(req.Uid, parsed, mode);
        }
        catch (Exception e)
        {
            throw Api.Fail("Import failed, nothing was changed. " + e.Message, 500);
        }

        Activity.Log(req.Uid, "data.imported", "data", null, $"Imported a backup ({mode})", "system", new { counts = written });
        return new { mode, written, warnings = parsed.Warnings };
    }
}
