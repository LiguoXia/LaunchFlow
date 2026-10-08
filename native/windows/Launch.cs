using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

namespace LaunchFlow.Native
{
    // Separate, unelevated broker. Only the requested application uses the runas verb.
    public static class ApplicationLauncher
    {
        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        struct ShellExecuteInfo
        {
            public int size;
            public uint mask;
            public IntPtr window;
            public string verb, file, parameters, directory;
            public int show;
            public IntPtr instance, idList;
            public string className;
            public IntPtr classKey;
            public uint hotKey;
            public IntPtr icon, process;
        }
        [DllImport("shell32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        static extern bool ShellExecuteExW(ref ShellExecuteInfo info);
        [DllImport("kernel32.dll")]
        static extern bool CloseHandle(IntPtr handle);

        // Windows argv quoting, including empty values, embedded quotes and trailing backslashes.
        // There is no cmd.exe / PowerShell interpolation here.
        public static string Quote(string value)
        {
            var result = new StringBuilder("\"");
            int slashes = 0;
            foreach (char c in value)
            {
                if (c == '\\') { slashes++; continue; }
                result.Append('\\', c == '"' ? slashes * 2 + 1 : slashes);
                result.Append(c);
                slashes = 0;
            }
            return result.Append('\\', slashes * 2).Append('"').ToString();
        }
        public static object Launch(Dictionary<string, object> request)
        {
            ApplicationTrace.Step("application.validate");
            string file = Wire.Str(request, "executable");
            var arguments = Wire.List(Wire.Get(request, "arguments")).Select(v => v as string).ToArray();
            if (!Path.IsPathRooted(file) || file.IndexOf('\0') >= 0 || !File.Exists(file) ||
                !String.Equals(Path.GetExtension(file), ".exe", StringComparison.OrdinalIgnoreCase) ||
                arguments.Any(a => a == null || a.IndexOf('\0') >= 0))
                throw new NativeFailure("invalidApplication", "请选择本机有效的 .exe 应用，并检查启动参数。");
            string parameters = String.Join(" ", arguments.Select(Quote));
            if (file.Length + parameters.Length + 4 > 32767)
                throw new NativeFailure("invalidApplication", "启动参数超过 Windows 命令行长度限制。");
            var info = new ShellExecuteInfo {
                size = Marshal.SizeOf(typeof(ShellExecuteInfo)),
                // Wait for dispatch, retain a process handle, suppress generic error UI.
                // Security prompts remain enabled: no NOZONECHECKS or authorization bypass.
                mask = 0x00000100 | 0x00000040 | 0x00000400,
                verb = Wire.Get(request, "elevate") is bool && (bool)request["elevate"] ? "runas" : "open",
                file = file, parameters = parameters, directory = Path.GetDirectoryName(file), show = 1
            };
            try
            {
                ApplicationTrace.Step("application.shell");
                if (!ShellExecuteExW(ref info))
                {
                    int code = Marshal.GetLastWin32Error();
                    ApplicationTrace.Win32Error = code;
                    if (code == 1223)
                        throw new NativeFailure("uacCancelled", "已取消 Windows 管理员授权，应用未启动。需要启动时请手动重试并在系统授权框选择“是”。");
                    if (code == 5 || code == 740)
                        throw new NativeFailure("elevationDenied", "Windows 未允许启动此应用。请检查账户管理员权限或系统策略；不会自动重试授权。");
                    throw new NativeFailure("launchFailed", "Windows 启动应用失败（错误码 " + code + "）。请检查应用路径与访问权限。");
                }
                return Wire.Obj("launched", true);
            }
            finally { if (info.process != IntPtr.Zero) CloseHandle(info.process); }
        }
        public static void Run(Dictionary<string, object> request)
        {
            ApplicationTrace.Step("request.received");
            // Parent keeps stdin open while awaiting consent. EOF also covers a parent crash.
            new Thread(() => { Console.ReadLine(); Environment.Exit(2); }) { IsBackground = true }.Start();
            Exception failure = null;
            object result = null;
            var thread = new Thread(() => {
                try {
                    switch (Wire.Str(request, "op")) {
                        case "applicationAuthorizationStatus": result = TaskAuthorization.Status(request); break;
                        case "applicationAuthorizationGrant": result = TaskAuthorization.Authorize(request); break;
                        case "applicationAuthorizationRevoke": result = TaskAuthorization.Revoke(request); break;
                        case "applicationAuthorizationRun": result = TaskAuthorization.Run(request); break;
                        case "launchApplication": result = Launch(request); break;
                        default: throw new NativeFailure("invalidOperation", "Unsupported application operation.");
                    }
                } catch (Exception e) { failure = e; ApplicationTrace.Error(e); }
            });
            thread.SetApartmentState(ApartmentState.STA);
            thread.Start();
            thread.Join();
            if (failure != null) {
                var known = failure as NativeFailure;
                string message = ApplicationTrace.Label + "：" + (known != null ? known.Message :
                    failure.GetType().Name + "（0x" + failure.HResult.ToString("X8") + "）。请复制诊断日志查看详情。");
                Wire.Write(Wire.Obj("ok", false, "error", Wire.Obj("code", known == null ? "applicationLaunch" : known.Code,
                    "message", message, "platform", "windows"), "diagnostics", ApplicationTrace.Snapshot()));
                return;
            }
            Wire.Write(Wire.Obj("ok", true, "result", result, "diagnostics", ApplicationTrace.Snapshot()));
        }
    }
}
