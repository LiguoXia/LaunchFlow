using System;
using LaunchFlow.Native;

class FakeFocus : FocusDesktop
{
    public long Now;
    public int Requests, Restores, Shows;
    public long ShownAt = 0;
    public long ActivatedAt = 400, RestoredAt = 0, DisappearedAt = long.MaxValue;
    public bool Accepted = true;
    public IntPtr Current = new IntPtr(22);
    public IntPtr CurrentRoot;
    public override long Milliseconds { get { return Now; } }
    public override bool Exists(IntPtr h) { return Now < DisappearedAt; }
    public override bool Minimized(IntPtr h) { return Now < RestoredAt; }
    public override bool Visible(IntPtr h) { return Now >= ShownAt; }
    public override IntPtr Foreground() { return Now >= ActivatedAt ? new IntPtr(11) : Current; }
    public override IntPtr Root(IntPtr h) { return h == Current ? CurrentRoot : h; }
    public override void Restore(IntPtr h) { Restores++; }
    public override void Show(IntPtr h) { Shows++; }
    public override bool Request(IntPtr h) { Requests++; return Accepted; }
    public override void Pause() { Now += 25; }
}
class WindowFocusTests
{
    static readonly IntPtr Target = new IntPtr(11);
    static int count;
    static void Check(bool condition, string name) { if (!condition) throw new Exception(name); count++; Console.WriteLine("PASS " + name); }
    static NativeFailure Failure(Action action) { try { action(); } catch (NativeFailure e) { return e; } throw new Exception("Expected guarded failure"); }
    static void Main()
    {
        var d = new FakeFocus();
        WindowFocus.Activate(Target, d);
        Check(d.Now == 400 && d.Requests == 1, "Wait for accepted asynchronous activation (old immediate check failed)");
        d = new FakeFocus { Accepted = false, ActivatedAt = 500 };
        WindowFocus.Activate(Target, d);
        Check(d.Now == 500, "Foreground observation is authoritative even if activation API returns false");
        d = new FakeFocus { Accepted = false, ActivatedAt = long.MaxValue };
        var failure = Failure(() => WindowFocus.Activate(Target, d));
        Check(failure.Code == "focusDenied" && d.Now == 2000 && d.Requests == 1, "Denied activation has bounded wait and one request");
        d = new FakeFocus { RestoredAt = 300, ActivatedAt = 700 };
        WindowFocus.Activate(Target, d);
        Check(d.Restores == 1 && d.Requests == 1 && d.Now == 700, "Restore minimized window asynchronously before activation");
        d = new FakeFocus { ShownAt = 300, ActivatedAt = 700 };
        WindowFocus.Activate(Target, d);
        Check(d.Shows == 1 && d.Restores == 0 && d.Requests == 1 && d.Now == 700,
            "Show hidden tray window before activation without resetting normal/maximized placement");
        d = new FakeFocus { ShownAt = long.MaxValue, ActivatedAt = 0 };
        failure = Failure(() => WindowFocus.Activate(Target, d));
        Check(failure.Code == "focusDenied" && d.Shows == 1 && d.Requests == 0 && d.Now == 2000,
            "A hidden window cannot succeed merely because its stale handle is foreground");
        failure = Failure(() => WindowFocus.BeforeInput(Target, d));
        Check(failure.Code == "focusDenied", "Hidden targets never receive keyboard input");
        d = new FakeFocus { ActivatedAt = 0 };
        WindowFocus.Activate(Target, d);
        Check(d.Requests == 0 && d.Restores == 0 && d.Now == 0, "Already focused or maximized window keeps its state");
        d = new FakeFocus { DisappearedAt = 200 };
        failure = Failure(() => WindowFocus.Activate(Target, d));
        Check(failure.Code == "notFound" && d.Now == 200, "Window disappearance stops activation");
        d = new FakeFocus { ActivatedAt = long.MaxValue };
        failure = Failure(() => WindowFocus.BeforeInput(Target, d));
        Check(failure.Code == "focusDenied" && d.Requests == 0, "Focus lost before input blocks input without stealing it back");
        d = new FakeFocus { ActivatedAt = 0 };
        WindowFocus.BeforeInput(Target, d);
        Check(d.Requests == 0, "Exact foreground window permits input");
        d = new FakeFocus { ActivatedAt = long.MaxValue, Current = new IntPtr(33), CurrentRoot = Target };
        WindowFocus.Activate(Target, d);
        WindowFocus.BeforeInput(Target, d);
        Check(d.Requests == 0 && d.Now == 0, "A foreground password proxy rooted in the target preserves keyboard focus");
        d = new FakeFocus { ActivatedAt = long.MaxValue, Current = new IntPtr(33), CurrentRoot = new IntPtr(44) };
        failure = Failure(() => WindowFocus.BeforeInput(Target, d));
        Check(failure.Code == "focusDenied", "Another window's foreground child cannot authorize target input");
        d = new FakeFocus { RestoredAt = long.MaxValue, ActivatedAt = long.MaxValue };
        failure = Failure(() => WindowFocus.Activate(Target, d));
        Check(failure.Code == "focusDenied" && d.Now == 2000 && d.Requests == 0 && d.Restores == 1, "Unresponsive minimized window cannot block worker indefinitely");
        Console.WriteLine("Passed " + count + " window focus regression tests; no desktop input injected.");
    }
}
