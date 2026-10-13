// Owned NotifyIcon fixture: no interaction with the user's running tray apps.
using System;
using System.IO;
using System.Windows.Forms;
using System.Drawing;
using LaunchFlow.Native;
class TrayWindowFixture
{
    [STAThread] static void Main(string[] args)
    {
        Win.SetProcessDpiAwarenessContext(new IntPtr(-4));
        var main = new Form { Text="LaunchFlow Tray Fixture", Width=620, Height=350, StartPosition=FormStartPosition.CenterScreen };
        var helper = new Form { Text="LaunchFlow Tray Helper", FormBorderStyle=FormBorderStyle.FixedToolWindow, ShowInTaskbar=false };
        var helperHandle = helper.Handle;
        Form duplicate = null;
        using(var tray = new NotifyIcon { Icon=SystemIcons.Application, Text="LaunchFlow owned tray fixture", Visible=true }) {
            tray.DoubleClick += delegate { main.Show(); main.Activate(); };
            main.Shown += delegate { main.BeginInvoke(new Action(delegate { main.Hide(); })); };
            var timer = new Timer { Interval=50 };
            timer.Tick += delegate {
                var commandPath=args[0]+".command";
                if(File.Exists(commandPath)) {
                    var command=File.ReadAllText(commandPath); File.Delete(commandPath);
                    if(command=="hide") main.Hide();
                    if(command=="maximizeHide") { main.WindowState=FormWindowState.Maximized; main.Hide(); }
                    if(command=="minimize") { main.Show(); main.WindowState=FormWindowState.Minimized; }
                    if(command=="duplicate") { duplicate=new Form { Text=main.Text }; var handle=duplicate.Handle; }
                    if(command=="removeDuplicate" && duplicate!=null) { duplicate.Dispose(); duplicate=null; }
                }
                File.WriteAllText(args[0]+".json", Wire.Json.Serialize(Desktop.WindowInfo(main.Handle)));
            };
            timer.Start(); Application.Run(main); timer.Stop(); helper.Dispose(); if(duplicate!=null) duplicate.Dispose();
        }
    }
}
