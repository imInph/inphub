namespace Inphub.Tools;

// A pass/fail counter for the self-tests; there is no test framework here on purpose.
public class Checks
{
    public int Passed;
    public int Failed;

    // Prints ok or FAIL for one comparison.
    public void Check(string what, object? got, object? want)
    {
        if (Equals(got, want))
        {
            Passed++;
            Console.WriteLine($"ok   {what}");
        }
        else
        {
            Failed++;
            Console.WriteLine($"FAIL {what}\n     got  {got ?? "null"}\n     want {want ?? "null"}");
        }
    }

    // Prints the totals and returns the exit code.
    public int Finish()
    {
        Console.WriteLine($"\n{Passed} passed, {Failed} failed");
        return Failed == 0 ? 0 : 1;
    }
}
