using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.IO.Pipes;
using System.Reflection;
using System.Security.AccessControl;
using System.Security.Principal;
public class AuthorizationTests
{
    static Type type;
    static int count;
    static object Call(string method, params object[] args) {
        return type.GetMethod(method, BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static).Invoke(null, args);
    }
    static void Reject(string method, params object[] args) {
        try { Call(method, args); throw new Exception("Expected rejection: " + method); }
        catch (TargetInvocationException e) { if (e.InnerException.GetType().Name != "NativeFailure") throw; count++; }
    }
    public static int Main(string[] args) {
        type = Assembly.LoadFrom(args[0]).GetType("LaunchFlow.Native.TaskAuthorization");
        if (args[1] == "--report") {
            Call("ReportRegistration", new Dictionary<string,object>{{"diagnosticPipe", args[2]}},
                "创建受保护的授权目录", 12, new UnauthorizedAccessException("Access denied fixture"));
            return 12;
        }
        string sid = WindowsIdentity.GetCurrent().User.Value;
        foreach (string account in new[] { sid, WindowsIdentity.GetCurrent().Name }) {
            if (!(bool)Call("IsCurrentUser", account)) throw new Exception("Rejected current account: " + account);
            count++;
        }
        foreach (string account in new[] { "", "S-1-invalid", "S-1-5-18", "LaunchFlowMissingUser-" + Guid.NewGuid().ToString("N") }) {
            if ((bool)Call("IsCurrentUser", account)) throw new Exception("Accepted unrelated account: " + account);
            count++;
        }
        dynamic scheduler = Activator.CreateInstance(Type.GetTypeFromProgID("Schedule.Service"));
        scheduler.Connect();
        dynamic definition = scheduler.NewTask(0);
        definition.Principal.UserId = sid;
        string normalized = (string)definition.Principal.UserId;
        if (!(bool)Call("IsCurrentUser", normalized)) throw new Exception("Rejected real Task Scheduler principal: " + normalized);
        Console.WriteLine("Task Scheduler account normalization: " + sid + " -> " + normalized); count++;
        Reject("CheckRunnerVersion", new Dictionary<string,object>{{"version", 1}});
        Call("CheckRunnerVersion", new Dictionary<string,object>{{"version", 1}, {"runnerVersion", 2}}); count++;
        Call("CheckTaskAcl", "O:BAG:BAD:P(A;;GA;;;SY)(A;;GA;;;BA)(A;;GRGXSD;;;" + sid + ")"); count++;
        Reject("CheckTaskAcl", "O:" + sid + "G:BAD:P(A;;GA;;;SY)(A;;GA;;;BA)");
        Reject("CheckTaskAcl", "O:BAG:BAD:P(A;;GA;;;SY)(A;;GA;;;BA)(A;;GW;;;" + sid + ")");
        Reject("CheckTaskAcl", "O:BAG:BAD:P(A;;GA;;;WD)");
        Reject("CheckTaskAcl", "O:BAG:BAD:P(A;;WDWO;;;" + sid + ")");
        Reject("Executable", "relative.exe"); Reject("Executable", @"\\server\share\app.exe");
        Reject("Executable", args[1]);
        Reject("Key", "");
        Reject("Arguments", new Dictionary<string,object>{{"arguments", new object[]{"nul\0arg"}}});
        if ((int)Call("RunElevated", "../../invalid", "not-a-nonce") != 11) throw new Exception("Unsafe key accepted"); count++;
        // Explicitly unsafe even when CI itself happens to run elevated.
        string unsafeDirectory = Path.Combine(args[2], "untrusted-acl-fixture");
        Directory.CreateDirectory(unsafeDirectory);
        var acl = Directory.GetAccessControl(unsafeDirectory);
        acl.AddAccessRule(new FileSystemAccessRule(new SecurityIdentifier(WellKnownSidType.WorldSid, null), FileSystemRights.Write, AccessControlType.Allow));
        Directory.SetAccessControl(unsafeDirectory, acl);
        Reject("CheckProtected", unsafeDirectory, true);
        Directory.Delete(unsafeDirectory);
        // Match production ordering: the child reports, closes its pipe and exits before the parent reads.
        for (int attempt = 0; attempt < 2; attempt++) {
            string pipeName = "LaunchFlow-Authorization-" + Guid.NewGuid().ToString("N");
            using (var pipe = new NamedPipeServerStream(pipeName, PipeDirection.In, 1, PipeTransmissionMode.Byte, PipeOptions.Asynchronous, 4096, 4096)) {
                var connection = pipe.BeginWaitForConnection(null, null);
                using (var child = Process.Start(new ProcessStartInfo(Assembly.GetExecutingAssembly().Location,
                    "\"" + args[0] + "\" --report " + pipeName) { UseShellExecute = false, CreateNoWindow = true })) {
                    if (!child.WaitForExit(5000)) throw new Exception("Diagnostic child did not exit");
                    var detail = (Dictionary<string,object>)Call("ReadRegistrationDetail", pipe, connection, child.Id + attempt);
                    string message = (string)Call("RegistrationFailure", detail, child.ExitCode);
                    if (attempt == 0 && (!message.Contains("创建受保护的授权目录") || !message.Contains("0x80070005") || !message.Contains("Access denied fixture")))
                        throw new Exception("Lost child failure details: " + message);
                    if (attempt == 1 && detail.Count != 0) throw new Exception("Accepted diagnostics from wrong process");
                    count++;
                }
            }
        }
        Console.WriteLine("PASS " + count + " native authorization validation and ACL checks");
        return 0;
    }
}
