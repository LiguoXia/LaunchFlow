using System;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Security.Principal;
using System.Text;
using System.Collections.Generic;
using Microsoft.Win32;

namespace LaunchFlow.Native
{
    public static class DesktopStartup
    {
        const string Marker = "LaunchFlow desktop prestart v1:";
        static string Sid { get { return WindowsIdentity.GetCurrent().User.Value; } }
        static string Key(string id) {
            if (String.IsNullOrEmpty(id) || id.Length > 160) throw new NativeFailure("invalidRequest", "启动标识无效。");
            using (var hash = SHA256.Create()) return BitConverter.ToString(hash.ComputeHash(Encoding.UTF8.GetBytes(Sid + "\0" + id))).Replace("-", "").Substring(0, 24);
        }
        static string AccountSid(string account) {
            if (account.StartsWith("S-1-", StringComparison.OrdinalIgnoreCase)) return account;
            return ((SecurityIdentifier)new NTAccount(account).Translate(typeof(SecurityIdentifier))).Value;
        }
        static bool Owned(dynamic definition, string key) {
            try { return (string)definition.RegistrationInfo.Description == Marker + key && AccountSid((string)definition.Principal.UserId) == Sid; }
            catch { return false; }
        }
        static bool Matches(dynamic definition, string launcher, string arguments) {
            try {
                return (int)definition.Principal.LogonType == 3 && (int)definition.Principal.RunLevel == 0 &&
                    (int)definition.Actions.Count == 1 && (int)definition.Actions[1].Type == 0 &&
                    String.Equals((string)definition.Actions[1].Path, launcher, StringComparison.OrdinalIgnoreCase) &&
                    (string)definition.Actions[1].Arguments == arguments &&
                    (int)definition.Triggers.Count == 1 && (int)definition.Triggers[1].Type == 9 &&
                    AccountSid((string)definition.Triggers[1].UserId) == Sid && (bool)definition.Triggers[1].Enabled;
            } catch { return false; }
        }
        static dynamic Find(dynamic folder, string name) {
            try { return folder.GetTask(name); }
            catch (Exception ex) { if (ex.HResult == unchecked((int)0x80070002)) return null; throw; }
        }
        public static object Task(Dictionary<string, object> request) {
            string key = Key(Wire.Str(request, "namespace")), name = "LaunchFlow-Prestart-" + key;
            string action = Wire.Str(request, "action", "status"), launcher = Wire.Str(request, "launcher");
            // Test profiles are passed explicitly because Task Scheduler does not inherit the test environment.
            string testData = Wire.Str(request, "testData");
            string arguments = "--startup" + (String.IsNullOrEmpty(testData) ? "" : " --test-data-dir " + ApplicationLauncher.Quote(testData));
            if (action == "loginStatus" || action == "quoteLogin") {
                string registration = Wire.Str(request, "namespace").StartsWith("app.launchflow.test", StringComparison.Ordinal) ? Wire.Str(request, "namespace") : "launchflow";
                string command = "\"" + launcher + "\" " + arguments;
                using (var run = Registry.CurrentUser.OpenSubKey(@"Software\Microsoft\Windows\CurrentVersion\Run", action == "quoteLogin")) {
                    if (action == "quoteLogin") {
                        if (run == null || !File.Exists(launcher)) throw new NativeFailure("startupFailed", "登录启动路径无效，请重新登记。");
                        run.SetValue(registration, command, RegistryValueKind.String);
                    }
                    string current = run == null ? null : run.GetValue(registration) as string;
                    return Wire.Obj("registered", current != null, "matches", String.Equals(current, command, StringComparison.OrdinalIgnoreCase));
                }
            }
            try {
                dynamic service = Activator.CreateInstance(Type.GetTypeFromProgID("Schedule.Service")); service.Connect();
                dynamic folder = service.GetFolder("\\"), task = Find(folder, name);
                bool owned = task == null || Owned(task.Definition, key);
                if (action == "enable") {
                    if (!owned) throw new NativeFailure("startupConflict", "同名计划任务不属于 LaunchFlow，未覆盖。请检查任务计划程序。");
                    if (!Path.IsPathRooted(launcher) || !File.Exists(launcher) || !launcher.EndsWith(".exe", StringComparison.OrdinalIgnoreCase))
                        throw new NativeFailure("invalidRequest", "LaunchFlow 启动路径无效。");
                    dynamic definition = service.NewTask(0);
                    definition.RegistrationInfo.Description = Marker + key;
                    definition.Principal.UserId = Sid;
                    definition.Principal.LogonType = 3; // Existing interactive session, including Windows ARSO.
                    definition.Principal.RunLevel = 0; // Ordinary user; never SYSTEM or a password logon.
                    definition.Settings.Enabled = true;
                    definition.Settings.StartWhenAvailable = true;
                    definition.Settings.DisallowStartIfOnBatteries = false;
                    definition.Settings.StopIfGoingOnBatteries = false;
                    definition.Settings.ExecutionTimeLimit = "PT0S";
                    definition.Settings.MultipleInstances = 2;
                    dynamic trigger = definition.Triggers.Create(9); trigger.UserId = Sid; trigger.Enabled = true;
                    dynamic exec = definition.Actions.Create(0); exec.Path = launcher; exec.Arguments = arguments;
                    exec.WorkingDirectory = Path.GetDirectoryName(launcher);
                    folder.RegisterTaskDefinition(name, definition, 6, Sid, null, 3, null);
                    task = folder.GetTask(name);
                    if (!Matches(task.Definition, launcher, arguments) || !(bool)task.Enabled)
                        throw new NativeFailure("startupFailed", "启动任务登记后校验失败，请重新配置。");
                } else if (action == "disable") {
                    if (!owned) throw new NativeFailure("startupConflict", "同名任务已被其他程序修改，未删除。请检查任务计划程序。");
                    if (task != null) folder.DeleteTask(name, 0);
                    task = null;
                } else if (action != "status") throw new NativeFailure("invalidRequest", "未知启动操作。");
                bool exists = task != null, matches = exists && owned && Matches(task.Definition, launcher, arguments);
                return Wire.Obj("registered", exists, "enabled", exists && (bool)task.Enabled, "matches", matches,
                    "taskName", name, "error", exists && !matches ? "启动任务与当前版本路径不一致，请重新启用解锁前准备。" : "");
            } catch (NativeFailure) { throw; }
            catch (Exception ex) {
                string error = "任务计划程序未完成操作（" + ex.GetType().Name + " / 0x" + ex.HResult.ToString("X8") + "）。请检查账户权限与 Task Scheduler 服务。";
                if (action == "status") return Wire.Obj("registered", false, "enabled", false, "matches", false, "taskName", name, "error", error);
                throw new NativeFailure("startupFailed", error);
            }
        }
        static object Dword(string path, string name) {
            try { using (var root = RegistryKey.OpenBaseKey(RegistryHive.LocalMachine, RegistryView.Registry64))
                using (var key = root.OpenSubKey(path)) { var value = key == null ? null : key.GetValue(name); return value is int ? value : null; }
            } catch { return null; }
        }
        [DllImport("netapi32.dll", CharSet=CharSet.Unicode)] static extern int NetGetJoinInformation(string server, out IntPtr name, out int status);
        [DllImport("netapi32.dll")] static extern int NetApiBufferFree(IntPtr buffer);
        [DllImport("netapi32.dll", CharSet=CharSet.Unicode)] static extern int NetGetAadJoinInformation(string tenant, out IntPtr info);
        [DllImport("netapi32.dll")] static extern void NetFreeAadJoinInformation(IntPtr info);
        public static object Conditions() {
            bool? domain = null, entra = null;
            IntPtr name = IntPtr.Zero, info = IntPtr.Zero;
            try { int status; if (NetGetJoinInformation(null, out name, out status) == 0) domain = status == 3; }
            catch { } finally { if (name != IntPtr.Zero) NetApiBufferFree(name); }
            try { if (NetGetAadJoinInformation(null, out info) == 0) entra = info != IntPtr.Zero && Marshal.ReadInt32(info) == 1; }
            catch { } finally { if (info != IntPtr.Zero) NetFreeAadJoinInformation(info); }
            const string policy = @"SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\System";
            return Wire.Obj("disabledByPolicy", Dword(policy, "DisableAutomaticRestartSignOn"),
                "securityMode", Dword(policy, "AutomaticRestartSignOnConfig"),
                "userOptOut", Dword(@"SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon\UserARSO\" + Sid, "OptOut"),
                "mdmAllow", Dword(@"SOFTWARE\Microsoft\PolicyManager\current\device\WindowsLogon", "AllowAutomaticRestartSignOn"),
                "domainJoined", domain, "entraJoined", entra, "autoLogonConfigured", AutoLogonConfigured(),
                "autoLogonManaged", Wire.Bool(Wire.Map(WindowsAutoLogonStore.Status()), "managed"));
        }
        static object AutoLogonConfigured() {
            // Read the enable flag only. Never read DefaultPassword or LSA secrets.
            try { using (var root = RegistryKey.OpenBaseKey(RegistryHive.LocalMachine, RegistryView.Registry64))
                using (var key = root.OpenSubKey(@"SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon"))
                    return key == null ? (object)null : String.Equals(Convert.ToString(key.GetValue("AutoAdminLogon", "0")), "1", StringComparison.Ordinal); }
            catch { return null; }
        }
    }
}
