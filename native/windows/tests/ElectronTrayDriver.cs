// Test-owned foreground form grants a real last-input event before testing recovery.
// Only the disposable Electron fixture identified by both PID and HWND receives input.
using System;
using System.Diagnostics;
using System.Windows.Forms;
using LaunchFlow.Native;
class ElectronFixtureDesktop : FocusDesktop
{
    public string Runtime, Script, Marker;
    public bool Baseline;
    public override string ApplicationId(IntPtr h) { return Baseline ? "" : "LaunchFlow.TrayFixture_test!App"; }
    public override void ActivateApplication(string id) {
        using (var child = Process.Start(new ProcessStartInfo {
            FileName = Runtime,
            Arguments = ApplicationLauncher.Quote(Script) + " " + ApplicationLauncher.Quote(Marker),
            UseShellExecute = false, CreateNoWindow = true,
        })) { }
    }
}
class ElectronTrayDriver
{
    [STAThread] static int Main(string[] args)
    {
        Win.SetProcessDpiAwarenessContext(new IntPtr(-4));
        uint pid = uint.Parse(args[0]), owner;
        var target = new IntPtr(long.Parse(args[1]));
        Win.GetWindowThreadProcessId(target, out owner);
        if (owner != pid || Win.Class(target) != "Chrome_WidgetWin_1") return 2;
        var desktop = new ElectronFixtureDesktop { Runtime = args[2], Script = args[3], Marker = args[4],
            Baseline = args.Length > 5 && args[5] == "--baseline" };
        var form = new Form { Text = "LaunchFlow Electron regression driver", Width = 350, Height = 120,
            TopMost = true, StartPosition = FormStartPosition.CenterScreen };
        var button = new Button { Text = "Test owned Electron fixture", Dock = DockStyle.Fill };
        form.Controls.Add(button);
        form.Shown += delegate { Win.ShowWindow(form.Handle, 5); };
        bool clicked = false, success = false;
        button.Click += delegate {
            clicked = true; form.Hide();
            try {
                Win.GetWindowThreadProcessId(target, out owner);
                if (owner != pid || !Win.IsWindow(target)) throw new Exception("Fixture changed");
                WindowFocus.Activate(target, desktop, true);
                Win.RECT bounds; Win.GetWindowRect(target, out bounds);
                PointerInput.Start("coordinate", "button", "fixture");
                PointerInput.Click(target, bounds.Left + 110, bounds.Top + 120, "click");
                Console.WriteLine(Wire.Json.Serialize(Wire.Obj("focus", WindowFocus.LastDiagnostic,
                    "pointer", PointerInput.Diagnostic)));
                success = true;
            } catch (Exception e) { Console.WriteLine(e.ToString()); }
            form.Close();
        };
        var clock = Stopwatch.StartNew();
        var timer = new Timer { Interval = 150 };
        timer.Tick += delegate {
            if (clock.ElapsedMilliseconds > 7000) { form.Close(); return; }
            if (clicked) return;
            if (!Win.IsWindowVisible(form.Handle)) Win.ShowWindow(form.Handle, 5);
            Win.RECT bounds; Win.GetWindowRect(button.Handle, out bounds);
            var point = new Win.POINT { X = (bounds.Left + bounds.Right) / 2, Y = (bounds.Top + bounds.Bottom) / 2 };
            if (Win.WindowFromPoint(point) == button.Handle)
                Win.Send(new System.Collections.Generic.List<Win.INPUT> { Win.Mouse(point.X, point.Y, 2), Win.Mouse(point.X, point.Y, 4) });
        };
        timer.Start(); Application.Run(form); timer.Dispose();
        return success ? 0 : 3;
    }
}
