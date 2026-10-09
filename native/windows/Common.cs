using System;
using System.Collections.Generic;
using System.Collections;
using System.Runtime.InteropServices;
using System.Web.Script.Serialization;

namespace LaunchFlow.Native
{
    public static class Wire
    {
        static readonly object gate = new object();
        public static readonly JavaScriptSerializer Json =
            new JavaScriptSerializer { MaxJsonLength = 2 * 1024 * 1024, RecursionLimit = 64 };
        public static Dictionary<string, object> Obj(params object[] pairs)
        {
            var d = new Dictionary<string, object>();
            for (int i = 0; i < pairs.Length; i += 2)
                d[(string)pairs[i]] = pairs[i + 1];
            return d;
        }
        public static Dictionary<string, object> Map(object v)
        {
            return v as Dictionary<string, object> ?? new Dictionary<string, object>();
        }
        public static object Get(Dictionary<string, object> d, string k)
        {
            object v;
            return d.TryGetValue(k, out v) ? v : null;
        }
        public static string Str(Dictionary<string, object> d, string k, string fallback = "")
        {
            var v = Get(d, k);
            return v == null ? fallback : Convert.ToString(v, System.Globalization.CultureInfo.InvariantCulture);
        }
        public static double Num(Dictionary<string, object> d, string k, double fallback = 0)
        {
            var v = Get(d, k);
            return v == null ? fallback : Convert.ToDouble(v, System.Globalization.CultureInfo.InvariantCulture);
        }
        public static bool Bool(Dictionary<string, object> d, string k)
        {
            return Get(d, k) is bool && (bool)d[k];
        }
        public static IEnumerable<object> List(object v)
        {
            var a = v as IEnumerable;
            if (a != null && !(v is string))
                foreach (var item in a)
                    yield return item;
        }
        public static void Write(object v)
        {
            lock (gate)
            {
                Console.WriteLine(Json.Serialize(v));
                Console.Out.Flush();
            }
        }
        public static void Error(string code, string message, string permission = null, object details = null)
        {
            Write(Obj("ok", false, "error",
                      Obj("code", code, "message", message, "permission", permission, "platform", "windows", "details", details)));
        }
    }
    public static class Win
    {
        public delegate bool EnumProc(IntPtr hwnd, IntPtr data);
        public delegate IntPtr HookProc(int code, IntPtr message, IntPtr data);
        [StructLayout(LayoutKind.Sequential)]
        public struct RECT
        {
            public int Left, Top, Right, Bottom;
        }
        [StructLayout(LayoutKind.Sequential)]
        public struct POINT
        {
            public int X, Y;
        }
        [StructLayout(LayoutKind.Sequential)]
        public struct MouseHook
        {
            public POINT Point;
            public uint Data, Flags, Time;
            public UIntPtr Extra;
        }
        [StructLayout(LayoutKind.Sequential)]
        public struct KeyHook
        {
            public uint Code, Scan, Flags, Time;
            public UIntPtr Extra;
        }
        [StructLayout(LayoutKind.Sequential)]
        public struct INPUT
        {
            public uint Type;
            public InputUnion Data;
        }
        [StructLayout(LayoutKind.Explicit)]
        public struct InputUnion
        {
            [FieldOffset(0)]
            public MOUSEINPUT Mouse;
            [FieldOffset(0)]
            public KEYBDINPUT Key;
        }
        [StructLayout(LayoutKind.Sequential)]
        public struct MOUSEINPUT
        {
            public int X, Y;
            public uint MouseData, Flags, Time;
            public UIntPtr Extra;
        }
        [StructLayout(LayoutKind.Sequential)]
        public struct KEYBDINPUT
        {
            public ushort Vk, Scan;
            public uint Flags, Time;
            public UIntPtr Extra;
        }
        [DllImport("user32.dll")]
        public static extern bool EnumWindows(EnumProc proc, IntPtr data);
        [DllImport("user32.dll")]
        public static extern bool IsWindowVisible(IntPtr window);
        [DllImport("user32.dll")]
        public static extern bool IsWindow(IntPtr window);
        [DllImport("user32.dll")]
        public static extern bool IsIconic(IntPtr window);
        [DllImport("user32.dll")]
        public static extern bool IsZoomed(IntPtr window);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)]
        public static extern int GetWindowText(IntPtr h, System.Text.StringBuilder text, int max);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)]
        public static extern int GetClassName(IntPtr h, System.Text.StringBuilder text, int max);
        [DllImport("user32.dll")]
        public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
        [DllImport("user32.dll")]
        public static extern bool GetWindowRect(IntPtr h, out RECT rect);
        [DllImport("user32.dll")]
        public static extern IntPtr GetForegroundWindow();
        [DllImport("user32.dll")]
        public static extern bool SetForegroundWindow(IntPtr h);
        [DllImport("user32.dll")]
        public static extern bool ShowWindow(IntPtr h, int cmd);
        [DllImport("user32.dll")]
        public static extern bool ShowWindowAsync(IntPtr h, int cmd);
        [DllImport("user32.dll")]
        public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int width, int height, uint flags);
        [DllImport("user32.dll")]
        public static extern bool GetCursorPos(out POINT point);
        [DllImport("user32.dll")]
        public static extern IntPtr WindowFromPoint(POINT point);
        [DllImport("user32.dll")]
        public static extern IntPtr GetAncestor(IntPtr window, uint flags);
        [DllImport("user32.dll")]
        public static extern int GetSystemMetrics(int metric);
        [DllImport("user32.dll", SetLastError = true)]
        public static extern uint SendInput(uint count, INPUT[] inputs, int size);
        [DllImport("user32.dll")]
        public static extern bool PrintWindow(IntPtr h, IntPtr dc, uint flags);
        [DllImport("user32.dll")]
        public static extern bool SetProcessDpiAwarenessContext(IntPtr context);
        [DllImport("user32.dll")]
        public static extern IntPtr SetWindowsHookEx(int kind, HookProc callback, IntPtr module, uint thread);
        [DllImport("user32.dll")]
        public static extern bool UnhookWindowsHookEx(IntPtr hook);
        [DllImport("user32.dll")]
        public static extern IntPtr CallNextHookEx(IntPtr hook, int code, IntPtr msg, IntPtr data);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
        public static extern IntPtr GetModuleHandle(string name);
        [DllImport("user32.dll")]
        public static extern short GetAsyncKeyState(int key);
        public static string Title(IntPtr h)
        {
            var b = new System.Text.StringBuilder(2048);
            GetWindowText(h, b, b.Capacity);
            return b.ToString();
        }
        public static string Class(IntPtr h)
        {
            var b = new System.Text.StringBuilder(256);
            GetClassName(h, b, b.Capacity);
            return b.ToString();
        }
        public static Dictionary<string, object> Rect(double x, double y, double w, double h)
        {
            return Wire.Obj("x", x, "y", y, "width", w, "height", h);
        }
        public static Dictionary<string, object> Bounds(IntPtr h)
        {
            RECT r;
            GetWindowRect(h, out r);
            return Rect(r.Left, r.Top, r.Right - r.Left, r.Bottom - r.Top);
        }
        public static void Send(List<INPUT> inputs)
        {
            if (SendInput((uint)inputs.Count, inputs.ToArray(), Marshal.SizeOf(typeof(INPUT))) != inputs.Count)
                throw new UnauthorizedAccessException(
                    "Input injection was denied. Target must have the same integrity level.");
        }
        public static INPUT Key(ushort code, bool up, bool unicode = false)
        {
            return new INPUT { Type = 1, Data = new InputUnion { Key = new KEYBDINPUT {
                                             Vk = unicode ? (ushort)0 : code, Scan = unicode ? code : (ushort)0,
                                             Flags = (up ? 2u : 0u) | (unicode ? 4u : 0u)
                                         } } };
        }
        public static INPUT Mouse(double x, double y, uint flags, uint data = 0)
        {
            int left = GetSystemMetrics(76), top = GetSystemMetrics(77), w = GetSystemMetrics(78),
                h = GetSystemMetrics(79);
            return new INPUT { Type = 0, Data = new InputUnion {
                                  Mouse = new MOUSEINPUT { X = (int)((x - left) * 65535 / Math.Max(1, w - 1)),
                                                           Y = (int)((y - top) * 65535 / Math.Max(1, h - 1)),
                                                           Flags = flags | 0xC001, MouseData = data }
                              } };
        }
    }
}
