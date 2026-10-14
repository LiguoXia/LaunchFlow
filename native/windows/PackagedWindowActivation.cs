using System;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;

namespace LaunchFlow.Native
{
    public static class PackagedWindowActivation
    {
        [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
        [DllImport("kernel32.dll", CharSet=CharSet.Unicode)] static extern int GetApplicationUserModelId(IntPtr process, ref uint size, StringBuilder id);
        [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);

        public static bool ValidId(string id)
        {
            if (String.IsNullOrEmpty(id) || id.Length > 512) return false;
            int separator = id.IndexOf('!');
            if (separator <= 0 || separator == id.Length - 1 || separator != id.LastIndexOf('!') ||
                id.Substring(0, separator).IndexOf('_') < 0) return false;
            foreach (char c in id)
                if (!Char.IsLetterOrDigit(c) && c != '.' && c != '_' && c != '-' && c != '!') return false;
            return true;
        }
        public static string ForWindow(IntPtr window)
        {
            uint pid;
            Win.GetWindowThreadProcessId(window, out pid);
            var process = OpenProcess(0x1000, false, pid);
            if (process == IntPtr.Zero) return "";
            try {
                uint size = 513;
                var id = new StringBuilder((int)size);
                if (GetApplicationUserModelId(process, ref size, id) != 0) return "";
                return ValidId(id.ToString()) ? id.ToString() : "";
            } finally { CloseHandle(process); }
        }
        public static void Activate(string id)
        {
            if (!ValidId(id)) throw new NativeFailure("invalidApplication", "应用的 Windows 注册标识无效。未发送恢复请求。");
            try {
                // Same registered launch entry as Start / AppsFolder. The application's
                // own activation handler restores BrowserWindow and its renderer state.
                // Never relaunch an arbitrary executable or replay its original arguments.
                using (var process = Process.Start(new ProcessStartInfo {
                    FileName = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Windows), "explorer.exe"),
                    Arguments = "shell:AppsFolder\\" + id,
                    UseShellExecute = false,
                    CreateNoWindow = true,
                    WindowStyle = ProcessWindowStyle.Hidden
                })) { }
            } catch (Exception e) {
                if (!(e is System.ComponentModel.Win32Exception) && !(e is InvalidOperationException)) throw;
                throw new NativeFailure("focusDenied", "Windows 未接受应用恢复请求；请通过系统托盘打开应用后重试。");
            }
        }
    }
}
