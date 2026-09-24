using System.Data;
using System.Globalization;
using MySqlConnector;

namespace Inphub.Core;

public static class Db
{
    public static string ConnectionString = "";

    // Builds the connection string from the Inphub config section.
    public static void Configure(IConfiguration config)
    {
        var b = new MySqlConnectionStringBuilder
        {
            Server = config["Inphub:DbHost"] ?? "localhost",
            Database = config["Inphub:DbName"] ?? "inphub",
            UserID = config["Inphub:DbUser"] ?? "root",
            Password = config["Inphub:DbPass"] ?? "",
            CharacterSet = "utf8mb4",
            TreatTinyAsBoolean = false,
            AllowUserVariables = true,
        };
        ConnectionString = b.ConnectionString;
    }

    // Opens a pooled connection.
    public static MySqlConnection Open()
    {
        var conn = new MySqlConnection(ConnectionString);
        conn.Open();
        return conn;
    }

    // Opens a connection and starts a transaction on it; dispose the connection when done.
    public static MySqlTransaction Begin() => Open().BeginTransaction();

    // Runs a query and returns every row as a column => value map, formatted like PHP returned it.
    public static List<Dictionary<string, object?>> Rows(string sql, object? args = null, MySqlTransaction? tx = null)
    {
        return Use(tx, conn =>
        {
            using var cmd = Command(conn, tx, sql, args);
            using var reader = cmd.ExecuteReader();
            var rows = new List<Dictionary<string, object?>>();
            while (reader.Read())
            {
                var row = new Dictionary<string, object?>();
                for (var i = 0; i < reader.FieldCount; i++)
                {
                    row[reader.GetName(i)] = Clean(reader, i);
                }
                rows.Add(row);
            }
            return rows;
        });
    }

    // Runs a query and returns the first row, or null.
    public static Dictionary<string, object?>? Row(string sql, object? args = null, MySqlTransaction? tx = null)
    {
        var rows = Rows(sql, args, tx);
        return rows.Count > 0 ? rows[0] : null;
    }

    // Runs a query and returns the first column of the first row, converted to T (default when NULL).
    public static T? Scalar<T>(string sql, object? args = null, MySqlTransaction? tx = null)
    {
        var value = Use(tx, conn =>
        {
            using var cmd = Command(conn, tx, sql, args);
            return cmd.ExecuteScalar();
        });
        if (value == null || value is DBNull) return default;
        var target = Nullable.GetUnderlyingType(typeof(T)) ?? typeof(T);
        if (target == typeof(object) || target.IsInstanceOfType(value)) return (T)value;
        return (T)Convert.ChangeType(value, target, CultureInfo.InvariantCulture);
    }

    // Runs a statement and returns the number of affected rows.
    public static int Execute(string sql, object? args = null, MySqlTransaction? tx = null)
    {
        return Use(tx, conn =>
        {
            using var cmd = Command(conn, tx, sql, args);
            return cmd.ExecuteNonQuery();
        });
    }

    // Runs an INSERT and returns the new row id.
    public static int Insert(string sql, object? args = null, MySqlTransaction? tx = null)
    {
        return Use(tx, conn =>
        {
            using var cmd = Command(conn, tx, sql, args);
            cmd.ExecuteNonQuery();
            return (int)cmd.LastInsertedId;
        });
    }

    // Runs work on the transaction's connection, or on a fresh one that is closed afterwards.
    static T Use<T>(MySqlTransaction? tx, Func<MySqlConnection, T> work)
    {
        if (tx != null) return work(tx.Connection!);
        using var conn = Open();
        return work(conn);
    }

    // A command with one @parameter per property of args (new { uid, title } => @uid, @title), or per key of a dictionary.
    static MySqlCommand Command(MySqlConnection conn, MySqlTransaction? tx, string sql, object? args)
    {
        var cmd = new MySqlCommand(sql, conn, tx);
        if (args == null) return cmd;
        if (args is IDictionary<string, object?> dict)
        {
            foreach (var (name, value) in dict) cmd.Parameters.AddWithValue("@" + name, value ?? DBNull.Value);
            return cmd;
        }
        foreach (var prop in args.GetType().GetProperties())
        {
            cmd.Parameters.AddWithValue("@" + prop.Name, prop.GetValue(args) ?? DBNull.Value);
        }
        return cmd;
    }

    // DECIMAL comes back as a string ("12.50"), dates as "Y-m-d" / "Y-m-d H:i:s", like PDO did.
    static object? Clean(IDataReader reader, int i)
    {
        if (reader.IsDBNull(i)) return null;
        var value = reader.GetValue(i);
        return value switch
        {
            decimal d => d.ToString(CultureInfo.InvariantCulture),
            DateTime dt => reader.GetDataTypeName(i) == "DATE"
                ? dt.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture)
                : dt.ToString("yyyy-MM-dd HH:mm:ss", CultureInfo.InvariantCulture),
            TimeSpan t => t.ToString(@"hh\:mm\:ss", CultureInfo.InvariantCulture),
            sbyte or byte or short or ushort => Convert.ToInt32(value),
            _ => value,
        };
    }
}
