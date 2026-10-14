using System;
using LaunchFlow.Native;

class FakeFocus : FocusDesktop
{
    public long Now;
    public int Requests, Restores, Shows;
    public long ShownAt = 0;
    public long ActivatedAt = 400, RestoredAt = 0, DisappearedAt = long.MaxValue;
    public bool Accepted = true;
    public bool InputEnabled = true, InputResponsive = true;
    public bool IsFramework, HideOnShow;
    public IntPtr Current = new IntPtr(22);
    public IntPtr CurrentRoot;
    public override long Milliseconds { get { return Now; } }
    public override bool Exists(IntPtr h) { return Now < DisappearedAt; }
    public override bool Minimized(IntPtr h) { return Now < RestoredAt; }
    public override bool Visible(IntPtr h) { return Now >= ShownAt; }
    public override bool FrameworkWindow(IntPtr h) { return IsFramework; }
    public override bool Enabled(IntPtr h) { return InputEnabled; }
    public override bool Responsive(IntPtr h) { return InputResponsive; }
    public override IntPtr Foreground() { return Now >= ActivatedAt ? new IntPtr(11) : Current; }
    public override IntPtr Root(IntPtr h) { return h == Current ? CurrentRoot : h; }
    public override void Restore(IntPtr h) { Restores++; }
    public override void Show(IntPtr h) { Shows++; if (HideOnShow && Shows == 1) ShownAt = 300; }
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
        d = new FakeFocus { ActivatedAt = 0, IsFramework = true };
        WindowFocus.Activate(Target, d, true);
        Check(d.Shows == 1 && d.Requests == 0, "Explicit activation repairs an already visible framework window once");
        d = new FakeFocus { IsFramework = true, HideOnShow = true };
        WindowFocus.Activate(Target, d, true);
        Check(d.Shows == 1 && d.Now == 400,
            "Clearing a visible ghost before application activation never dispatches a second restore request");
        d = new FakeFocus { ShownAt = 300, ActivatedAt = 700, IsFramework = true };
        WindowFocus.Activate(Target, d, true);
        Check(d.Shows == 1, "A hidden framework receives one application restore request, not two");
        d = new FakeFocus { ActivatedAt = 0, InputEnabled = false };
        failure = Failure(() => WindowFocus.Activate(Target, d));
        Check(failure.Code == "focusDenied" && d.Requests == 0 && d.Now == 2000,
            "Visible foreground but disabled modal owner never reports interaction success");
        failure = Failure(() => WindowFocus.BeforeInput(Target, d));
        Check(failure.Code == "focusDenied", "Input guard preserves disabled modal owners");
        d = new FakeFocus { ActivatedAt = 0, InputResponsive = false };
        failure = Failure(() => WindowFocus.Activate(Target, d));
        Check(failure.Code == "focusDenied" && d.Requests == 0 && d.Now == 2000,
            "A visible foreground window with an unresponsive input thread does not succeed");
        failure = Failure(() => WindowFocus.BeforeInput(Target, d));
        Check(failure.Code == "focusDenied", "Unresponsive windows never receive input");
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
        var packaged = new PackagedFocus();
        packaged.Show(Target);
        Check(packaged.ActivatedId == "LaunchFlow.TrayFixture_test!App" && packaged.HiddenRestoreMethod == "applicationActivation",
            "Packaged Chromium restores via the application entry rather than WM_SYSCOMMAND");
        packaged = new PackagedFocus { GhostVisible = true };
        packaged.Show(Target);
        Check(packaged.HiddenBeforeDispatch && packaged.ActivatedId != null,
            "Already-visible ghost is hidden before dispatch so stale visibility cannot acknowledge recovery");
        Check(!PackagedWindowActivation.ValidId("Chrome") && !PackagedWindowActivation.ValidId("test!App") &&
            !PackagedWindowActivation.ValidId("Test_pkg!App --other") && !PackagedWindowActivation.ValidId("Test_pkg!App!Other"),
            "Only a registered packaged application identifier can be dispatched");
        packaged = new PackagedFocus { Reject = true };
        failure = Failure(() => packaged.Show(Target));
        Check(failure.Code == "focusDenied" && packaged.HiddenRestoreMethod == "applicationActivation",
            "Failed application activation never falls back to a ghost HWND restore");
        d = new FakeFocus { ShownAt = 3200, ActivatedAt = 3400, HiddenRestoreMethod = "applicationActivation" };
        WindowFocus.Activate(Target, d);
        Check(d.Now == 3400 && d.Shows == 1 && d.Requests == 1,
            "Application-owned activation can take longer than a Win32 restore without being repeated");
        d = new FakeFocus { ShownAt = long.MaxValue, ActivatedAt = long.MaxValue, HiddenRestoreMethod = "applicationActivation" };
        failure = Failure(() => WindowFocus.Activate(Target, d));
        Check(failure.Code == "focusDenied" && d.Now == 5000 && d.Shows == 1 && d.Requests == 0,
            "Unacknowledged packaged restore fails within five seconds without input");
        Console.WriteLine("Passed " + count + " window focus regression tests; no desktop input injected.");
    }
}
class PackagedFocus : FocusDesktop
{
    public string ActivatedId;
    public bool Reject;
    public bool GhostVisible, HiddenBeforeDispatch;
    public override string ClassName(IntPtr h) { return "Chrome_WidgetWin_1"; }
    public override string ApplicationId(IntPtr h) { return "LaunchFlow.TrayFixture_test!App"; }
    public override bool Visible(IntPtr h) { return GhostVisible; }
    public override void HideForApplicationRestore(IntPtr h) { GhostVisible = false; HiddenBeforeDispatch = true; }
    public override void ActivateApplication(string id) {
        ActivatedId = id;
        if (Reject) throw new NativeFailure("focusDenied", "Test activation rejected");
    }
}
