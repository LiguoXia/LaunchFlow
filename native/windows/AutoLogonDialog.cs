using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Security.Principal;
using System.Threading;
using System.Threading.Tasks;
using System.Windows.Forms;

namespace LaunchFlow.Native
{
    public static class AutoLogonDialog
    {
        [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        static extern bool LogonUser(string user, string domain, string password, int type, int provider, out IntPtr token);
        [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
        public static void Verify(LoginAccount account, string password)
        {
            IntPtr token;
            if (!LogonUser(account.User, String.IsNullOrEmpty(account.Domain) ? null : account.Domain, password, 2, 0, out token)) {
                int code = Marshal.GetLastWin32Error();
                throw new InvalidOperationException(code == 1326 ? "账户密码验证失败。请输入账户密码而非 PIN；Microsoft 账户请使用邮箱及对应密码。未更改配置。" :
                    "Windows 未允许此账户使用密码登录（错误码 " + code + "）。请检查账户、密码及组织策略；未更改配置。");
            }
            try { using (var identity = new WindowsIdentity(token)) {
                if (identity.User.Value != account.Sid) throw new InvalidOperationException("验证得到的账户与当前 LaunchFlow 用户不同。请配置当前账户，未更改系统设置。");
            } } finally { CloseHandle(token); }
        }
        public static object Request()
        {
            if (Thread.CurrentThread.GetApartmentState() != ApartmentState.STA) {
                object result = null; Exception failure = null;
                var thread = new Thread(() => { try { result = Request(); } catch (Exception e) { failure = e; } });
                thread.SetApartmentState(ApartmentState.STA); thread.Start(); thread.Join();
                if (failure != null) throw failure; return result;
            }
            string helper = Path.Combine(Path.GetDirectoryName(Assembly.GetExecutingAssembly().Location), "launchflow-authorized.exe");
            if (!File.Exists(helper)) throw new NativeFailure("autologonUnavailable", "自动登录配置组件缺失，请重新安装完整版本。");
            using (var self = Process.GetCurrentProcess()) {
                try {
                    // Only process identity is passed. Passwords never enter command lines, IPC or logs.
                    string args = "--configure-autologon " + self.Id + " " + self.StartTime.ToUniversalTime().Ticks + " " + WindowsIdentity.GetCurrent().User.Value;
                    using (var child = Process.Start(new ProcessStartInfo(helper, args) { UseShellExecute = true, Verb = "runas", WindowStyle = ProcessWindowStyle.Normal })) {
                        if (child == null) throw new NativeFailure("autologonUnavailable", "未能打开自动登录配置窗口。");
                        if (!child.WaitForExit(600000)) throw new NativeFailure("autologonTimeout", "自动登录窗口仍在等待，请检查窗口；配置状态见刷新检测。");
                        if (child.ExitCode == 20) return Wire.Obj("status", "enabled");
                        if (child.ExitCode == 21) return Wire.Obj("status", "disabled");
                        if (child.ExitCode == 0) return Wire.Obj("status", "cancelled");
                        if (child.ExitCode == 22) throw new NativeFailure("autologonRecoveryFailed", "自动登录保存失败且恢复未完成，不能确认此前配置已恢复。请重新打开配置窗口检查，暂不要重启。");
                        throw new NativeFailure("autologonFailed", "自动登录配置未完成（" + child.ExitCode + "）。请使用当前账户进行管理员授权并重新打开。");
                    }
                } catch (System.ComponentModel.Win32Exception e) {
                    if (e.NativeErrorCode == 1223) throw new NativeFailure("uacCancelled", "已取消 Windows 管理员授权，自动登录配置未更改。");
                    throw new NativeFailure("autologonFailed", "Windows 未允许打开配置窗口（错误码 " + e.NativeErrorCode + "）。");
                }
            }
        }
        public static int Run(string pidText, string started, string sid)
        {
            try {
                int pid;
                if (!Int32.TryParse(pidText, out pid) || WindowsIdentity.GetCurrent().User.Value != sid ||
                    !new WindowsPrincipal(WindowsIdentity.GetCurrent()).IsInRole(WindowsBuiltInRole.Administrator)) return 10;
                using (var parent = Process.GetProcessById(pid)) {
                    string expected = Path.Combine(Path.GetDirectoryName(Assembly.GetExecutingAssembly().Location), "launchflow-automation.exe");
                    if (parent.HasExited || parent.StartTime.ToUniversalTime().Ticks.ToString() != started || parent.SessionId != Process.GetCurrentProcess().SessionId ||
                        !String.Equals(parent.MainModule.FileName, expected, StringComparison.OrdinalIgnoreCase)) return 11;
                    string[] name = WindowsIdentity.GetCurrent().Name.Split(new[] { '\\' }, 2);
                    var account = new LoginAccount(name.Length == 2 ? name[1] : name[0], name.Length == 2 ? name[0] : Environment.MachineName, sid);
                    Application.EnableVisualStyles(); Application.SetCompatibleTextRenderingDefault(false);
                    using (var store = new WindowsAutoLogonStore())
                    using (var form = new AutoLogonForm(account, store, (user, password) => {
                        Verify(user, password);
                        if (parent.HasExited) throw new InvalidOperationException("LaunchFlow 已退出，未保存配置。");
                    }))
                    using (var timer = new System.Windows.Forms.Timer { Interval = 500 }) {
                        var deadline = DateTime.UtcNow.AddMinutes(9);
                        timer.Tick += (sender, args) => { if (!form.Saving && (parent.HasExited || DateTime.UtcNow > deadline)) form.Close(); };
                        timer.Start(); form.ShowDialog(); return form.Result;
                    }
                }
            } catch { return 12; }
        }
    }
    // Public for the isolated UI fixture; production always supplies WindowsAutoLogonStore.
    public sealed class AutoLogonForm : Form
    {
        public int Result { get; private set; }
        public bool Saving { get; private set; }
        readonly IAutoLogonStore store;
        readonly LoginAccount original;
        readonly Action<LoginAccount, string> verify;
        readonly TextBox user = new TextBox { Name = "accountUser", AccessibleName = "账户名", Dock = DockStyle.Fill };
        readonly TextBox domain = new TextBox { Name = "accountDomain", AccessibleName = "计算机名或域", Dock = DockStyle.Fill };
        readonly TextBox password = new TextBox { Name = "accountPassword", AccessibleName = "账户密码（不是 PIN）", UseSystemPasswordChar = true, MaxLength = 256, Dock = DockStyle.Fill };
        readonly CheckBox replace = new CheckBox { Text = "替换现有自动登录配置（仅在接管其他工具的配置时勾选）", AutoSize = true };
        readonly Label status = new Label { Name = "configurationStatus", AutoSize = true, MaximumSize = new Size(610, 0) };
        readonly Button save = new Button { Text = "验证密码并启用自动登录", AutoSize = true, Name = "enableAutologon" };
        readonly Button disable = new Button { Text = "关闭自动登录并清除已存密码", AutoSize = true, Name = "disableAutologon" };
        readonly Button cancel = new Button { Text = "取消", AutoSize = true, DialogResult = DialogResult.Cancel };
        readonly ComboBox kind = new ComboBox { Name = "accountKind", DropDownStyle = ComboBoxStyle.DropDownList, Dock = DockStyle.Fill, AccessibleName = "账户类型" };
        public AutoLogonForm(LoginAccount account, IAutoLogonStore storage, Action<LoginAccount, string> validate)
        {
            original = account; store = storage; verify = validate;
            Text = "LaunchFlow · Windows 自动登录"; StartPosition = FormStartPosition.CenterScreen;
            AutoScaleMode = AutoScaleMode.Dpi; Font = new Font("Microsoft YaHei UI", 10); ClientSize = new Size(660, 480);
            FormBorderStyle = FormBorderStyle.FixedDialog; MaximizeBox = false; MinimizeBox = false;
            var layout = new TableLayoutPanel { Dock = DockStyle.Fill, Padding = new Padding(22), ColumnCount = 2, RowCount = 10, AutoScroll = true };
            layout.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 150)); layout.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
            Action<Control, int> full = (control, row) => { layout.Controls.Add(control, 0, row); layout.SetColumnSpan(control, 2); control.Margin = new Padding(0, 0, 0, 14); };
            full(new Label { Text = "开机或重启后由 Windows 自动登录，再运行 LaunchFlow 默认场景。\n此处填写账户密码，不是 Windows Hello PIN；PIN 登录方式仍会保留。", AutoSize = true, MaximumSize = new Size(610, 0) }, 0);
            kind.Items.AddRange(new object[] { "本地或域账户", "Microsoft 账户" }); kind.SelectedIndex = account.Domain == "MicrosoftAccount" ? 1 : 0;
            user.Text = account.User; domain.Text = account.Domain;
            kind.SelectedIndexChanged += (sender, args) => {
                domain.Text = kind.SelectedIndex == 1 ? "MicrosoftAccount" : original.Domain;
                domain.ReadOnly = kind.SelectedIndex == 1;
                if (kind.SelectedIndex == 1 && !user.Text.Contains("@")) user.Clear();
                status.Text = kind.SelectedIndex == 1 ? "Microsoft 账户请填写登录邮箱和账户密码。" : "本地账户通常使用上方自动填入的计算机名与用户名。";
            };
            layout.Controls.Add(new Label { Text = "账户类型", AutoSize = true }, 0, 1); layout.Controls.Add(kind, 1, 1);
            layout.Controls.Add(new Label { Text = "账户名 / 邮箱", AutoSize = true }, 0, 2); layout.Controls.Add(user, 1, 2);
            layout.Controls.Add(new Label { Text = "计算机名 / 域", AutoSize = true }, 0, 3); layout.Controls.Add(domain, 1, 3);
            layout.Controls.Add(new Label { Text = "账户密码", AutoSize = true }, 0, 4); layout.Controls.Add(password, 1, 4);
            for (int row = 1; row < 5; row++) layout.RowStyles.Add(new RowStyle(SizeType.AutoSize));
            full(replace, 5);
            full(new Label { Text = "密码保存在 Windows LSA 中，不进入场景、日志或导出。管理员仍可能读取它。\n启用后，能接触电脑的人可直接进入此账户；普通锁屏不会自动解锁。", AutoSize = true, MaximumSize = new Size(610, 0) }, 6);
            full(status, 7);
            var buttons = new FlowLayoutPanel { AutoSize = true, Dock = DockStyle.Fill, FlowDirection = FlowDirection.LeftToRight };
            buttons.Controls.Add(save); buttons.Controls.Add(disable); buttons.Controls.Add(cancel); full(buttons, 8);
            Controls.Add(layout); CancelButton = cancel;
            disable.Enabled = AutoLogonConfiguration.Owned(store, original.Sid);
            status.Text = disable.Enabled ? "已由 LaunchFlow 登记。可更新密码或关闭自动登录。" : "尚未由 LaunchFlow 登记。保存前会验证一次账户密码。";
            save.Click += async (sender, args) => await Apply(false);
            disable.Click += async (sender, args) => await Apply(true);
            FormClosing += (sender, args) => { if (Saving) args.Cancel = true; else password.Clear(); };
            Shown += (sender, args) => { Activate(); password.Focus(); };
        }
        async Task Apply(bool remove)
        {
            var account = new LoginAccount(user.Text.Trim(), domain.Text.Trim(), original.Sid);
            if (account.Domain == ".") account.Domain = Environment.MachineName;
            string secret = password.Text; bool replaceExisting = replace.Checked; password.Clear();
            Saving = true; save.Enabled = disable.Enabled = cancel.Enabled = user.Enabled = domain.Enabled = password.Enabled = kind.Enabled = replace.Enabled = false;
            status.ForeColor = SystemColors.ControlText; status.Text = remove ? "正在关闭自动登录…" : "正在验证密码并保存…";
            try {
                await Task.Run(() => {
                    using (var mutex = new Mutex(false, @"Global\LaunchFlow-AutoLogon-Config")) {
                        bool locked = false;
                        try {
                            try { locked = mutex.WaitOne(0); } catch (AbandonedMutexException) { locked = true; }
                            if (!locked) throw new InvalidOperationException("另一个自动登录配置正在保存，请稍后重试。");
                            if (remove) AutoLogonConfiguration.Disable(store, original.Sid);
                            else AutoLogonConfiguration.Enable(store, account, secret, replaceExisting, () => verify(account, secret));
                        } finally { if (locked) mutex.ReleaseMutex(); }
                    }
                });
                Result = remove ? 21 : 20; Saving = false; Close();
            } catch (Exception error) {
                if (error is AutoLogonRecoveryFailure) Result = 22;
                status.ForeColor = Color.Firebrick;
                status.Text = error is InvalidOperationException ? error.Message : "自动登录配置失败（" + error.GetType().Name + " / 0x" + error.HResult.ToString("X8") + "）。未触发重启，请检查权限与系统策略。";
            } finally {
                secret = null; Saving = false;
                if (!IsDisposed) {
                    save.Enabled = cancel.Enabled = user.Enabled = domain.Enabled = password.Enabled = kind.Enabled = replace.Enabled = true;
                    try { disable.Enabled = AutoLogonConfiguration.Owned(store, original.Sid); } catch { disable.Enabled = false; }
                    password.Focus();
                }
            }
        }
    }
}
