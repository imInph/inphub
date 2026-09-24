namespace Inphub.Core;

public static class AppInfo
{
    public const string Version = "4.1.0";

    // Today's date in server local time, as YYYY-MM-DD.
    public static string Today() => DateTime.Now.ToString("yyyy-MM-dd");

    // The current local time, as YYYY-MM-DD HH:MM:SS.
    public static string Now() => DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss");
}
