using System;
using System.Collections.Generic;
using System.Drawing;
using System.IO;
using System.Windows.Forms;
using LaunchFlow.Native;
class NonActivatingCover : Form { protected override bool ShowWithoutActivation { get { return true; } } }
class CanvasClickFixture : Form
{
    readonly string prefix;
    readonly List<string> clicks = new List<string>();
    string hover = "", down = "";
    NonActivatingCover cover;
    Rectangle LeftZone { get { return new Rectangle(40, 90, 110, 75); } }
    Rectangle RightZone { get { return new Rectangle(ClientSize.Width - 150, 90, 110, 75); } }
    string Zone(Point p) { return LeftZone.Contains(p) ? "left" : RightZone.Contains(p) ? "right" : "other"; }
    CanvasClickFixture(string path)
    {
        prefix = path; Text = "LaunchFlow Canvas Click Fixture"; Width = 640; Height = 420;
        Left = 190; Top = 220; AutoScaleMode = AutoScaleMode.None; DoubleBuffered = true;
        Paint += delegate(object sender, PaintEventArgs e) {
            e.Graphics.Clear(Color.WhiteSmoke);
            e.Graphics.FillRectangle(Brushes.Teal, LeftZone); e.Graphics.FillRectangle(Brushes.CornflowerBlue, RightZone);
            e.Graphics.DrawString("LEFT", Font, Brushes.White, LeftZone.Location);
            e.Graphics.DrawString("RIGHT", Font, Brushes.White, RightZone.Location);
            e.Graphics.DrawString("Custom canvas: " + String.Join(",", clicks), Font, Brushes.Black, 30, 230);
        };
        MouseMove += delegate(object sender, MouseEventArgs e) { hover = Zone(e.Location); };
        MouseDown += delegate(object sender, MouseEventArgs e) { down = hover == Zone(e.Location) ? Zone(e.Location) : "no-hover"; };
        MouseUp += delegate(object sender, MouseEventArgs e) { clicks.Add(down); Persist(); Invalidate(); };
        Shown += delegate { Win.ShowWindow(Handle, 5); Persist(); };
        Move += delegate { if (IsHandleCreated) Persist(); };
        Resize += delegate { if (IsHandleCreated) Persist(); };
        var started = DateTime.UtcNow;
        var timer = new Timer { Interval = 100 };
        timer.Tick += delegate {
            if (File.Exists(prefix + ".stop") || (DateTime.UtcNow - started).TotalMinutes > 4) { Close(); return; }
            if (File.Exists(prefix + ".cover") && cover == null) {
                cover = new NonActivatingCover { Text = "LaunchFlow Test Cover", TopMost = true, ShowInTaskbar = false,
                    StartPosition = FormStartPosition.Manual, FormBorderStyle = FormBorderStyle.None, BackColor = Color.Orange, Bounds = RectangleToScreen(LeftZone) };
                cover.Show();
                Win.ShowWindow(cover.Handle, 4);
            }
            if (!File.Exists(prefix + ".cover") && cover != null) { cover.Close(); cover.Dispose(); cover = null; }
        };
        timer.Start();
        FormClosed += delegate { timer.Dispose(); if (cover != null) cover.Dispose(); };
    }
    void Persist()
    {
        if (!IsHandleCreated) return;
        var left = PointToScreen(new Point(LeftZone.Left + LeftZone.Width / 2, LeftZone.Top + LeftZone.Height / 2));
        var right = PointToScreen(new Point(RightZone.Left + RightZone.Width / 2, RightZone.Top + RightZone.Height / 2));
        File.WriteAllText(prefix + ".json", Wire.Json.Serialize(Wire.Obj("handle", Handle.ToInt64().ToString(),
            "left", Wire.Obj("x", left.X, "y", left.Y), "right", Wire.Obj("x", right.X, "y", right.Y), "clicks", clicks)));
    }
    [STAThread] static void Main(string[] args)
    {
        Win.SetProcessDpiAwarenessContext(new IntPtr(-4));
        Application.Run(new CanvasClickFixture(args[0]));
    }
}
