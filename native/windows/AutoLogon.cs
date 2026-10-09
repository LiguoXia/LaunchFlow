using System;
using System.Collections.Generic;
using System.Linq;
using System.Runtime.InteropServices;
using System.Security.Principal;
using Microsoft.Win32;

namespace LaunchFlow.Native
{
    public sealed class LoginValue
    {
        public object Value;
        public RegistryValueKind Kind;
        public LoginValue(object value, RegistryValueKind kind) { Value = value; Kind = kind; }
        public static LoginValue Text(string value) { return new LoginValue(value, RegistryValueKind.String); }
    }
    public interface IAutoLogonStore
    {
        LoginValue Read(string name);
        void Write(string name, LoginValue value);
        string ReadSecret();
        void WriteSecret(string value);
        string ReadOwner();
        void WriteOwner(string value);
    }
    public sealed class LoginAccount
    {
        public string User, Domain, Sid;
        public LoginAccount(string user, string domain, string sid) { User = user; Domain = domain; Sid = sid; }
        public string Marker { get { return Sid + "\n" + Domain + "\n" + User; } }
    }
    public sealed class AutoLogonRecoveryFailure : InvalidOperationException
    {
        public AutoLogonRecoveryFailure() : base("配置失败且无法完整恢复，已尝试关闭自动登录。请以管理员身份重新打开此窗口检查；未触发重启。") { }
    }
    // The transaction is independent of the Windows store so failure/rollback can be tested
    // without a real password, administrator rights, or changes to Winlogon.
    public static class AutoLogonConfiguration
    {
        static readonly string[] Names = { "AutoAdminLogon", "DefaultUserName", "DefaultDomainName", "DefaultPassword", "AutoLogonCount" };
        public static string Text(LoginValue value) { return value == null ? "" : Convert.ToString(value.Value); }
        public static bool Owned(IAutoLogonStore store, string sid)
        {
            var marker = store.ReadOwner();
            return marker == sid + "\n" + Text(store.Read("DefaultDomainName")) + "\n" + Text(store.Read("DefaultUserName"));
        }
        static void Validate(LoginAccount account, string password)
        {
            if (String.IsNullOrWhiteSpace(account.User) || account.User.Length > 256 || account.Domain.Length > 255 ||
                account.User.IndexOfAny(new[] { '\0', '\r', '\n', '\\' }) >= 0 || account.Domain.IndexOfAny(new[] { '\0', '\r', '\n', '\\' }) >= 0 ||
                String.IsNullOrEmpty(password) || password.Length > 256 || password.IndexOf('\0') >= 0 || String.IsNullOrEmpty(account.Sid))
                throw new InvalidOperationException("请填写账户名、计算机名/域及有效的账户密码；不能填写 Windows Hello PIN。");
        }
        static void Transaction(IAutoLogonStore store, Action action)
        {
            var previous = Names.ToDictionary(name => name, store.Read);
            string secret = store.ReadSecret(), owner = store.ReadOwner();
            try { action(); }
            catch {
                try {
                    store.Write("AutoAdminLogon", LoginValue.Text("0"));
                    store.WriteSecret(secret);
                    foreach (var name in Names.Where(n => n != "AutoAdminLogon")) store.Write(name, previous[name]);
                    store.WriteOwner(owner);
                    store.Write("AutoAdminLogon", previous["AutoAdminLogon"]);
                } catch {
                    try { store.Write("AutoAdminLogon", LoginValue.Text("0")); } catch { }
                    throw new AutoLogonRecoveryFailure();
                }
                throw new InvalidOperationException("自动登录设置保存失败，已恢复此前配置。请检查权限和系统策略后重试。");
            }
        }
        public static void Enable(IAutoLogonStore store, LoginAccount account, string password, bool replaceExisting, Action verify)
        {
            Validate(account, password);
            if (!Owned(store, account.Sid) && !replaceExisting &&
                (Text(store.Read("AutoAdminLogon")) == "1" || store.Read("DefaultPassword") != null || !String.IsNullOrEmpty(store.ReadSecret())))
                throw new InvalidOperationException("检测到其他工具设置的自动登录。若要接管，请勾选“替换现有自动登录配置”。");
            // Exactly one credential verification per explicit Save. Never retry a bad password.
            verify();
            Transaction(store, () => {
                store.Write("AutoAdminLogon", LoginValue.Text("0"));
                store.WriteSecret(password);
                store.Write("DefaultPassword", null);
                store.Write("DefaultUserName", LoginValue.Text(account.User));
                store.Write("DefaultDomainName", LoginValue.Text(account.Domain));
                store.Write("AutoLogonCount", null);
                store.WriteOwner(account.Marker);
                store.Write("AutoAdminLogon", LoginValue.Text("1"));
                if (Text(store.Read("AutoAdminLogon")) != "1" || !Owned(store, account.Sid) ||
                    store.Read("DefaultPassword") != null || store.ReadSecret() != password)
                    throw new InvalidOperationException("配置校验失败。");
            });
        }
        public static void Disable(IAutoLogonStore store, string sid)
        {
            if (!Owned(store, sid)) throw new InvalidOperationException("当前自动登录配置不属于 LaunchFlow，或已被外部修改；请在原配置工具中关闭。");
            Transaction(store, () => {
                store.Write("AutoAdminLogon", LoginValue.Text("0"));
                store.WriteSecret(null);
                store.Write("DefaultPassword", null);
                store.WriteOwner(null);
                if (Text(store.Read("AutoAdminLogon")) != "0" || store.ReadSecret() != null || store.Read("DefaultPassword") != null)
                    throw new InvalidOperationException("撤销校验失败。");
            });
        }
    }
    public sealed class WindowsAutoLogonStore : IAutoLogonStore, IDisposable
    {
        internal const string WinlogonPath = @"SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon";
        internal const string OwnerPath = @"SOFTWARE\LaunchFlow\AutoLogon";
        readonly RegistryKey root, winlogon;
        public WindowsAutoLogonStore()
        {
            root = RegistryKey.OpenBaseKey(RegistryHive.LocalMachine, RegistryView.Registry64);
            winlogon = root.OpenSubKey(WinlogonPath, true);
            if (winlogon == null) { root.Dispose(); throw new InvalidOperationException("无法打开 Windows 登录配置。"); }
        }
        public LoginValue Read(string name)
        {
            var value = winlogon.GetValue(name, null, RegistryValueOptions.DoNotExpandEnvironmentNames);
            return value == null ? null : new LoginValue(value, winlogon.GetValueKind(name));
        }
        public void Write(string name, LoginValue value)
        {
            if (value == null) winlogon.DeleteValue(name, false); else winlogon.SetValue(name, value.Value, value.Kind);
            winlogon.Flush();
        }
        public string ReadSecret() { return LoginSecrets.Read(); }
        public void WriteSecret(string value) { LoginSecrets.Write(value); }
        public string ReadOwner() { using (var key = root.OpenSubKey(OwnerPath)) return key == null ? null : key.GetValue("Owner") as string; }
        public void WriteOwner(string value)
        {
            using (var key = root.CreateSubKey(OwnerPath)) {
                if (value == null) key.DeleteValue("Owner", false); else key.SetValue("Owner", value, RegistryValueKind.String);
                key.Flush();
            }
        }
        public void Dispose() { winlogon.Dispose(); root.Dispose(); }
        public static object Status()
        {
            try {
                using (var root = RegistryKey.OpenBaseKey(RegistryHive.LocalMachine, RegistryView.Registry64))
                using (var key = root.OpenSubKey(WinlogonPath))
                using (var owner = root.OpenSubKey(OwnerPath)) {
                    string marker = owner == null ? null : owner.GetValue("Owner") as string;
                    string expected = WindowsIdentity.GetCurrent().User.Value + "\n" + Convert.ToString(key.GetValue("DefaultDomainName", "")) + "\n" + Convert.ToString(key.GetValue("DefaultUserName", ""));
                    // Status and diagnostics never retrieve the password/LSA secret or account name.
                    return Wire.Obj("enabled", Convert.ToString(key.GetValue("AutoAdminLogon", "0")) == "1", "managed", marker == expected);
                }
            } catch { return Wire.Obj("enabled", null, "managed", false); }
        }
    }
    internal static class LoginSecrets
    {
        [StructLayout(LayoutKind.Sequential)] struct Unicode { public ushort Length, MaximumLength; public IntPtr Buffer; }
        [StructLayout(LayoutKind.Sequential)] struct Attributes { public int Length; public IntPtr RootDirectory, ObjectName; public uint Flags; public IntPtr SecurityDescriptor, SecurityQualityOfService; }
        [DllImport("advapi32.dll")] static extern uint LsaOpenPolicy(IntPtr system, ref Attributes attributes, uint access, out IntPtr policy);
        [DllImport("advapi32.dll")] static extern uint LsaStorePrivateData(IntPtr policy, ref Unicode key, IntPtr data);
        [DllImport("advapi32.dll")] static extern uint LsaRetrievePrivateData(IntPtr policy, ref Unicode key, out IntPtr data);
        [DllImport("advapi32.dll")] static extern uint LsaNtStatusToWinError(uint status);
        [DllImport("advapi32.dll")] static extern uint LsaClose(IntPtr handle);
        [DllImport("advapi32.dll")] static extern uint LsaFreeMemory(IntPtr memory);
        static Unicode StringValue(string value) { return new Unicode { Length = checked((ushort)(value.Length * 2)), MaximumLength = checked((ushort)(value.Length * 2 + 2)), Buffer = Marshal.StringToHGlobalUni(value) }; }
        static void Clear(Unicode value) { if (value.Buffer != IntPtr.Zero) { for (int i = 0; i < value.MaximumLength; i++) Marshal.WriteByte(value.Buffer, i, 0); Marshal.FreeHGlobal(value.Buffer); } }
        static void Check(uint result) { if (result != 0) throw new InvalidOperationException("Windows 凭据存储失败（错误码 " + LsaNtStatusToWinError(result) + "）。"); }
        static IntPtr Open(uint access) { var attributes = new Attributes { Length = Marshal.SizeOf(typeof(Attributes)) }; IntPtr policy; Check(LsaOpenPolicy(IntPtr.Zero, ref attributes, access, out policy)); return policy; }
        public static string Read()
        {
            var key = StringValue("DefaultPassword"); IntPtr policy = IntPtr.Zero, data = IntPtr.Zero;
            try {
                policy = Open(0x00000004); // POLICY_GET_PRIVATE_INFORMATION
                uint status = LsaRetrievePrivateData(policy, ref key, out data);
                if (LsaNtStatusToWinError(status) == 2) return null;
                Check(status);
                var text = (Unicode)Marshal.PtrToStructure(data, typeof(Unicode));
                try { return Marshal.PtrToStringUni(text.Buffer, text.Length / 2); }
                finally { for (int i = 0; i < text.Length; i++) Marshal.WriteByte(text.Buffer, i, 0); }
            } finally { if (data != IntPtr.Zero) LsaFreeMemory(data); if (policy != IntPtr.Zero) LsaClose(policy); Clear(key); }
        }
        public static void Write(string value)
        {
            var key = StringValue("DefaultPassword"); var secret = new Unicode(); IntPtr policy = IntPtr.Zero, data = IntPtr.Zero;
            try {
                policy = Open(0x00000020); // POLICY_CREATE_SECRET
                if (value != null) { secret = StringValue(value); data = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(Unicode))); Marshal.StructureToPtr(secret, data, false); }
                uint result = LsaStorePrivateData(policy, ref key, data);
                if (value != null || LsaNtStatusToWinError(result) != 2) Check(result);
            } finally { Clear(secret); Clear(key); if (data != IntPtr.Zero) Marshal.FreeHGlobal(data); if (policy != IntPtr.Zero) LsaClose(policy); }
        }
    }
}
