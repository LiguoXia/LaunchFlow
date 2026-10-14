// Owned NotifyIcon fixture: no interaction with the user's running tray apps.
using System;
using System.IO;
using System.Windows.Forms;
using System.Drawing;
using LaunchFlow.Native;
class InteractiveTrayForm : Form
{
    public bool InteractionReady = true;
    public void HideToTray() { InteractionReady = false; Hide(); }
    public void ShowFromApplication() { Show(); InteractionReady = true; Activate(); }
    protected override void WndProc(ref Message message) {
        if (message.Msg == 0x0112 && ((message.WParam.ToInt64() & 0xFFF0) == 0xF120 ||
            (message.WParam.ToInt64() & 0xFFF0) == 0xF030)) {
            ShowFromApplication();
        }
        base.WndProc(ref message);
    }
}
class TrayWindowFixture
{
    [STAThread] static void Main(string[] args)
    {
        Win.SetProcessDpiAwarenessContext(new IntPtr(-4));
        var main = new InteractiveTrayForm { Text="LaunchFlow Tray Fixture", Width=620, Height=350, StartPosition=FormStartPosition.CenterScreen };
        int clicks = 0;
        var button = new Button { Text="Test Click", Left=60, Top=90, Width=160, Height=55 };
        button.Click += delegate { if (main.InteractionReady) clicks++; };
        main.Controls.Add(button);
        // A titled notification message HWND may look like a main window by style.
        // Its class and dimensions must never qualify it as an activation target.
        var messageWindow = new Form { Text="LaunchFlow Tray Message", Width=150, Height=60 };
        if (args.Length > 1) messageWindow.FormBorderStyle = FormBorderStyle.FixedToolWindow;
        var messageHandle = messageWindow.Handle;
        var helper = new Form { Text="LaunchFlow Tray Helper", FormBorderStyle=FormBorderStyle.FixedToolWindow, ShowInTaskbar=false };
        var helperHandle = helper.Handle;
        Form duplicate = null;
        using(var tray = new NotifyIcon { Icon=SystemIcons.Application, Text="LaunchFlow owned tray fixture", Visible=true }) {
            tray.DoubleClick += delegate { main.ShowFromApplication(); };
            main.Shown += delegate { main.BeginInvoke(new Action(delegate { main.HideToTray(); })); };
            var timer = new Timer { Interval=50 };
            timer.Tick += delegate {
                var commandPath=args[0]+".command";
                if(File.Exists(commandPath)) {
                    var command=File.ReadAllText(commandPath); File.Delete(commandPath);
                    if(command=="hide") main.HideToTray();
                    if(command=="maximizeHide") { main.WindowState=FormWindowState.Maximized; main.HideToTray(); }
                    if(command=="minimize") { main.Show(); main.WindowState=FormWindowState.Minimized; }
                    if(command=="duplicate") { duplicate=new Form { Text=main.Text }; var handle=duplicate.Handle; }
                    if(command=="removeDuplicate" && duplicate!=null) { duplicate.Dispose(); duplicate=null; }
                }
                var state = Desktop.WindowInfo(main.Handle);
                state["interactionReady"] = main.InteractionReady;
                state["clicks"] = clicks;
                var point = button.PointToScreen(new Point(button.Width/2, button.Height/2));
                state["clickPoint"] = Wire.Obj("x",point.X,"y",point.Y);
                File.WriteAllText(args[0]+".json", Wire.Json.Serialize(state));
            };
            timer.Start(); Application.Run(main); timer.Stop(); helper.Dispose(); messageWindow.Dispose(); if(duplicate!=null) duplicate.Dispose();
        }
    }
}
