using System;
using LaunchFlow.Native;
class RecordedPointerTests
{
    static int passed;
    static void Check(bool condition, string name) { if (!condition) throw new Exception(name); passed++; Console.WriteLine("PASS " + name); }
    static void Main()
    {
        var window = Wire.Obj("application", "Fixture.exe", "title", "Fixture", "className", "Canvas",
            "bounds", Win.Rect(878, 483, 1006, 744));
        var l = RecordedPointer.Locator(window, 978, 683);
        Check(Wire.Str(l, "kind") == "relativeCoordinate" && Math.Abs(Wire.Num(l, "x") - 100.0/1006) < 0.000001 && Math.Abs(Wire.Num(l, "y") - 200.0/744) < 0.000001, "Preserve off-center mouse-down position, not the whole-window center");
        var second = RecordedPointer.Locator(window, 1700, 683);
        Check(Wire.Num(l, "x") != Wire.Num(second, "x"), "Different points on one custom canvas remain distinct");
        Check(!RecordedPointer.CanCoalesce("click") && RecordedPointer.CanCoalesce("inputText"), "Rapid repeated clicks remain distinct while text edits coalesce");
        Check(RecordedPointer.NeedsPoint(Wire.Obj("role", "Window")), "Whole window picker uses the actual pointer position");
        Check(RecordedPointer.NeedsPoint(Wire.Obj("role", "Pane", "clickable", false)), "Non-actionable pane picker uses a pointer position");
        Check(!RecordedPointer.NeedsPoint(Wire.Obj("role", "Button", "clickable", true)), "Accessible buttons retain semantic picking");
        bool rejected = false;
        try { RecordedPointer.Locator(window, 0, 0); } catch (NativeFailure e) { rejected = e.Code == "invalidCoordinates"; }
        Check(rejected, "Reject stale picker coordinates outside the captured window");
        window["bounds"] = Win.Rect(-1200, -300, 1000, 800);
        l = RecordedPointer.Locator(window, -1100, -100);
        Check(Wire.Num(l, "x") == 0.1 && Wire.Num(l, "y") == 0.25, "Negative virtual desktop coordinates normalize correctly");
        Check(Math.Abs((100 + Wire.Num(l, "x") * 1000) - 200) < 0.00001, "Window movement keeps the captured window-relative point");
        Console.WriteLine("Passed " + passed + " recorded pointer regression tests.");
    }
}
