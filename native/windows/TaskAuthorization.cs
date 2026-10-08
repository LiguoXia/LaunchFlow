using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.IO.Pipes;
using System.Linq;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Cryptography;
using System.Security.Principal;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;

namespace LaunchFlow.Native
{
    // The persistent task launches a protected copy of this worker with a fixed key.
    // Its only variable is a receipt nonce, never a command, path, or launch argument.
    public static class TaskAuthorization
    {
        const string Marker = "LaunchFlow preauthorized application v1:";
        static readonly SecurityIdentifier Admins = new SecurityIdentifier("S-1-5-32-544");
        static readonly SecurityIdentifier SystemSid = new SecurityIdentifier("S-1-5-18");
        static string Sid { get { return WindowsIdentity.GetCurrent().User.Value; } }
        static string Hash(byte[] bytes) { using (var h = SHA256.Create()) return BitConverter.ToString(h.ComputeHash(bytes)).Replace("-", "").ToLowerInvariant(); }
        static string Key(string id) {
            if (String.IsNullOrWhiteSpace(id) || id.Length > 256) throw Fail("应用 ID 无效。");
            return Hash(Encoding.UTF8.GetBytes(id));
        }
        static string FolderName { get { return "LaunchFlow-" + Hash(Encoding.UTF8.GetBytes(Sid)).Substring(0, 24); } }
        static string Root { get { return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData), FolderName); } }
        static string ConfigPath(string key) { return Path.Combine(Root, key + ".json"); }
        static string ReceiptPath(string key, string nonce) { return Path.Combine(Root, key + "." + nonce + ".receipt"); }
        static NativeFailure Fail(string message) { return new NativeFailure("applicationAuthorization", message); }
        [DllImport("kernel32.dll", SetLastError = true)]
        static extern bool GetNamedPipeClientProcessId(IntPtr pipe, out uint processId);
        static string RegistrationFailure(Dictionary<string, object> detail, int code) {
            return "预授权登记失败：" + Wire.Str(detail, "phase", "登记授权") + "。" +
                Wire.Str(detail, "message", "请检查路径、账户及任务计划服务。") +
                "（" + Wire.Str(detail, "exception", "exit") + " / " + Wire.Str(detail, "hresult", code.ToString()) + "）";
        }
        static Dictionary<string, object> ReadRegistrationDetail(NamedPipeServerStream pipe, IAsyncResult connection, int childId) {
            var detail = new Dictionary<string, object>();
            try {
                if (!connection.AsyncWaitHandle.WaitOne(1000)) return detail;
                pipe.EndWaitForConnection(connection);
                uint sender;
                if (!GetNamedPipeClientProcessId(pipe.SafePipeHandle.DangerousGetHandle(), out sender) || sender != childId) return detail;
                using (var reader = new StreamReader(pipe, Encoding.UTF8)) {
                    var reading = reader.ReadLineAsync();
                    if (reading.Wait(1000) && reading.Result != null && reading.Result.Length < 4096)
                        return Wire.Map(Wire.Json.DeserializeObject(reading.Result));
                }
            } catch (Exception) { /* Preserve the original registration exit code if diagnostics fail. */ }
            return detail;
        }
        static void ReportRegistration(Dictionary<string, object> request, string phase, int code, Exception failure) {
            string name = Wire.Str(request, "diagnosticPipe");
            if (!Regex.IsMatch(name, "\\ALaunchFlow-Authorization-[a-f0-9]{32}\\z")) return;
            try {
                using (var pipe = new NamedPipeClientStream(".", name, PipeDirection.Out)) {
                    pipe.Connect(2000);
                    using (var writer = new StreamWriter(pipe, new UTF8Encoding(false))) {
                        string message = failure == null ? "" : failure.Message;
                        writer.WriteLine(Wire.Json.Serialize(Wire.Obj("phase", phase, "code", code,
                            "exception", failure == null ? "" : failure.GetType().Name,
                            "hresult", failure == null ? "" : "0x" + failure.HResult.ToString("X8"),
                            "message", message.Substring(0, Math.Min(message.Length, 256)))));
                    }
                }
            } catch (Exception) { /* A missing diagnostics client never changes registration. */ }
        }
        static bool NotFound(Exception e) { return e.HResult == unchecked((int)0x80070002) || e.HResult == unchecked((int)0x80070003); }
        static dynamic Service() {
            dynamic service = Activator.CreateInstance(Type.GetTypeFromProgID("Schedule.Service"));
            service.Connect(); return service;
        }
        static dynamic FindTask(dynamic service, string key) {
            try { return service.GetFolder("\\" + FolderName).GetTask("App-" + key); }
            catch (Exception e) { if (NotFound(e)) return null; throw; }
        }
        static string TaskSddl(bool allowDelete) {
            return "O:BAG:BAD:P(A;;GA;;;SY)(A;;GA;;;BA)(A;;GRGX" + (allowDelete ? "SD" : "") + ";;;" + Sid + ")";
        }
        static void NoReparse(string path) {
            for (var part = new DirectoryInfo(Path.GetDirectoryName(path)); part != null; part = part.Parent)
                if (part.Exists && (part.Attributes & FileAttributes.ReparsePoint) != 0) throw Fail("预授权路径不能经过符号链接或目录联接，请选择实际路径。");
            if ((File.Exists(path) || Directory.Exists(path)) && (File.GetAttributes(path) & FileAttributes.ReparsePoint) != 0) throw Fail("预授权不接受符号链接文件或目录。");
        }
        static string Executable(string path) {
            if (String.IsNullOrEmpty(path) || !Regex.IsMatch(path, @"^[A-Za-z]:[\\/]") || path.IndexOf('\0') >= 0 ||
                !String.Equals(Path.GetExtension(path), ".exe", StringComparison.OrdinalIgnoreCase)) throw Fail("预授权需要本机磁盘上的 .exe 完整路径。");
            var result = Path.GetFullPath(path); NoReparse(result);
            if (!File.Exists(result)) throw Fail("应用文件不存在，请重新选择路径。");
            return result;
        }
        static string[] Arguments(Dictionary<string, object> request) {
            var args = Wire.List(Wire.Get(request, "arguments")).Select(a => a as string).ToArray();
            if (args.Any(a => a == null || a.IndexOf('\0') >= 0) || args.Sum(a => a.Length) > 12000 || args.Length > 256)
                throw Fail("预授权启动参数无效或过长。");
            return args;
        }
        static string FileHash(string path) {
            using (var stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read))
            using (var hash = SHA256.Create()) return BitConverter.ToString(hash.ComputeHash(stream)).Replace("-", "").ToLowerInvariant();
        }
        static void CheckProtected(string path, bool directory) {
            NoReparse(path);
            FileSystemSecurity security = directory ? (FileSystemSecurity)Directory.GetAccessControl(path) : File.GetAccessControl(path);
            var owner = (SecurityIdentifier)security.GetOwner(typeof(SecurityIdentifier));
            if (!owner.Equals(Admins) && !owner.Equals(SystemSid)) throw Fail("授权存储目录权限不符合要求，请联系管理员检查。");
            const FileSystemRights writes = FileSystemRights.Write | FileSystemRights.Delete | FileSystemRights.DeleteSubdirectoriesAndFiles | FileSystemRights.ChangePermissions | FileSystemRights.TakeOwnership;
            foreach (FileSystemAccessRule rule in security.GetAccessRules(true, true, typeof(SecurityIdentifier)))
                if (rule.AccessControlType == AccessControlType.Allow && (rule.FileSystemRights & writes) != 0 &&
                    !rule.IdentityReference.Equals(Admins) && !rule.IdentityReference.Equals(SystemSid))
                    throw Fail("授权存储可被普通用户修改，已拒绝使用。");
        }
        static void EnsureRoot() {
            NoReparse(Path.Combine(Root, "placeholder"));
            if (!Directory.Exists(Root)) {
                var security = new DirectorySecurity();
                security.SetAccessRuleProtection(true, false); security.SetOwner(Admins);
                foreach (var id in new[] { Admins, SystemSid, new SecurityIdentifier(Sid) })
                    security.AddAccessRule(new FileSystemAccessRule(id, id.Value == Sid ? FileSystemRights.ReadAndExecute : FileSystemRights.FullControl,
                        InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit, PropagationFlags.None, AccessControlType.Allow));
                Directory.CreateDirectory(Root, security);
            }
            CheckProtected(Root, true);
        }
        static Dictionary<string, object> ReadConfig(string key) {
            CheckProtected(Root, true);
            string path = ConfigPath(key); CheckProtected(path, false);
            if (new FileInfo(path).Length > 65536) throw Fail("授权记录损坏，请撤销后重新授权。");
            var c = Wire.Map(Wire.Json.DeserializeObject(File.ReadAllText(path, Encoding.UTF8)));
            if (Wire.Str(c, "sid") != Sid || Key(Wire.Str(c, "profileId")) != key || Wire.Num(c, "version") != 1)
                throw Fail("授权记录与当前账户或应用不匹配。");
            CheckRunnerVersion(c);
            return c;
        }
        static void CheckRunnerVersion(Dictionary<string, object> config) {
            // Failed 0.4.2 registration may have left a task with the old identity-checking helper.
            if (Wire.Num(config, "runnerVersion") != 2)
                throw Fail("此授权使用旧版启动助手，请重新点击“保存并授权免确认启动”。");
        }
        static string TaskArguments(string key) { return "--run-authorized " + key + " $(Arg0)"; }
        static bool IsCurrentUser(string account) {
            if (String.IsNullOrWhiteSpace(account)) return false;
            try {
                // Task Scheduler normalizes SID input to a local, domain or UPN account name.
                var id = account.StartsWith("S-1-", StringComparison.OrdinalIgnoreCase)
                    ? new SecurityIdentifier(account)
                    : (SecurityIdentifier)new NTAccount(account).Translate(typeof(SecurityIdentifier));
                return id.Value == Sid;
            } catch (IdentityNotMappedException) { return false; }
            catch (ArgumentException) { return false; }
        }
        static void CheckTask(dynamic task, Dictionary<string, object> c, string key) {
            dynamic d = task.Definition;
            string expected = Marker + key + ":" + Hash(Encoding.UTF8.GetBytes(Wire.Json.Serialize(c)));
            if ((string)d.RegistrationInfo.Description != expected || !IsCurrentUser((string)d.Principal.UserId) ||
                (int)d.Principal.RunLevel != 1 || (int)d.Principal.LogonType != 3 || (int)d.Triggers.Count != 0 ||
                (int)d.Actions.Count != 1 || (int)d.Actions[1].Type != 0 ||
                (string)d.Actions[1].Path != Wire.Str(c, "runner") || (string)d.Actions[1].Arguments != TaskArguments(key) ||
                (string)d.Actions[1].WorkingDirectory != Root)
                throw Fail("计划任务已被修改，请撤销后重新授权。");
            CheckTaskAcl((string)task.GetSecurityDescriptor(7));
            if (!(bool)task.Enabled) throw Fail("预授权任务已被禁用，请重新授权。");
            string runner = Wire.Str(c, "runner");
            if (Path.GetDirectoryName(runner) != Root) throw Fail("授权助手路径不匹配。");
            CheckProtected(runner, false);
            if (FileHash(runner) != Wire.Str(c, "runnerHash")) throw Fail("授权助手已变更，请重新授权。");
        }
        static void CheckTaskAcl(string sddl) {
            var sd = new RawSecurityDescriptor(sddl);
            if ((!sd.Owner.Equals(Admins) && !sd.Owner.Equals(SystemSid)) || sd.DiscretionaryAcl == null) throw Fail("计划任务权限不符合要求。");
            // Generic write/full control, write DAC/owner, task file write/add rights.
            const int writes = 0x500C0116;
            foreach (GenericAce raw in sd.DiscretionaryAcl) {
                var ace = raw as CommonAce;
                if (ace != null && ace.AceQualifier == AceQualifier.AccessAllowed && (ace.AccessMask & writes) != 0 &&
                    !ace.SecurityIdentifier.Equals(Admins) && !ace.SecurityIdentifier.Equals(SystemSid)) throw Fail("计划任务可被普通用户修改，已拒绝使用。");
            }
        }
        static void MatchRequest(Dictionary<string, object> c, Dictionary<string, object> request) {
            if (!String.Equals(Executable(Wire.Str(request, "executable")), Wire.Str(c, "executable"), StringComparison.OrdinalIgnoreCase) ||
                !Arguments(c).SequenceEqual(Arguments(request))) throw Fail("应用路径或参数已变更，请重新授权。工作流额外参数须先移入应用的默认启动参数。");
            if (FileHash(Wire.Str(c, "executable")) != Wire.Str(c, "sha256")) throw Fail("应用文件已更新或变更，请重新授权。");
        }
        public static object Status(Dictionary<string, object> request) {
            ApplicationTrace.Step("task.lookup");
            string key = Key(Wire.Str(request, "profileId"));
            try {
                dynamic task = FindTask(Service(), key);
                if (task == null) return Wire.Obj("state", "notAuthorized", "message", "尚未授权");
                ApplicationTrace.Step("task.validate");
                var c = ReadConfig(key); CheckTask(task, c, key); MatchRequest(c, request);
                return Wire.Obj("state", "authorized", "message", "已授权 · 当前账户与本机有效", "taskPath", "\\" + FolderName + "\\App-" + key);
            } catch (NativeFailure e) { ApplicationTrace.Error(e); return Wire.Obj("state", "changed", "message", e.Message); }
            catch (Exception e) { ApplicationTrace.Error(e); return Wire.Obj("state", "unavailable", "message", "无法检查计划任务。请确认 Task Scheduler 服务可用。"); }
        }
        public static object Revoke(Dictionary<string, object> request) {
            ApplicationTrace.Step("authorization.revoke");
            string key = Key(Wire.Str(request, "profileId")); dynamic service = Service();
            dynamic task = FindTask(service, key);
            if (task != null) {
                if (!((string)task.Definition.RegistrationInfo.Description).StartsWith(Marker + key + ":", StringComparison.Ordinal))
                    throw Fail("同名任务不属于此应用，未执行删除。");
                service.GetFolder("\\" + FolderName).DeleteTask("App-" + key, 0);
            }
            return Wire.Obj("state", "notAuthorized", "message", "授权已撤销；已启动的应用会保留。");
        }
        public static object Run(Dictionary<string, object> request) {
            ApplicationTrace.Step("task.lookup");
            string key = Key(Wire.Str(request, "profileId")); dynamic task = FindTask(Service(), key);
            if (task == null) throw Fail("此应用尚未预授权或授权已撤销，请在应用库完成一次授权。");
            ApplicationTrace.Step("task.validate");
            var c = ReadConfig(key); CheckTask(task, c, key); MatchRequest(c, request);
            string nonce = Guid.NewGuid().ToString("N");
            ApplicationTrace.Step("task.run");
            // The COM API accepts a BSTR or SAFEARRAY(BSTR), not SAFEARRAY(VARIANT).
            // One string supplies $(Arg0); object[] throws E_INVALIDARG on real tasks.
            task.Run(nonce);
            ApplicationTrace.Step("receipt.wait");
            string receipt = ReceiptPath(key, nonce);
            for (int i = 0; i < 100; i++) {
                if (File.Exists(receipt)) {
                    ApplicationTrace.Step("receipt.validate");
                    CheckProtected(receipt, false);
                    var result = Wire.Map(Wire.Json.DeserializeObject(File.ReadAllText(receipt, Encoding.UTF8)));
                    if (Wire.Str(result, "nonce") != nonce) throw Fail("启动回执不匹配，请检查运行状态。");
                    if (!Wire.Bool(result, "ok")) throw Fail(Wire.Str(result, "message", "预授权启动失败。"));
                    return Wire.Obj("launched", true);
                }
                Thread.Sleep(100);
            }
            throw Fail("计划任务未及时返回启动结果，请检查应用与任务历史后手动重试。");
        }
        public static object Authorize(Dictionary<string, object> request) {
            ApplicationTrace.Step("application.validate");
            string key = Key(Wire.Str(request, "profileId"));
            string file = Executable(Wire.Str(request, "executable"));
            var args = Arguments(request);
            var self = Process.GetCurrentProcess();
            string pipeName = "LaunchFlow-Authorization-" + Guid.NewGuid().ToString("N");
            var pipeSecurity = new PipeSecurity();
            pipeSecurity.SetAccessRuleProtection(true, false);
            pipeSecurity.AddAccessRule(new PipeAccessRule(new SecurityIdentifier(Sid), PipeAccessRights.FullControl, AccessControlType.Allow));
            using (var diagnosticPipe = new NamedPipeServerStream(pipeName, PipeDirection.In, 1, PipeTransmissionMode.Byte, PipeOptions.Asynchronous, 4096, 4096, pipeSecurity)) {
            var connection = diagnosticPipe.BeginWaitForConnection(null, null);
            var payload = Wire.Obj("version", 1, "profileId", Wire.Str(request, "profileId"), "executable", file,
                "arguments", args, "sha256", FileHash(file), "sid", Sid, "parentPid", self.Id,
                "parentStarted", self.StartTime.ToUniversalTime().Ticks.ToString(), "expires", DateTime.UtcNow.AddMinutes(3).Ticks.ToString(), "diagnosticPipe", pipeName);
            string encoded = Convert.ToBase64String(Encoding.UTF8.GetBytes(Wire.Json.Serialize(payload)));
            if (encoded.Length > 28000) throw Fail("预授权配置过长，请缩短启动参数。");
            try {
                ApplicationTrace.Step("authorization.consent");
                using (var child = Process.Start(new ProcessStartInfo(Assembly.GetExecutingAssembly().Location,
                    "--authorize-task " + encoded) { UseShellExecute = true, Verb = "runas", WindowStyle = ProcessWindowStyle.Hidden })) {
                    if (child == null) throw Fail("Windows 未返回授权助手，请刷新授权状态。");
                    if (!child.WaitForExit(20000)) throw Fail("授权登记尚未结束，请刷新授权状态后再操作。");
                    if (child.ExitCode == 10) throw Fail("预授权需要当前 Windows 账户具有管理员资格，不能使用其他账户代为授权。");
                    if (child.ExitCode != 0) {
                        var detail = ReadRegistrationDetail(diagnosticPipe, connection, child.Id);
                        ApplicationTrace.Registration = detail;
                        throw Fail(RegistrationFailure(detail, child.ExitCode));
                    }
                }
            } catch (System.ComponentModel.Win32Exception e) {
                ApplicationTrace.Win32Error = e.NativeErrorCode;
                if (e.NativeErrorCode == 1223) throw Fail("已取消 Windows 授权，未启用免重复确认启动。");
                throw Fail("Windows 未允许登记授权，请检查账户权限。");
            }
            var status = Wire.Map(Status(request));
            if (Wire.Str(status, "state") != "authorized") throw Fail(Wire.Str(status, "message"));
            return status;
            }
        }
        // Entry point only used after Windows explicitly elevates this process.
        public static int RegisterElevated(string encoded) {
            var c = new Dictionary<string, object>();
            string phase = "读取授权请求"; int code = 12; Exception failure = null;
            try {
                if (encoded.Length > 28000) return code = 11;
                c = Wire.Map(Wire.Json.DeserializeObject(Encoding.UTF8.GetString(Convert.FromBase64String(encoded))));
                phase = "检查管理员账户";
                if (!new WindowsPrincipal(WindowsIdentity.GetCurrent()).IsInRole(WindowsBuiltInRole.Administrator) || Wire.Str(c, "sid") != Sid) return code = 10;
                string key = Key(Wire.Str(c, "profileId"));
                phase = "检查授权请求有效期";
                var parent = Process.GetProcessById((int)Wire.Num(c, "parentPid"));
                if (parent.StartTime.ToUniversalTime().Ticks.ToString() != Wire.Str(c, "parentStarted") ||
                    DateTime.UtcNow.Ticks > Int64.Parse(Wire.Str(c, "expires"))) return code = 11;
                phase = "校验应用文件";
                string file = Executable(Wire.Str(c, "executable")); var args = Arguments(c);
                if (FileHash(file) != Wire.Str(c, "sha256")) return code = 11;
                phase = "创建受保护的授权目录";
                EnsureRoot();
                phase = "安装受保护的启动助手";
                string source = Path.Combine(Path.GetDirectoryName(Assembly.GetExecutingAssembly().Location), "launchflow-authorized.exe");
                string hash = FileHash(source), runner = Path.Combine(Root, "runner-" + hash + ".exe");
                if (!File.Exists(runner)) { File.Copy(source, runner, false); SetFileOwner(runner); }
                CheckProtected(runner, false);
                if (FileHash(runner) != hash) return code = 11;
                var saved = Wire.Obj("version", 1, "runnerVersion", 2, "sid", Sid, "profileId", Wire.Str(c, "profileId"), "executable", file,
                    "arguments", args, "sha256", Wire.Str(c, "sha256"), "runner", runner, "runnerHash", hash);
                phase = "连接任务计划程序";
                dynamic service = Service(), folder;
                phase = "创建任务文件夹";
                try { folder = service.GetFolder("\\" + FolderName); CheckTaskAcl((string)folder.GetSecurityDescriptor(7)); }
                catch (Exception e) {
                    if (!NotFound(e)) throw;
                    folder = service.GetFolder("\\").CreateFolder(FolderName, TaskSddl(false));
                }
                dynamic existing = FindTask(service, key);
                if (existing != null && !((string)existing.Definition.RegistrationInfo.Description).StartsWith(Marker + key + ":", StringComparison.Ordinal)) return code = 11;
                phase = "构建固定启动任务";
                dynamic definition = service.NewTask(0);
                definition.RegistrationInfo.Author = "LaunchFlow";
                definition.RegistrationInfo.Description = Marker + key + ":" + Hash(Encoding.UTF8.GetBytes(Wire.Json.Serialize(saved)));
                definition.Principal.UserId = Sid; definition.Principal.LogonType = 3; definition.Principal.RunLevel = 1;
                definition.Settings.Enabled = true; definition.Settings.AllowDemandStart = true;
                definition.Settings.DisallowStartIfOnBatteries = false; definition.Settings.StopIfGoingOnBatteries = false;
                definition.Settings.ExecutionTimeLimit = "PT1M"; definition.Settings.MultipleInstances = 0;
                dynamic action = definition.Actions.Create(0);
                action.Path = runner; action.Arguments = TaskArguments(key); action.WorkingDirectory = Root;
                if (parent.HasExited || DateTime.UtcNow.Ticks > Int64.Parse(Wire.Str(c, "expires"))) return code = 11;
                phase = "保存授权配置";
                string config = ConfigPath(key);
                if (File.Exists(config)) CheckProtected(config, false);
                AtomicWrite(config, Wire.Json.Serialize(saved));
                phase = "登记计划任务";
                dynamic registered = folder.RegisterTaskDefinition("App-" + key, definition, 6 | 16, Sid, null, 3, TaskSddl(true));
                phase = "核对计划任务";
                CheckTask(registered, saved, key);
                return code = 0;
            } catch (Exception e) { failure = e; return code = 12; }
            finally { if (code != 0) ReportRegistration(c, phase, code, failure); }
        }
        static void AtomicWrite(string path, string text) {
            string temp = Path.Combine(Root, Guid.NewGuid().ToString("N") + ".tmp");
            try {
                using (var stream = new FileStream(temp, FileMode.CreateNew, FileAccess.Write, FileShare.None)) {
                    byte[] bytes = Encoding.UTF8.GetBytes(text); stream.Write(bytes, 0, bytes.Length); stream.Flush(true);
                }
                SetFileOwner(temp);
                if (File.Exists(path)) File.Replace(temp, path, null); else File.Move(temp, path);
            } finally { if (File.Exists(temp)) File.Delete(temp); }
        }
        static void SetFileOwner(string path) {
            var security = new FileSecurity(); security.SetAccessRuleProtection(true, false); security.SetOwner(Admins);
            foreach (var id in new[] { Admins, SystemSid, new SecurityIdentifier(Sid) })
                security.AddAccessRule(new FileSystemAccessRule(id, id.Value == Sid ? FileSystemRights.ReadAndExecute : FileSystemRights.FullControl, AccessControlType.Allow));
            File.SetAccessControl(path, security);
        }
        public static int RunElevated(string key, string nonce) {
            if (!Regex.IsMatch(key, "\\A[a-f0-9]{64}\\z") || !Regex.IsMatch(nonce, "\\A[a-f0-9]{32}\\z")) return 11;
            try {
                if (!new WindowsPrincipal(WindowsIdentity.GetCurrent()).IsInRole(WindowsBuiltInRole.Administrator)) return 10;
                var c = ReadConfig(key); bool ok = false; string message = "";
                try {
                    dynamic task = FindTask(Service(), key);
                    if (task == null) throw Fail("授权已撤销。");
                    CheckTask(task, c, key);
                    string file = Executable(Wire.Str(c, "executable"));
                    // Hold the approved EXE against replacement until CreateProcess completes.
                    using (var stream = new FileStream(file, FileMode.Open, FileAccess.Read, FileShare.Read)) {
                        using (var sha = SHA256.Create())
                            if (BitConverter.ToString(sha.ComputeHash(stream)).Replace("-", "").ToLowerInvariant() != Wire.Str(c, "sha256")) throw Fail("应用文件已更新或变更，请重新授权。");
                        using (var process = Process.Start(new ProcessStartInfo(file, String.Join(" ", Arguments(c).Select(ApplicationLauncher.Quote))) {
                            UseShellExecute = false, WorkingDirectory = Path.GetDirectoryName(file)
                        })) { if (process == null) throw Fail("应用未启动。"); }
                    }
                    ok = true;
                } catch (NativeFailure e) { message = e.Message; }
                catch (Exception) { message = "预授权应用启动失败，请检查文件与系统策略。"; }
                AtomicWrite(ReceiptPath(key, nonce), Wire.Json.Serialize(Wire.Obj("nonce", nonce, "ok", ok, "message", message)));
                foreach (var old in new DirectoryInfo(Root).GetFiles(key + ".*.receipt").OrderByDescending(f => f.LastWriteTimeUtc).Skip(64)) old.Delete();
                return ok ? 0 : 13;
            } catch (Exception) { return 12; }
        }
    }
}
