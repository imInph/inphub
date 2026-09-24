using Inphub.Core;

namespace Inphub.Endpoints;

public static class Notes
{
    // GET/POST /api/notes: list (with search), create, update, pin, delete.
    public static void Map(WebApplication app) =>
        app.MapMethods("/api/notes", ["GET", "POST"], Api.Handle(Run));

    // Dispatches on ?action=.
    static object? Run(Req req)
    {
        var uid = req.Uid;
        var input = req.Input;

        switch (req.Action)
        {
            case "list":
            {
                var sql = "SELECT * FROM notes WHERE user_id = @uid";
                var q = input.Str("q");
                if (q != null) sql += " AND (title LIKE @like OR content LIKE @like OR tags LIKE @like)";
                sql += " ORDER BY pinned DESC, updated_at DESC";
                return Db.Rows(sql, new { uid, like = "%" + q + "%" });
            }
            case "create":
            {
                var content = input.Str("content") ?? throw Api.Fail("Note content is required.", 422);
                var title = input.Str("title");
                var id = Db.Insert(
                    "INSERT INTO notes (user_id, title, content, tags, pinned) VALUES (@uid, @title, @content, @tags, @pinned)",
                    new { uid, title, content, tags = input.Str("tags"), pinned = input.Bool("pinned") ? 1 : 0 });
                var rawTitle = input.Text("title");
                Activity.Log(uid, "note.created", "note", id, "New note" + (rawTitle != "" ? ": " + rawTitle : ""),
                    input.Text("created_by") == "ai" ? "ai" : "user");
                return new { id };
            }
            case "update":
            {
                var note = Api.FetchOwned("notes", input.Int("id"), uid);
                var id = Convert.ToInt32(note["id"]);
                var title = input.StrIfSent("title", note["title"]);
                Db.Execute(
                    "UPDATE notes SET title = @title, content = @content, tags = @tags, pinned = @pinned WHERE id = @id AND user_id = @uid",
                    new
                    {
                        title, id, uid,
                        content = input.Str("content") ?? (string)note["content"]!,
                        tags = input.StrIfSent("tags", note["tags"]),
                        pinned = input.Bool("pinned", Convert.ToInt32(note["pinned"]) != 0) ? 1 : 0,
                    });
                Activity.Log(uid, "note.updated", "note", id, "Edited note" + (title != null ? ": " + title : ""));
                return new { id };
            }
            case "pin":
            {
                var note = Api.FetchOwned("notes", input.Int("id"), uid);
                var id = Convert.ToInt32(note["id"]);
                var pinned = input.Bool("pinned", Convert.ToInt32(note["pinned"]) == 0);
                Db.Execute("UPDATE notes SET pinned = @pinned WHERE id = @id AND user_id = @uid", new { pinned = pinned ? 1 : 0, id, uid });
                var title = note["title"] as string;
                Activity.Log(uid, pinned ? "note.pinned" : "note.unpinned", "note", id,
                    (pinned ? "Pinned" : "Unpinned") + " note" + (title != null ? ": " + title : ""));
                return new { id };
            }
            case "delete":
            {
                var note = Api.FetchOwned("notes", input.Int("id"), uid);
                var id = Convert.ToInt32(note["id"]);
                Db.Execute("DELETE FROM notes WHERE id = @id AND user_id = @uid", new { id, uid });
                var title = note["title"] as string;
                Activity.Log(uid, "note.deleted", "note", id, "Deleted note" + (title != null ? ": " + title : ""));
                return new { deleted = id };
            }
            default:
                throw Api.Fail("Unknown action.", 404);
        }
    }
}
