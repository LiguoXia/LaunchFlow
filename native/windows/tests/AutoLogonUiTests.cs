using System;
using System.Drawing;
using System.IO;
using System.Threading.Tasks;
using System.Windows.Forms;
using LaunchFlow.Native;

public static class AutoLogonUiTests
{
    static readonly LoginAccount Account = new LoginAccount("FixtureUser", "FixtureComputer", "S-1-5-21-100-200-300-1001");
    static T Find<T>(Control form, string name) where T : Control { return (T)form.Controls.Find(name, true)[0]; }
    static void Assert(bool value, string message) { AutoLogonTests.Assert(value, message); }
    [STAThread] public static int Main(string[] args)
    {
        Application.EnableVisualStyles(); Application.SetCompatibleTextRenderingDefault(false);
        var store = new MemoryLoginStore(); int verified = 0; Exception failure = null;
        using (var form = new AutoLogonForm(Account, store, (account, password) => {
            verified++; if (verified == 1) throw new InvalidOperationException("测试：账户密码验证失败；未更改配置。");
        })) {
            form.Shown += async (sender, e) => {
                try {
                    Assert(Find<TextBox>(form, "accountPassword").UseSystemPasswordChar, "Password is not masked");
                    Assert(Find<ComboBox>(form, "accountKind").SelectedIndex == 0 && Find<ComboBox>(form, "accountKind").Text == "本地或域账户", "Default account kind missing");
                    Find<ComboBox>(form, "accountKind").SelectedIndex = 1;
                    Assert(Find<TextBox>(form, "accountUser").Text == "" && Find<TextBox>(form, "accountDomain").Text == "MicrosoftAccount" && Find<TextBox>(form, "accountDomain").ReadOnly, "Microsoft account mode incorrect");
                    Find<ComboBox>(form, "accountKind").SelectedIndex = 0;
                    Find<TextBox>(form, "accountUser").Text = Account.User;
                    Assert(!Find<Button>(form, "disableAutologon").Enabled, "Disable enabled for unowned settings");
                    using (var bitmap = new Bitmap(form.Width, form.Height)) { form.DrawToBitmap(bitmap, new Rectangle(0, 0, form.Width, form.Height)); bitmap.Save(Path.Combine(args[0], "configuration-window.png")); }
                    Find<TextBox>(form, "accountPassword").Text = "WrongFixtureOnly!";
                    Find<Button>(form, "enableAutologon").PerformClick();
                    for (int i = 0; i < 300 && form.Saving; i++) await Task.Delay(10);
                    Assert(!form.Saving && store.Writes == 0 && verified == 1, "Bad password changed state or retried");
                    Assert(Find<TextBox>(form, "accountPassword").Text == "", "Password retained after submission");
                    Assert(Find<Label>(form, "configurationStatus").Text.Contains("验证失败"), "Missing visible failure");
                    Find<TextBox>(form, "accountPassword").Text = "ValidFixtureOnly!";
                    Find<Button>(form, "enableAutologon").PerformClick();
                } catch (Exception error) { failure = error; form.Close(); }
            };
            form.ShowDialog(); if (failure != null) throw failure;
            Assert(form.Result == 20 && store.Secret == "ValidFixtureOnly!" && verified == 2, "Valid save did not succeed");
        }
        Console.WriteLine("PASS Built-in window masks and clears passwords; wrong password remains visible; valid save closes with enabled result");
        string saved = store.Snapshot();
        using (var form = new AutoLogonForm(Account, store, (a, p) => { throw new Exception("Cancel must not verify"); })) {
            form.Shown += (sender, e) => { Find<TextBox>(form, "accountPassword").Text = "CancelledFixtureOnly!"; form.Close(); };
            form.ShowDialog(); Assert(form.Result == 0 && store.Snapshot() == saved, "Cancellation changed configuration");
        }
        Console.WriteLine("PASS Cancel leaves existing configuration unchanged");
        using (var form = new AutoLogonForm(Account, store, (a, p) => { throw new Exception("Disable must not verify password"); })) {
            form.Shown += (sender, e) => { Find<Button>(form, "disableAutologon").PerformClick(); };
            form.ShowDialog(); Assert(form.Result == 21 && store.Secret == null && store.Owner == null, "Disable failed");
        }
        Console.WriteLine("PASS Reopened built-in window disables owned auto-login without asking for the password again");
        var brokenStore = new MemoryLoginStore { FailFrom = 2 };
        using (var form = new AutoLogonForm(Account, brokenStore, (a, p) => {})) {
            form.Shown += async (sender, e) => {
                try {
                    Find<TextBox>(form, "accountPassword").Text = "ValidFixtureOnly!";
                    Find<Button>(form, "enableAutologon").PerformClick();
                    for (int i = 0; i < 300 && form.Saving; i++) await Task.Delay(10);
                    Assert(!form.Saving && form.Result == 22 && Find<Label>(form, "configurationStatus").Text.Contains("无法完整恢复"), "Missing partial-recovery error");
                    form.Close();
                } catch (Exception error) { failure = error; form.Close(); }
            };
            form.ShowDialog(); if (failure != null) throw failure;
            Assert(form.Result == 22, "Closing the window hid an incomplete recovery");
        }
        Console.WriteLine("PASS Incomplete recovery remains an explicit error when the configuration window closes");
        return 0;
    }
}
