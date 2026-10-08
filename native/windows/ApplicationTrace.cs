using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Linq;

namespace LaunchFlow.Native
{
    // Per-request metadata only. Never record paths, command arguments, input or exception messages.
    public static class ApplicationTrace
    {
        static readonly Stopwatch Clock = Stopwatch.StartNew();
        static readonly List<object> Steps = new List<object>();
        static Exception Failure;
        public static int? Win32Error;
        public static Dictionary<string, object> Registration;
        public static string Stage = "request.received";
        public static void Step(string stage) {
            Stage = stage;
            if (Steps.Count < 32) Steps.Add(Wire.Obj("stage", stage, "elapsedMs", Clock.ElapsedMilliseconds));
        }
        public static void Error(Exception error) { Failure = error; }
        public static object Snapshot() {
            var frames = Failure == null ? new string[0] : (new StackTrace(Failure, false).GetFrames() ?? new StackFrame[0])
                .Select(f => f.GetMethod()).Where(m => m != null).Take(12)
                .Select(m => (m.DeclaringType == null ? "" : m.DeclaringType.FullName + ".") + m.Name).ToArray();
            return Wire.Obj("osVersion", Environment.OSVersion.Version.ToString(),
                "runtimeVersion", Environment.Version.ToString(), "steps", Steps,
                "errorCode", Failure == null ? "" : Failure is NativeFailure ? ((NativeFailure)Failure).Code : "unexpected",
                "exceptionType", Failure == null ? "" : Failure.GetType().FullName,
                "hresult", Failure == null ? "" : "0x" + Failure.HResult.ToString("X8"), "frames", frames,
                "win32Error", Win32Error, "registration", Registration == null ? null : Wire.Obj(
                    "phase", Wire.Str(Registration, "phase"), "exceptionType", Wire.Str(Registration, "exception"), "hresult", Wire.Str(Registration, "hresult")));
        }
        public static string Label {
            get {
                switch (Stage) {
                    case "task.lookup": return "查找已授权任务";
                    case "task.validate": return "核对授权配置";
                    case "task.run": return "请求 Windows 启动任务";
                    case "receipt.wait": return "等待启动回执";
                    case "receipt.validate": return "核对启动结果";
                    case "authorization.consent": return "Windows 授权登记";
                    case "authorization.revoke": return "撤销授权";
                    case "application.validate": return "检查应用路径与参数";
                    case "application.shell": return "Windows 应用启动";
                    default: return "处理应用请求";
                }
            }
        }
    }
}
