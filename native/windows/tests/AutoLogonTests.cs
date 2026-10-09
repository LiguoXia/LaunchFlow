using System;
using System.Collections.Generic;
using System.Linq;
using Microsoft.Win32;
using LaunchFlow.Native;

public sealed class MemoryLoginStore : IAutoLogonStore
{
    public readonly Dictionary<string, LoginValue> Values = new Dictionary<string, LoginValue>();
    public string Secret, Owner;
    public int Writes, FailWrite, FailFrom;
    public bool IgnoreEnable;
    void Changing() { Writes++; if (Writes == FailWrite || (FailFrom > 0 && Writes >= FailFrom)) throw new InvalidOperationException("Simulated storage failure"); }
    public LoginValue Read(string name) { LoginValue value; return Values.TryGetValue(name, out value) ? value : null; }
    public void Write(string name, LoginValue value) {
        Changing(); if (name == "AutoAdminLogon" && IgnoreEnable && AutoLogonConfiguration.Text(value) == "1") return;
        if (value == null) Values.Remove(name); else Values[name] = value;
    }
    public string ReadSecret() { return Secret; }
    public void WriteSecret(string value) { Changing(); Secret = value; }
    public string ReadOwner() { return Owner; }
    public void WriteOwner(string value) { Changing(); Owner = value; }
    public string Snapshot() { return String.Join(";", Values.OrderBy(v => v.Key).Select(v => v.Key + ":" + v.Value.Kind + ":" + v.Value.Value)) + "|" + Secret + "|" + Owner; }
}
public static class AutoLogonTests
{
    public static void Assert(bool value, string message) { if (!value) throw new Exception(message); }
    static readonly LoginAccount Account = new LoginAccount("FixtureUser", "FixtureComputer", "S-1-5-21-100-200-300-1001");
    static int passed;
    static void Check(string name, Action test) { test(); passed++; Console.WriteLine("PASS " + name); }
    static void Fails(Action action) { bool threw = false; try { action(); } catch (InvalidOperationException) { threw = true; } Assert(threw, "Expected a controlled failure"); }
    public static int Main()
    {
        Check("Save verifies once, stores password only in LSA, and enables last", () => {
            var store = new MemoryLoginStore(); int verified = 0;
            AutoLogonConfiguration.Enable(store, Account, "FixturePassword!", false, () => verified++);
            Assert(verified == 1 && store.Secret == "FixturePassword!" && store.Read("DefaultPassword") == null && AutoLogonConfiguration.Owned(store, Account.Sid) && AutoLogonConfiguration.Text(store.Read("AutoAdminLogon")) == "1", "Enable failed");
        });
        Check("Bad credentials leave every setting untouched and are not retried", () => {
            var store = new MemoryLoginStore(); int verified = 0; string before = store.Snapshot();
            Fails(() => AutoLogonConfiguration.Enable(store, Account, "WrongFixture!", false, () => { verified++; throw new InvalidOperationException("Bad credentials"); }));
            Assert(verified == 1 && store.Writes == 0 && before == store.Snapshot(), "Invalid credential side effects");
        });
        Check("Reject empty password before credential validation or writes", () => {
            var store = new MemoryLoginStore();
            Fails(() => AutoLogonConfiguration.Enable(store, Account, "", false, () => { throw new Exception("Must not validate empty password"); }));
            Assert(store.Writes == 0, "Empty password mutation");
        });
        Check("Foreign configuration requires explicit replacement choice", () => {
            var store = new MemoryLoginStore { Secret = "OtherFixture" }; string before = store.Snapshot();
            Fails(() => AutoLogonConfiguration.Enable(store, Account, "FixturePassword!", false, () => { throw new Exception("Must not verify before replacement consent"); }));
            Assert(before == store.Snapshot() && store.Writes == 0, "Foreign credential overwritten");
        });
        Check("Confirmed replacement clears legacy plaintext and logon-count restriction", () => {
            var store = new MemoryLoginStore(); store.Values["DefaultPassword"] = LoginValue.Text("LegacyFixture"); store.Values["AutoLogonCount"] = new LoginValue(1, RegistryValueKind.DWord);
            AutoLogonConfiguration.Enable(store, Account, "FixturePassword!", true, () => {});
            Assert(store.Read("DefaultPassword") == null && store.Read("AutoLogonCount") == null, "Legacy values remain");
        });
        Check("Every failed enable write restores original credential, values and registry types", () => {
            for (int index = 1; index <= 8; index++) {
                var store = new MemoryLoginStore { Secret = "BeforeFixture", Owner = "OtherOwner", FailWrite = index };
                store.Values["AutoAdminLogon"] = LoginValue.Text("1"); store.Values["DefaultPassword"] = LoginValue.Text("OldPlainFixture");
                store.Values["DefaultUserName"] = LoginValue.Text("BeforeUser"); store.Values["AutoLogonCount"] = new LoginValue(3, RegistryValueKind.DWord);
                string before = store.Snapshot();
                Fails(() => AutoLogonConfiguration.Enable(store, Account, "FixturePassword!", true, () => {}));
                Assert(before == store.Snapshot(), "Incomplete rollback at write " + index);
            }
        });
        Check("Persistent storage failure is explicitly uncertain, with enable flag turned off first", () => {
            var store = new MemoryLoginStore { FailFrom = 2 }; bool uncertain = false;
            try { AutoLogonConfiguration.Enable(store, Account, "FixturePassword!", false, () => {}); }
            catch (AutoLogonRecoveryFailure) { uncertain = true; }
            Assert(uncertain && AutoLogonConfiguration.Text(store.Read("AutoAdminLogon")) == "0", "Incomplete recovery reported as ordinary cancellation");
        });
        Check("Read-back catches ignored system writes instead of reporting success", () => {
            var store = new MemoryLoginStore { IgnoreEnable = true }; string before = store.Snapshot();
            Fails(() => AutoLogonConfiguration.Enable(store, Account, "FixturePassword!", false, () => {}));
            Assert(before == store.Snapshot(), "False success or incomplete rollback");
        });
        Check("Disable removes owned LSA password and keeps automatic login off", () => {
            var store = new MemoryLoginStore(); AutoLogonConfiguration.Enable(store, Account, "FixturePassword!", false, () => {});
            AutoLogonConfiguration.Disable(store, Account.Sid);
            Assert(store.Secret == null && store.Owner == null && AutoLogonConfiguration.Text(store.Read("AutoAdminLogon")) == "0", "Disable failed");
        });
        Check("Externally changed account cannot be revoked by this user's ownership marker", () => {
            var store = new MemoryLoginStore(); AutoLogonConfiguration.Enable(store, Account, "FixturePassword!", false, () => {});
            store.Values["DefaultUserName"] = LoginValue.Text("AnotherUser"); string before = store.Snapshot();
            Fails(() => AutoLogonConfiguration.Disable(store, Account.Sid)); Assert(before == store.Snapshot(), "External settings changed");
        });
        Check("Every failed disable write restores the prior configuration", () => {
            for (int index = 1; index <= 4; index++) {
                var store = new MemoryLoginStore(); AutoLogonConfiguration.Enable(store, Account, "FixturePassword!", false, () => {});
                string before = store.Snapshot(); store.FailWrite = store.Writes + index;
                Fails(() => AutoLogonConfiguration.Disable(store, Account.Sid)); Assert(before == store.Snapshot(), "Disable rollback failed");
            }
        });
        Console.WriteLine("Passed " + passed + " auto-login configuration tests; no Windows settings or real credentials used."); return 0;
    }
}
