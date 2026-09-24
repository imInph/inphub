using System.Data;
using System.Globalization;
using Dapper;
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

    // Runs a query and returns every row as a column => value map, formatted like PHP returned it.
    public static List<Dictionary<string, object?>> Rows(string sql, object? args = null)
    {
        using var conn = Open();
        using var reader = conn.ExecuteReader(sql, args);
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
    }

    // Runs a query and returns the first row, or null.
    public static Dictionary<string, object?>? Row(string sql, object? args = null)
    {
        var rows = Rows(sql, args);
        return rows.Count > 0 ? rows[0] : null;
    }

    // Runs a query and returns the first column of the first row.
    public static T? Scalar<T>(string sql, object? args = null)
    {
        using var conn = Open();
        return conn.ExecuteScalar<T>(sql, args);
    }

    // Runs a statement and returns the number of affected rows.
    public static int Execute(string sql, object? args = null)
    {
        using var conn = Open();
        return conn.Execute(sql, args);
    }

    // Runs an INSERT and returns the new row id.
    public static int Insert(string sql, object? args = null)
    {
        using var conn = Open();
        conn.Execute(sql, args);
        return conn.ExecuteScalar<int>("SELECT LAST_INSERT_ID()");
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
