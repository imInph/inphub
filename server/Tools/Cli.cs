using Inphub.Core;

namespace Inphub.Tools;

public static class Cli
{
    // Runs a command-line tool when args name one and returns its exit code; null means start the web server.
    public static int? Run(string[] args, IConfiguration config)
    {
        if (args.Length == 0) return null;
        switch (args[0])
        {
            case "hashpw":
                if (args.Length < 2 || args[1] == "")
                {
                    Console.Error.WriteLine("usage: dotnet run -- hashpw \"thePassword\"");
                    return 1;
                }
                Console.WriteLine(BCrypt.Net.BCrypt.HashPassword(args[1]));
                return 0;
            case "backup-selftest":
                return BackupSelfTest.Run();
            case "backup-dbtest":
                Db.Configure(config);
                return BackupDbTest.Run();
            default:
                return null;
        }
    }
}
