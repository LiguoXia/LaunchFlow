using System;
using System.Linq;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Imaging;
using System.Windows.Automation;
using System.Runtime.InteropServices;

namespace LaunchFlow.Native
{
    public class NativeFailure : Exception
    {
        public string Code;
        public object Details;
        public NativeFailure(string code, string message) : this(code, message, null) { }
        public NativeFailure(string code, string message, object details) : base(message)
        {
            Code = code;
            Details = details;
        }
    }
    public static class Desktop
    {
        public static IEnumerable<IntPtr> Windows()
        {
            var result = new List<IntPtr>();
            Win.EnumWindows(delegate(IntPtr h, IntPtr _) {
                if (Win.IsWindowVisible(h) && Win.Title(h) != "" && !Win.Class(h).StartsWith("LaunchFlowOverlay"))
                    result.Add(h);
                return true;
            }, IntPtr.Zero);
            return result;
        }
        public static Dictionary<string, object> WindowInfo(IntPtr h)
        {
            uint pid;
            Win.GetWindowThreadProcessId(h, out pid);
            string app = "";
            try
            {
                app = Process.GetProcessById((int)pid).ProcessName + ".exe";
            }
            catch
            {
            }
            return Wire.Obj("handle", h.ToInt64().ToString(), "pid", pid, "application", app, "title", Win.Title(h),
                            "className", Win.Class(h), "bounds", Win.Bounds(h), "state",
                            Win.IsIconic(h)   ? "minimized"
                            : Win.IsZoomed(h) ? "maximized"
                                              : "normal",
                            "focused", Win.GetForegroundWindow() == h);
        }
        public static bool WindowMatches(IntPtr h, Dictionary<string, object> scope)
        {
            var info = WindowInfo(h);
            foreach (var key in new[] { "application", "title", "className", "handle" })
            {
                var wanted = Wire.Str(scope, key);
                if (wanted != "" && !String.Equals(Wire.Str(info, key), wanted, StringComparison.OrdinalIgnoreCase))
                    return false;
            }
            return Wire.Num(scope, "pid") == 0 || Wire.Num(scope, "pid") == Wire.Num(info, "pid");
        }
        public static IntPtr FindWindow(Dictionary<string, object> scope)
        {
            if (scope.Count == 0)
                throw new NativeFailure("invalidLocator", "A target application/window is required.");
            var found = Windows().Where(h => WindowMatches(h, scope)).ToList();
            if (found.Count == 0)
                throw new NativeFailure("notFound", "Target window is unavailable.");
            if (found.Count > 1)
                throw new NativeFailure("ambiguous",
                                        "Window selector matched more than one window; add title or class.");
            return found[0];
        }
        public static IntPtr ElementWindow(AutomationElement e)
        {
            var walker = TreeWalker.ControlViewWalker;
            var current = e;
            for (int i = 0; i < 32 && current != null; i++)
            {
                int h = current.Current.NativeWindowHandle;
                if (h != 0 && Windows().Contains(new IntPtr(h)))
                    return new IntPtr(h);
                current = walker.GetParent(current);
            }
            return IntPtr.Zero;
        }
        public static string Role(AutomationElement e)
        {
            return e.Current.ControlType.ProgrammaticName.Replace("ControlType.", "");
        }
        public static Dictionary<string, object> Attributes(AutomationElement e)
        {
            var c = e.Current;
            bool secure = c.IsPassword;
            return Wire.Obj("role", Role(e), "name", secure ? "" : c.Name, "automationId", c.AutomationId, "className",
                            c.ClassName, "frameworkId", c.FrameworkId, "secure", secure);
        }
        public static Dictionary<string, object> Info(AutomationElement e, IntPtr window, bool ancestors = true)
        {
            var d = Attributes(e);
            var b = e.Current.BoundingRectangle;
            d["bounds"] =
                Win.Rect(b.IsEmpty ? 0 : b.X, b.IsEmpty ? 0 : b.Y, b.IsEmpty ? 0 : b.Width, b.IsEmpty ? 0 : b.Height);
            d["enabled"] = e.Current.IsEnabled;
            d["offscreen"] = e.Current.IsOffscreen;
            d["window"] = WindowInfo(window);
            d["runtimeId"] = e.GetRuntimeId();
            var path = new List<object>();
            if (ancestors)
            {
                var p = TreeWalker.ControlViewWalker.GetParent(e);
                for (int i = 0; i < 12 && p != null; i++)
                {
                    if (p.Equals(AutomationElement.RootElement))
                        break;
                    path.Insert(0, Attributes(p));
                    p = TreeWalker.ControlViewWalker.GetParent(p);
                }
            }
            d["ancestorPath"] = path;
            return d;
        }
        public static IEnumerable<AutomationElement> Elements(AutomationElement root)
        {
            var queue = new Queue<Tuple<AutomationElement, int>>();
            queue.Enqueue(Tuple.Create(root, 0));
            int count = 0;
            var walker = TreeWalker.ControlViewWalker;
            while (queue.Count > 0 && count++ < 2048)
            {
                var item = queue.Dequeue();
                yield return item.Item1;
                if (item.Item2 >= 24)
                    continue;
                AutomationElement child = null;
                try
                {
                    child = walker.GetFirstChild(item.Item1);
                }
                catch
                {
                }
                while (child != null && queue.Count < 2048)
                {
                    queue.Enqueue(Tuple.Create(child, item.Item2 + 1));
                    try
                    {
                        child = walker.GetNextSibling(child);
                    }
                    catch
                    {
                        break;
                    }
                }
            }
        }
        public static bool Match(AutomationElement e, Dictionary<string, object> attrs)
        {
            var actual = Attributes(e);
            foreach (var key in new[] { "role", "name", "automationId", "className", "frameworkId" })
            {
                var wanted = Wire.Str(attrs, key);
                if (wanted != "" && !String.Equals(wanted, Wire.Str(actual, key), StringComparison.OrdinalIgnoreCase))
                    return false;
            }
            return true;
        }
        public static bool MatchAncestors(AutomationElement e, object raw)
        {
            var path = Wire.List(raw).Select(Wire.Map).ToList();
            if (path.Count == 0)
                return true;
            var current = TreeWalker.ControlViewWalker.GetParent(e);
            for (int i = path.Count - 1; i >= 0; i--)
            {
                while (current != null && !Match(current, path[i]))
                    current = TreeWalker.ControlViewWalker.GetParent(current);
                if (current == null)
                    return false;
                current = TreeWalker.ControlViewWalker.GetParent(current);
            }
            return true;
        }
        public static AutomationElement FindElement(IntPtr window, Dictionary<string, object> locator)
        {
            var root = AutomationElement.FromHandle(window);
            var runtime = Wire.List(Wire.Get(locator, "runtimeId")).Select(Convert.ToInt32).ToArray();
            string kind = Wire.Str(locator, "kind", "accessibility"), text = Wire.Str(locator, "text");
            var results = new List<AutomationElement>();
            foreach (var e in Elements(root))
            {
                try
                {
                    if (runtime.Length > 0)
                    {
                        if (!e.Current.IsOffscreen && e.GetRuntimeId().SequenceEqual(runtime) && Match(e, locator) &&
                            (kind != "text" || String.Equals(e.Current.IsPassword ? "" : e.Current.Name, text,
                                                           StringComparison.OrdinalIgnoreCase)) &&
                            MatchAncestors(e, Wire.Get(locator, "ancestorPath")))
                            return e;
                        continue;
                    }
                    if (e.Current.IsOffscreen)
                        continue;
                    bool matches = kind == "text"
                                       ? String.Equals(e.Current.IsPassword ? "" : e.Current.Name, text,
                                                       StringComparison.OrdinalIgnoreCase)
                                       : Match(e, locator) && MatchAncestors(e, Wire.Get(locator, "ancestorPath"));
                    if (matches)
                        results.Add(e);
                }
                catch (ElementNotAvailableException)
                {
                }
            }
            if (results.Count == 0)
                throw new NativeFailure("notFound", "No accessible element matched the locator.");
            if (results.Count > 1)
                throw new NativeFailure(
                    "ambiguous", "Locator matched multiple elements; add stable attributes or an ancestor path.");
            return results[0];
        }
        public static void Activate(IntPtr h)
        {
            WindowFocus.Activate(h);
        }
        static object Pattern(AutomationElement e, AutomationPattern p)
        {
            object value;
            return e != null && e.TryGetCurrentPattern(p, out value) ? value : null;
        }
        public static void Perform(IntPtr window, AutomationElement e, Dictionary<string, object> action,
                                   Dictionary<string, object> point)
        {
            string kind = Wire.Str(action, "kind");
            if (kind == "activateWindow")
            {
                Activate(window);
                return;
            }
            if (kind == "moveWindow" || kind == "resizeWindow")
            {
                Win.RECT r;
                Win.GetWindowRect(window, out r);
                int x = kind == "moveWindow" ? (int)Wire.Num(action, "x") : r.Left,
                    y = kind == "moveWindow" ? (int)Wire.Num(action, "y") : r.Top,
                    w = kind == "resizeWindow" ? (int)Wire.Num(action, "width") : r.Right - r.Left,
                    h = kind == "resizeWindow" ? (int)Wire.Num(action, "height") : r.Bottom - r.Top;
                if (w < 100 || h < 80 || w > 16000 || h > 16000)
                    throw new NativeFailure("invalidAction", "Invalid window dimensions.");
                if (!Win.SetWindowPos(window, IntPtr.Zero, x, y, w, h, 0x14))
                    throw new NativeFailure("windowOperationFailed", "Window move/resize failed.");
                return;
            }
            if (kind == "maximize" || kind == "minimize")
            {
                Win.ShowWindow(window, kind == "maximize" ? 3 : 6);
                return;
            }
            if (kind == "focus")
            {
                if (e == null)
                    throw new NativeFailure("unsupported", "Focus requires an accessible element.");
                e.SetFocus();
                return;
            }
            if (kind == "selectOption")
            {
                if (e == null)
                    throw new NativeFailure("unsupported", "Selection requires accessibility.");
                var expand = Pattern(e, ExpandCollapsePattern.Pattern) as ExpandCollapsePattern;
                if (expand != null)
                    expand.Expand();
                var option = Wire.Str(action, "option");
                var choices =
                    Elements(e)
                        .Where(x => x.Current.Name == option && Pattern(x, SelectionItemPattern.Pattern) != null)
                        .ToList();
                if (choices.Count != 1)
                    throw new NativeFailure("notFound", "Select option was not found uniquely.");
                var select = Pattern(choices[0], SelectionItemPattern.Pattern) as SelectionItemPattern;
                if (select == null)
                    throw new NativeFailure("unsupported", "Control does not expose SelectionItemPattern.");
                select.Select();
                if (expand != null)
                    expand.Collapse();
                return;
            }
            if (kind == "selectMenu")
            {
                var scope = AutomationElement.FromHandle(window);
                foreach (var item in Wire.List(Wire.Get(action, "menuPath")))
                {
                    var label = Convert.ToString(item);
                    var candidate =
                        Elements(scope).FirstOrDefault(x => Role(x) == "MenuItem" && x.Current.Name == label);
                    if (candidate == null)
                        throw new NativeFailure("notFound", "Menu item unavailable: " + label);
                    var expand = Pattern(candidate, ExpandCollapsePattern.Pattern) as ExpandCollapsePattern;
                    var invoke = Pattern(candidate, InvokePattern.Pattern) as InvokePattern;
                    if (expand != null && expand.Current.ExpandCollapseState != ExpandCollapseState.LeafNode)
                        expand.Expand();
                    else if (invoke != null)
                        invoke.Invoke();
                    else
                        throw new NativeFailure("unsupported", "Menu action is not exposed.");
                    scope = candidate;
                }
                return;
            }
            if (kind == "inputText" || kind == "inputSecret")
            {
                if (e == null)
                    throw new NativeFailure("unsupported", "Text input requires an accessible target.");
                bool secure = e.Current.IsPassword;
                if (kind == "inputSecret" && !secure)
                    throw new NativeFailure("secureTargetRequired", "Input Secret requires a secure accessible field.");
                if (secure && kind != "inputSecret")
                    throw new NativeFailure("secureInputRequired", "Secure fields require an Input Secret action.");
                string value = Wire.Str(action, "text");
                if (value.Length > 32768)
                    throw new NativeFailure("invalidAction", "Input text is too long.");
                var pattern = Pattern(e, ValuePattern.Pattern) as ValuePattern;
                if (pattern != null && !pattern.Current.IsReadOnly)
                {
                    pattern.SetValue(value);
                    return;
                }
                Activate(window);
                e.SetFocus();
                var keys = new List<Win.INPUT>();
                keys.Add(Win.Key(17, false));
                keys.Add(Win.Key(65, false));
                keys.Add(Win.Key(65, true));
                keys.Add(Win.Key(17, true));
                foreach (char c in value)
                {
                    keys.Add(Win.Key(c, false, true));
                    keys.Add(Win.Key(c, true, true));
                }
                WindowFocus.BeforeInput(window);
                Win.Send(keys);
                return;
            }
            if (kind == "click" || kind == "invoke")
            {
                if (e != null)
                {
                    var invoke = Pattern(e, InvokePattern.Pattern) as InvokePattern;
                    if (invoke != null)
                    {
                        invoke.Invoke();
                        return;
                    }
                    var toggle = Pattern(e, TogglePattern.Pattern) as TogglePattern;
                    if (toggle != null)
                    {
                        toggle.Toggle();
                        return;
                    }
                    var selection = Pattern(e, SelectionItemPattern.Pattern) as SelectionItemPattern;
                    if (selection != null)
                    {
                        selection.Select();
                        return;
                    }
                    if (kind == "invoke")
                        throw new NativeFailure("unsupported", "InvokePattern is unavailable.");
                }
            }
            Activate(window);
            if (e != null)
            {
                try
                {
                    e.SetFocus();
                }
                catch
                {
                }
            }
            if (kind == "pressKey" || kind == "shortcut")
            {
                var names = kind == "pressKey" ? new[] { Wire.Str(action, "key") }
                                               : Wire.List(Wire.Get(action, "keys")).Select(Convert.ToString).ToArray();
                var codes = names.Select(KeyCode).ToArray();
                var keys = new List<Win.INPUT>();
                foreach (var code in codes)
                    keys.Add(Win.Key(code, false));
                foreach (var code in codes.Reverse())
                    keys.Add(Win.Key(code, true));
                WindowFocus.BeforeInput(window);
                Win.Send(keys);
                return;
            }
            double px = Wire.Num(point, "x"), py = Wire.Num(point, "y");
            if (e != null)
            {
                var b = e.Current.BoundingRectangle;
                if (b.IsEmpty)
                    throw new NativeFailure("notVisible", "Element has no bounds.");
                px = b.X + b.Width / 2;
                py = b.Y + b.Height / 2;
            }
            var input = new List<Win.INPUT>();
            if (kind == "scroll")
            {
                var scroll = Pattern(e, ScrollPattern.Pattern) as ScrollPattern;
                double delta = Wire.Num(action, "delta", -3);
                if (scroll != null && scroll.Current.VerticallyScrollable)
                {
                    for (int i = 0; i < Math.Min(100, Math.Ceiling(Math.Abs(delta))); i++)
                        scroll.Scroll(ScrollAmount.NoAmount,
                                      delta > 0 ? ScrollAmount.SmallIncrement : ScrollAmount.SmallDecrement);
                    return;
                }
                input.Add(Win.Mouse(px, py, 0x0800, unchecked((uint)(-(int)delta * 120))));
            }
            else if (kind == "drag")
            {
                double endX = Wire.Num(action, "endX"), endY = Wire.Num(action, "endY");
                input.Add(Win.Mouse(px, py, 2));
                for (int i = 1; i <= 12; i++)
                    input.Add(Win.Mouse(px + (endX - px) * i / 12, py + (endY - py) * i / 12, 0));
                input.Add(Win.Mouse(endX, endY, 4));
            }
            else if (kind == "movePointer")
            {
                input.Add(Win.Mouse(px, py, 0));
            }
            else if (kind == "click" || kind == "doubleClick" || kind == "rightClick")
            {
                int count = kind == "doubleClick" ? 2 : 1;
                for (int i = 0; i < count; i++)
                {
                    input.Add(Win.Mouse(px, py, kind == "rightClick" ? 8u : 2u));
                    input.Add(Win.Mouse(px, py, kind == "rightClick" ? 16u : 4u));
                }
            }
            else
                throw new NativeFailure("unsupported", "Unknown GUI action.");
            WindowFocus.BeforeInput(window);
            Win.Send(input);
        }
        public static ushort KeyCode(string name)
        {
            var names = new Dictionary<string, ushort>(StringComparer.OrdinalIgnoreCase) {
                { "Ctrl", 17 },    { "Control", 17 },  { "Shift", 16 },  { "Alt", 18 },    { "Meta", 91 },
                { "Win", 91 },     { "Enter", 13 },    { "Tab", 9 },     { "Escape", 27 }, { "Esc", 27 },
                { "Space", 32 },   { "Backspace", 8 }, { "Delete", 46 }, { "Up", 38 },     { "Down", 40 },
                { "Left", 37 },    { "Right", 39 },    { "Home", 36 },   { "End", 35 },    { "PageUp", 33 },
                { "PageDown", 34 }
            };
            ushort code;
            if (names.TryGetValue(name, out code))
                return code;
            if (name.Length == 1 && char.IsLetterOrDigit(name[0]))
                return char.ToUpperInvariant(name[0]);
            int f;
            if (name.StartsWith("F", StringComparison.OrdinalIgnoreCase) && int.TryParse(name.Substring(1), out f) &&
                f >= 1 && f <= 24)
                return (ushort)(111 + f);
            throw new NativeFailure("invalidAction", "Unsupported key name.");
        }
        public static Dictionary<string, object> Capture(IntPtr window, string path, Dictionary<string, object> region)
        {
            Win.RECT r;
            Win.GetWindowRect(window, out r);
            int width = r.Right - r.Left, height = r.Bottom - r.Top;
            if (width < 1 || height < 1 || width * 1L * height > 16000000)
                throw new NativeFailure("invalidRegion", "Capture requires a visible bounded window.");
            using (var bitmap = new Bitmap(width, height, PixelFormat.Format32bppArgb))
            {
                using (var g = Graphics.FromImage(bitmap))
                {
                    IntPtr dc = g.GetHdc();
                    bool ok = Win.PrintWindow(window, dc, 2);
                    g.ReleaseHdc(dc);
                    if (!ok)
                        throw new NativeFailure("captureFailed", "Window capture failed.");
                    foreach (var e in Elements(AutomationElement.FromHandle(window)))
                    {
                        try
                        {
                            if (!e.Current.IsPassword)
                                continue;
                            var b = e.Current.BoundingRectangle;
                            g.FillRectangle(Brushes.Black, (float)b.X - r.Left, (float)b.Y - r.Top, (float)b.Width,
                                            (float)b.Height);
                        }
                        catch (ElementNotAvailableException)
                        {
                        }
                    }
                }
                int x = (int)Wire.Num(region, "x"), y = (int)Wire.Num(region, "y"),
                    w = (int)Wire.Num(region, "width", width), h = (int)Wire.Num(region, "height", height);
                if (x < 0 || y < 0 || w < 1 || h < 1 || x + w > width || y + h > height)
                    throw new NativeFailure("invalidRegion", "Region must be inside the target window.");
                using (var crop = bitmap.Clone(new Rectangle(x, y, w, h), PixelFormat.Format32bppArgb))
                {
                    crop.Save(path, ImageFormat.Png);
                }
                return Wire.Obj("path", path, "bounds", Win.Rect(r.Left + x, r.Top + y, w, h), "secureRegionsMasked",
                                true);
            }
        }
        public static object Dispatch(Dictionary<string, object> request)
        {
            string op = Wire.Str(request, "op");
            if (op == "desktopStartup") return DesktopStartup.Task(request);
            if (op == "desktopStartupConditions") return DesktopStartup.Conditions();
            if (op == "openSigninSettings") return DesktopStartup.OpenSettings();
            if (op == "applicationIcons") return ApplicationIcons.ReadBatch(request);
            if (op == "vault") return Vault.Dispatch(request);
            if (op == "displays") return WorkspaceDesktop.Displays();
            if (op == "workspaceCloseCapture") return WorkspaceClose.Capture(request);
            if (op == "workspaceClose") return WorkspaceClose.Execute(request);
            if (op == "workspaceCapture") return WorkspaceDesktop.Capture();
            if (op == "workspaceRestore") return WorkspaceDesktop.Restore(request);
            if (op == "permissions")
                return Wire.Obj("accessibility", "granted", "screenRecording", "granted", "automation", "notRequired",
                                "inputMonitoring", "granted");
            if (op == "windows")
                return Windows().Select(WindowInfo).ToArray();
            if (op == "openSettings")
            {
                Process.Start(new ProcessStartInfo("ms-settings:privacy") { UseShellExecute = true });
                return Wire.Obj("opened", true);
            }
            if (op == "point")
            {
                var p = Wire.Map(Wire.Get(request, "point"));
                var e = AutomationElement.FromPoint(new System.Windows.Point(Wire.Num(p, "x"), Wire.Num(p, "y")));
                var h = ElementWindow(e);
                if (h == IntPtr.Zero)
                    throw new NativeFailure("notFound", "No target window at point.");
                return Info(e, h);
            }
            var scope = Wire.Map(Wire.Get(request, "window"));
            var window = FindWindow(scope);
            var locator = Wire.Map(Wire.Get(request, "locator"));
            if (op == "window")
                return WindowInfo(window);
            if (op == "elements")
                return Elements(AutomationElement.FromHandle(window)).Take(1000).Select(e => Info(e, window)).ToArray();
            if (op == "capture")
                return Capture(window, Wire.Str(request, "path"), Wire.Map(Wire.Get(request, "region")));
            if (op == "ocr")
            {
                var capture = Capture(window, Wire.Str(request, "path"), Wire.Map(Wire.Get(request, "region")));
                return Ocr.Recognize(Wire.Str(request, "path"), Wire.Map(capture["bounds"]));
            }
            var target = locator.Count > 0 ? FindElement(window, locator) : null;
            if (op == "find")
                return Info(target ?? AutomationElement.FromHandle(window), window);
            if (op == "perform")
            {
                WindowFocus.LastDiagnostic = null;
                var before = target == null ? null : Info(target, window);
                Perform(window, target, Wire.Map(Wire.Get(request, "action")), Wire.Map(Wire.Get(request, "point")));
                return Wire.Obj("element", before, "window", WindowInfo(window), "focus", WindowFocus.LastDiagnostic);
            }
            if (op == "highlight")
            {
                var b = target == null ? Win.Bounds(window) : Wire.Map(Info(target, window)["bounds"]);
                if (Wire.Get(request, "bounds") != null)
                    b = Wire.Map(request["bounds"]);
                Sessions.Highlight(b, Math.Min(3000, (int)Wire.Num(request, "durationMs", 1200)));
                return Wire.Obj("highlighted", true, "bounds", b);
            }
            throw new NativeFailure("unsupported", "Unknown native operation.");
        }
    }
    public static class Program
    {
        [MTAThread]
        public static void Main(string[] args)
        {
            if (args.Length == 2 && args[0] == "--authorize-task") { Environment.Exit(TaskAuthorization.RegisterElevated(args[1])); return; }
            Console.InputEncoding = new System.Text.UTF8Encoding(false);
            Console.OutputEncoding = new System.Text.UTF8Encoding(false);
            try
            {
                Win.SetProcessDpiAwarenessContext(new IntPtr(-4));
            }
            catch
            {
            }
            try
            {
                var line = Console.ReadLine();
                if (line == null || line.Length > 2 * 1024 * 1024)
                    throw new NativeFailure("invalidRequest", "Invalid native request.");
                var request = Wire.Map(Wire.Json.DeserializeObject(line));
                if (Wire.Str(request, "op") == "launchApplication" || Wire.Str(request, "op").StartsWith("applicationAuthorization", StringComparison.Ordinal))
                    ApplicationLauncher.Run(request);
                else if (Wire.Str(request, "op") == "pick" || Wire.Str(request, "op") == "record")
                    Sessions.Run(request);
                else
                    Wire.Write(Wire.Obj("ok", true, "result", Desktop.Dispatch(request)));
            }
            catch (UnauthorizedAccessException)
            {
                Wire.Error("permissionDenied", "Windows denied access. Use apps at the same privilege level.",
                           "accessibility");
            }
            catch (NativeFailure e)
            {
                Wire.Error(e.Code, e.Message, null, e.Details);
            }
            catch (ElementNotAvailableException)
            {
                Wire.Error("staleElement", "The target element changed or disappeared.");
            }
            catch (Exception e)
            {
                Wire.Error("nativeFailure", e.GetType().Name + ": native automation failed.");
            }
        }
    }
}
