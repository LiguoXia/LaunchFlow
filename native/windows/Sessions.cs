using System;
using System.Linq;
using System.Collections.Generic;
using System.Threading;
using System.Windows.Automation;
using System.Windows.Forms;
using System.Runtime.InteropServices;
using System.Drawing;
namespace LaunchFlow.Native
{
    public sealed class Border : Form
    {
        protected override bool ShowWithoutActivation
        {
            get {
                return true;
            }
        }
        protected override CreateParams CreateParams
        {
            get {
                var p = base.CreateParams;
                p.ExStyle |= 0x08000000 | 0x00000080 | 0x00000020;
                p.Style = unchecked((int)0x80000000);
                return p;
            }
        }
        public Border()
        {
            Text = "";
            FormBorderStyle = FormBorderStyle.None;
            ShowInTaskbar = false;
            TopMost = true;
            BackColor = Color.FromArgb(0, 166, 126);
            AutoScaleMode = AutoScaleMode.None;
        }
    }
    public sealed class Overlay : IDisposable
    {
        readonly Border[] borders = { new Border(), new Border(), new Border(), new Border() };
        public void Draw(Dictionary<string, object> rect)
        {
            int x = (int)Wire.Num(rect, "x"), y = (int)Wire.Num(rect, "y"), w = (int)Wire.Num(rect, "width"),
                h = (int)Wire.Num(rect, "height");
            if (w <= 0 || h <= 0)
                return;
            var rectangles = new[] { new Rectangle(x - 3, y - 3, w + 6, 3), new Rectangle(x - 3, y + h, w + 6, 3),
                                     new Rectangle(x - 3, y, 3, h), new Rectangle(x + w, y, 3, h) };
            for (int i = 0; i < 4; i++)
            {
                borders[i].Bounds = rectangles[i];
                borders[i].Show();
            }
        }
        public void Dispose()
        {
            foreach (var f in borders)
                f.Dispose();
        }
    }
    public sealed class RecordingBar : Form
    {
        protected override bool ShowWithoutActivation
        {
            get {
                return true;
            }
        }
        protected override CreateParams CreateParams
        {
            get {
                var p = base.CreateParams;
                p.ExStyle |= 0x08000000 | 0x00000080;
                return p;
            }
        }
        public RecordingBar()
        {
            Text = "LaunchFlow Recording";
            FormBorderStyle = FormBorderStyle.FixedToolWindow;
            ShowInTaskbar = false;
            TopMost = true;
            StartPosition = FormStartPosition.Manual;
            Location = new Point(30, 30);
            ClientSize = new Size(410, 44);
        }
    }
    public static class Sessions
    {
        public static void Highlight(Dictionary<string, object> rect, int milliseconds)
        {
            Exception error = null;var thread=new Thread(delegate(){try{using(var overlay=new Overlay()){overlay.Draw(rect);
            var context = new ApplicationContext();
            var timer = new System.Windows.Forms.Timer { Interval = Math.Max(100, milliseconds) };
            timer.Tick += delegate
            {
                timer.Stop();
                context.ExitThread();
            };
            timer.Start();
            Application.Run(context);
            timer.Dispose();
        }
    }
    catch (Exception e)
    {
        error = e;
    }
});
thread.SetApartmentState(ApartmentState.STA);
thread.Start();
thread.Join();
if (error != null)
    throw error;
}
public static Dictionary<string, object> Locator(Dictionary<string, object> element)
{
    var source = Wire.Map(element["window"]);
    var window =
        Wire.Obj("application", Wire.Str(source, "application"), "title", Wire.Str(source, "title"), "className",
                 Wire.Str(source, "className").StartsWith("HwndWrapper[") ? "" : Wire.Str(source, "className"));
    bool input = Wire.Str(element, "role") == "Edit" || Wire.Str(element, "role") == "Document" || Wire.Bool(element, "secure");
    var ancestors = Wire.List(Wire.Get(element, "ancestorPath")).Select(delegate(object ancestor) {
        var value = new Dictionary<string, object>(Wire.Map(ancestor));
        if (input) value["name"] = "";
        return value;
    }).ToArray();
    return Wire.Obj("kind", "accessibility", "window", window, "role", Wire.Str(element, "role"), "name",
                    input ? "" : Wire.Str(element, "name"), "automationId", Wire.Str(element, "automationId"), "className",
                    Wire.Str(element, "className"), "frameworkId", Wire.Str(element, "frameworkId"), "ancestorPath",
                    ancestors);
}
public static void Run(Dictionary<string, object> request)
{
    Exception error = null;var thread=new Thread(delegate(){try{Session(request);
}
catch (Exception e)
{
    error = e;
}
});
thread.SetApartmentState(ApartmentState.STA);
thread.Start();
thread.Join();
if (error != null)
    throw error;
}
static void Session(Dictionary<string, object> request)
{
    bool picking = Wire.Str(request, "op") == "pick";
    var scope = Wire.Map(Wire.Get(request, "window"));
    IntPtr target = picking ? IntPtr.Zero : Desktop.FindWindow(scope);
    var context = new ApplicationContext();
    using (var host = new Form()) using (var overlay = new Overlay()) using (var banner = new RecordingBar())
    {
        var handle = host.Handle;
        bool paused = false, stopped = false, selected = false;
        Dictionary<string, object> hovered = null;
        var actions = new List<Dictionary<string, object>>();
        var gate = new object();
        DateTime last = DateTime.MinValue;
        DateTime lastPointer = DateTime.MinValue;
        Dictionary<string, object> pendingClick = null;
        Win.POINT downPoint = new Win.POINT();
        string hoverIdentity = "";
        RecordedText text = null;
        Action<string, Dictionary<string, object>, Dictionary<string, object>> append =
            delegate(string kind, Dictionary<string, object> element, Dictionary<string, object> values)
        {
            if (paused || stopped || actions.Count >= 256)
                return;
            var locators = Wire.Get(values, "locators") ?? new[] { Locator(element) };
            lock (gate)
            {
                if (actions.Count > 0)
                {
                    var previous = actions[actions.Count - 1];
                    bool same = Wire.Json.Serialize(previous["locators"]) == Wire.Json.Serialize(locators);
                    if (same && Wire.Str(previous, "kind") == kind && RecordedPointer.CanCoalesce(kind))
                    {
                        if (kind == "inputText")
                        {
                            previous["text"] = Wire.Str(values, "text");
                            last = DateTime.UtcNow;
                            Wire.Write(Wire.Obj("event", "actions", "actions", actions.ToArray()));
                            return;
                        }
                        if (kind == "inputSecret")
                            return;
                    }
                }
                var action = Wire.Obj("kind", kind, "locators", locators);
                foreach (var pair in values)
                    action[pair.Key] = pair.Value;
                actions.Add(action);
                last = DateTime.UtcNow;
                Wire.Write(Wire.Obj("event", "actions", "actions", actions.ToArray()));
            }
        };
        text = new RecordedText(target, append, delegate(string message) {
            Wire.Write(Wire.Obj("event", "warning", "message", message));
        });
        Action stop = delegate
        {
            if (stopped)
                return;
            if (!picking) text.Boundary();
            stopped = true;
            context.ExitThread();
        };
        var pauseButton =
            new Button { Text = "Pause Recording", Location = new Point(208, 6), Size = new Size(125, 30) };
        Action<bool> setPaused = delegate(bool value)
        {
            if (value) text.Boundary();
            paused = value;
            pendingClick = null;
            text.Reset();
            last = DateTime.MinValue;
            pauseButton.Text = value ? "Resume Recording" : "Pause Recording";
            Wire.Write(Wire.Obj("event", "state", "state", value ? "paused" : "recording"));
        };
        if (!picking)
        {
            banner.Controls.Add(new Label { Text = "● Recording · LaunchFlow", Location = new Point(10, 14),
                                            AutoSize = true, ForeColor = Color.DarkRed });
            var stopButton = new Button { Text = "Stop", Location = new Point(340, 6), Size = new Size(60, 30) };
            pauseButton.Click += delegate
            {
                setPaused(!paused);
            };
            stopButton.Click += delegate
            {
                stop();
            };
            banner.Controls.Add(pauseButton);
            banner.Controls.Add(stopButton);
            banner.Show();
        }
  var input=new Thread(delegate(){string line;
  while ((line = Console.ReadLine()) != null)
  {
      try
      {
          var command = Wire.Map(Wire.Json.DeserializeObject(line));
          string op = Wire.Str(command, "op");
          host.BeginInvoke((Action)delegate {
              if (op == "stop")
                  stop();
              if (op == "pause")
                  setPaused(true);
              if (op == "resume")
                  setPaused(false);
          });
          if (op == "stop")
              return;
      }
      catch
      {
          return;
      }
  }
  try
  {
      host.BeginInvoke(stop);
  }
  catch
  {
  }
    });
    input.IsBackground = true;
    input.Start();
    Win.HookProc mouse = delegate(int code, IntPtr message, IntPtr data)
    {
        if (code >= 0 && !paused && !stopped)
        {
            int msg = message.ToInt32();
            var inputPoint = ((Win.MouseHook)Marshal.PtrToStructure(data, typeof(Win.MouseHook))).Point;
            if (picking && (msg == 0x201 || msg == 0x202))
            {
                if (msg == 0x201 && hovered != null)
                {
                    try
                    {
                        var pickedLocator = RecordedPointer.NeedsPoint(hovered)
                            ? RecordedPointer.Locator(Wire.Map(hovered["window"]), inputPoint.X, inputPoint.Y)
                            : Locator(hovered);
                        selected = true;
                        Wire.Write(Wire.Obj("event", "selected", "element", hovered, "locator", pickedLocator));
                    }
                    catch { selected = false; }
                }
                if (msg == 0x202 && selected)
                    host.BeginInvoke(stop);
                return new IntPtr(1);
            }
            if (!picking && msg == 0x201)
            {
                host.BeginInvoke((Action)delegate { if (!paused && !stopped) text.Boundary(); });
                try
                {
                    pendingClick = null;
                    if (Win.GetAncestor(Win.WindowFromPoint(inputPoint), 2) == target)
                    {
                        downPoint = inputPoint;
                        pendingClick = RecordedPointer.Locator(Desktop.WindowInfo(target), inputPoint.X, inputPoint.Y);
                        lock (gate) { lastPointer = DateTime.UtcNow; }
                    }
                }
                catch { pendingClick = null; }
            }
            if (!picking && msg == 0x202 && pendingClick != null)
            {
                try
                {
                    var locator = pendingClick;
                    pendingClick = null;
                    lock (gate) { lastPointer = DateTime.UtcNow; }
                    // The mouse-down may already have opened a dialog or changed the page.
                    // Do not retarget (or discard) that click based on the new UI at mouse-up.
                    if (Math.Abs(inputPoint.X - downPoint.X) > SystemInformation.DragSize.Width ||
                        Math.Abs(inputPoint.Y - downPoint.Y) > SystemInformation.DragSize.Height)
                        return Win.CallNextHookEx(IntPtr.Zero, code, message, data);
                    host.BeginInvoke((Action)delegate {
                        append("click", null, Wire.Obj("locators", new[] { locator }));
                    });
                }
                catch
                {
                }
            }
        }
        return Win.CallNextHookEx(IntPtr.Zero, code, message, data);
    };
    Win.HookProc keyboard = delegate(int code, IntPtr message, IntPtr data)
    {
        if (code >= 0 && message.ToInt32() == 0x100 && !stopped)
        {
            var key = (Win.KeyHook)Marshal.PtrToStructure(data, typeof(Win.KeyHook));
            if (picking && key.Code == 27)
            {
                Wire.Write(Wire.Obj("event", "cancelled"));
                host.BeginInvoke(stop);
                return new IntPtr(1);
            }
            if (!picking && !paused && Win.GetForegroundWindow() == target)
            {
                bool ctrl = Win.GetAsyncKeyState(17) < 0, alt = Win.GetAsyncKeyState(18) < 0,
                     shift = Win.GetAsyncKeyState(16) < 0;
                // UIA calls must never block a low-level hook (the target can be
                // waiting for SendInput on its UI thread). Query on our message loop.
                host.BeginInvoke((Action)delegate {
                if (paused || stopped) return;
                try
                {
                    bool control = key.Code == 13 || key.Code == 9 || key.Code == 27 || key.Code >= 112 && key.Code <= 135 || ctrl || alt;
                    if (!control) text.BeforeKey(key.Code);
                    if (!control) return;
                    var e = AutomationElement.FocusedElement;
                    if (e != null && Desktop.ElementWindow(e) == target)
                    {
                        var info = Desktop.Info(e, target);
                        if (e.Current.IsPassword)
                        {
                            append("inputSecret", info, Wire.Obj("secretRef", "unresolved"));
                        }
                        else
                        {
                            if (ctrl && !alt && RecordedText.IsInput(e) && (key.Code == 86 || key.Code == 88 || key.Code == 90 || key.Code == 89)) {
                                text.BeforeKey(key.Code); return;
                            }
                            string keyName = key.Code == 13                       ? "Enter"
                                             : key.Code == 9                      ? "Tab"
                                             : key.Code == 27                     ? "Escape"
                                             : key.Code >= 112 && key.Code <= 135 ? "F" + (key.Code - 111)
                                                                                  : null;
                            if ((ctrl || alt) && key.Code >= 65 && key.Code <= 90)
                                keyName = ((char)key.Code).ToString();
                            if (keyName != null)
                            {
                                text.Boundary();
                                var keys = new List<string>();
                                if (ctrl)
                                    keys.Add("Ctrl");
                                if (alt)
                                    keys.Add("Alt");
                                if (shift)
                                    keys.Add("Shift");
                                keys.Add(keyName);
                                append(keys.Count > 1 ? "shortcut" : "pressKey", info,
                                       keys.Count > 1 ? Wire.Obj("keys", keys) : Wire.Obj("key", keyName));
                            }
                        }
                    }
                }
                catch
                {
                }
                });
            }
        }
        return Win.CallNextHookEx(IntPtr.Zero, code, message, data);
    };
    IntPtr mouseHook = Win.SetWindowsHookEx(14, mouse, Win.GetModuleHandle(null), 0),
           keyHook = Win.SetWindowsHookEx(13, keyboard, Win.GetModuleHandle(null), 0);
    if (mouseHook == IntPtr.Zero || keyHook == IntPtr.Zero)
    {
        if (mouseHook != IntPtr.Zero)
            Win.UnhookWindowsHookEx(mouseHook);
        if (keyHook != IntPtr.Zero)
            Win.UnhookWindowsHookEx(keyHook);
        throw new NativeFailure("hookUnavailable", "Unable to start the explicit input session.");
    }
    var timer = new System.Windows.Forms.Timer { Interval = 150 };
    AutomationPropertyChangedEventHandler changed = null;
    AutomationEventHandler invoked = null;
    AutomationEventHandler textChanged = null;
    AutomationFocusChangedEventHandler focused = null;
    AutomationElement root = null;
    try
    {
        if (picking)
        {
            timer.Tick += delegate
            {
                try
                {
                    Win.POINT p;
                    Win.GetCursorPos(out p);
                    var e = SemanticElement(AutomationElement.FromPoint(new System.Windows.Point(p.X, p.Y)));
                    var w = Desktop.ElementWindow(e);
                    if (w == IntPtr.Zero)
                        return;
                    var info = Desktop.Info(e, w);
                    if (scope.Count > 0 && !Desktop.WindowMatches(w, scope))
                        return;
                    string identity = String.Join(",", e.GetRuntimeId());
                    hovered = info;
                    overlay.Draw(Wire.Map(info["bounds"]));
                    if (identity != hoverIdentity)
                    {
                        hoverIdentity = identity;
                        Wire.Write(Wire.Obj("event", "hover", "element", info));
                    }
                }
                catch
                {
                }
            };
            timer.Start();
            Wire.Write(Wire.Obj("event", "state", "state", "picking"));
        }
        else
        {
            root = AutomationElement.FromHandle(target);
            actions.Add(Wire.Obj("kind", "activateWindow", "locators",
                                 new[] { Wire.Obj("kind", "window", "window",
                                                  Wire.Get(Locator(Desktop.Info(root, target)), "window")) }));
            changed = delegate(object sender, AutomationPropertyChangedEventArgs args)
            {
                if (paused || stopped)
                    return;
                try
                {
                    var e = sender as AutomationElement;
                    if (e == null || Desktop.ElementWindow(e) != target)
                        return;
                    host.BeginInvoke((Action)delegate { if (!paused && !stopped) text.Poll(true); });
                }
                catch
                {
                }
            };
            textChanged = delegate(object sender, AutomationEventArgs args) {
                if (paused || stopped) return;
                try { host.BeginInvoke((Action)delegate { if (!paused && !stopped) text.Poll(true); }); } catch { }
            };
            invoked = delegate(object sender, AutomationEventArgs args)
            {
                try
                {
                    // One physical click can also raise UIA Invoked; retain the physical
                    // event only. UIA-only invocations remain supported for semantic tools.
                    lock (gate) { if ((DateTime.UtcNow - lastPointer).TotalMilliseconds < 1000) return; }
                    var e = sender as AutomationElement;
                    if (e != null && Desktop.ElementWindow(e) == target)
                        append("click", Desktop.Info(e, target), Wire.Obj());
                }
                catch
                {
                }
            };
            focused = delegate(object sender, AutomationFocusChangedEventArgs args)
            {
                try
                {
                    var e = sender as AutomationElement;
                    if (e != null && Desktop.ElementWindow(e) == target && e.Current.IsPassword)
                        append("inputSecret", Desktop.Info(e, target), Wire.Obj("secretRef", "unresolved"));
                }
                catch
                {
                }
            };
            Automation.AddAutomationPropertyChangedEventHandler(root, TreeScope.Subtree, changed,
                                                                ValuePattern.ValueProperty);
            Automation.AddAutomationEventHandler(InvokePattern.InvokedEvent, root, TreeScope.Subtree, invoked);
            Automation.AddAutomationEventHandler(TextPattern.TextChangedEvent, root, TreeScope.Subtree, textChanged);
            Automation.AddAutomationFocusChangedEventHandler(focused);
            timer.Tick += delegate { if (!paused && !stopped) text.Poll(false); };
            text.Poll(false);
            timer.Start();
            Wire.Write(Wire.Obj("event", "state", "state", "recording", "window", Desktop.WindowInfo(target)));
            Wire.Write(Wire.Obj("event", "actions", "actions", actions.ToArray()));
        }
        Application.Run(context);
    }
    finally
    {
        stopped = true;
        timer.Stop();
        timer.Dispose();
        Win.UnhookWindowsHookEx(mouseHook);
        Win.UnhookWindowsHookEx(keyHook);
        if (root != null && changed != null)
            Automation.RemoveAutomationPropertyChangedEventHandler(root, changed);
        if (root != null && invoked != null)
            Automation.RemoveAutomationEventHandler(InvokePattern.InvokedEvent, root, invoked);
        if (root != null && textChanged != null)
            Automation.RemoveAutomationEventHandler(TextPattern.TextChangedEvent, root, textChanged);
        if (focused != null)
            Automation.RemoveAutomationFocusChangedEventHandler(focused);
        GC.KeepAlive(mouse);
        GC.KeepAlive(keyboard);
        Wire.Write(Wire.Obj("event", "stopped", "actions", actions.ToArray()));
    }
}
}
static AutomationElement SemanticElement(AutomationElement e)
{
    if (e != null && e.Current.ControlType == ControlType.Text)
    {
        var parent = TreeWalker.ControlViewWalker.GetParent(e);
        object pattern;
        if (parent != null && (parent.TryGetCurrentPattern(InvokePattern.Pattern, out pattern) ||
                               parent.TryGetCurrentPattern(TogglePattern.Pattern, out pattern) ||
                               parent.TryGetCurrentPattern(SelectionItemPattern.Pattern, out pattern)))
            return parent;
    }
    return e;
}
static bool RoleIsInput(AutomationElement e)
{
    return e.Current.ControlType == ControlType.Edit || e.Current.ControlType == ControlType.Document;
}
}
}
