// Gives an isolated LaunchFlow test instance foreground through a real click on
// this disposable fixture. Never sends input unless the hit-tested HWND is ours.
using System;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Windows.Forms;
using LaunchFlow.Native;
class ForegroundFixture
{
    [DllImport("user32.dll")] static extern IntPtr WindowFromPoint(Win.POINT point);
    [STAThread] static int Main(string[] args)
    {
        Win.SetProcessDpiAwarenessContext(new IntPtr(-4));
        int pid = int.Parse(args[0]);
        IntPtr target = new IntPtr(long.Parse(args[1]));
        uint owner;
        Win.GetWindowThreadProcessId(target, out owner);
        if (owner != pid || !Win.IsWindow(target)) return 2;
        bool success = false, clicked = false, accepted = false;
        int hits = 0;
        bool probed = false;
        var form = new Form { Text = "LaunchFlow foreground test fixture", Width = 380, Height = 120,
            TopMost = true, StartPosition = FormStartPosition.CenterScreen };
        var button = new Button { Text = "Focus isolated LaunchFlow test", Dock = DockStyle.Fill };
        form.Controls.Add(button);
        form.Shown += delegate { Win.ShowWindow(form.Handle, 5); };
        button.Click += delegate {
            clicked = true;
            Win.GetWindowThreadProcessId(target, out owner);
            if (owner == pid && Win.IsWindow(target)) accepted = Win.SetForegroundWindow(target);
        };
        var watch = Stopwatch.StartNew();
        var timer = new Timer { Interval = 150 };
        timer.Tick += delegate {
            if (!Win.IsWindowVisible(form.Handle)) Win.ShowWindow(form.Handle, 5);
            if (clicked && Win.GetForegroundWindow() == target) { success = true; form.Close(); return; }
            if (watch.ElapsedMilliseconds > 5000) { form.Close(); return; }
            if (!clicked) {
                Win.RECT r;
                Win.GetWindowRect(button.Handle, out r);
                var p = new Win.POINT { X = (r.Left + r.Right) / 2, Y = (r.Top + r.Bottom) / 2 };
                if (!probed) {
                    probed = true; uint hitPid; var hit = WindowFromPoint(p); Win.GetWindowThreadProcessId(hit, out hitPid);
                    Console.WriteLine("Fixture probe visible=" + Win.IsWindowVisible(form.Handle) + ", buttonVisible=" + Win.IsWindowVisible(button.Handle) + ", ownHit=" + (hitPid == Process.GetCurrentProcess().Id) + ", hitProcess=" + (hitPid == 0 ? "none" : Process.GetProcessById((int)hitPid).ProcessName));
                }
                if (WindowFromPoint(p) != button.Handle) return;
                hits++;
                Win.Send(new System.Collections.Generic.List<Win.INPUT> {
                    Win.Mouse(p.X, p.Y, 2), Win.Mouse(p.X, p.Y, 4) });
            }
        };
        timer.Start();
        Application.Run(form);
        timer.Dispose();
        Console.WriteLine("Foreground fixture: success=" + success + ", clicked=" + clicked + ", accepted=" + accepted + ", hitTests=" + hits);
        return success ? 0 : 3;
    }
}
