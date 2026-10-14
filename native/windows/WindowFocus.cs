using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Threading;
using System.Windows.Automation;

namespace LaunchFlow.Native
{
    // Injectable operations let tests reproduce delayed cross-thread activation without desktop input.
    public class FocusDesktop
    {
        readonly Stopwatch clock = Stopwatch.StartNew();
        public virtual long Milliseconds { get { return clock.ElapsedMilliseconds; } }
        public virtual bool Exists(IntPtr h) { return Win.IsWindow(h); }
        public virtual bool Minimized(IntPtr h) { return Win.IsIconic(h); }
        public virtual bool Visible(IntPtr h) { return Win.IsWindowVisible(h); }
        public virtual bool FrameworkWindow(IntPtr h) {
            string name = ClassName(h);
            return name.StartsWith("Qt", StringComparison.OrdinalIgnoreCase) || name == "Chrome_WidgetWin_1";
        }
        public virtual bool Enabled(IntPtr h) { return Win.IsWindowEnabled(h); }
        public virtual bool Responsive(IntPtr h) {
            UIntPtr result;
            return Win.SendMessageTimeout(h, 0, IntPtr.Zero, IntPtr.Zero, 3, 100, out result) != IntPtr.Zero;
        }
        public virtual IntPtr Foreground() { return Win.GetForegroundWindow(); }
        public virtual IntPtr Root(IntPtr h) { return Win.GetAncestor(h, 2); }
        public virtual void Restore(IntPtr h) { Win.ShowWindowAsync(h, 9); }
        public virtual string ClassName(IntPtr h) { return Win.Class(h); }
        public virtual string ApplicationId(IntPtr h) { return PackagedWindowActivation.ForWindow(h); }
        public virtual void ActivateApplication(string id) { PackagedWindowActivation.Activate(id); }
        public virtual void HideForApplicationRestore(IntPtr h) { Win.ShowWindow(h, 0); }
        public string HiddenRestoreMethod = "none";
        public virtual void Show(IntPtr h) {
            // Chromium's WM_SYSCOMMAND restores only the outer HWND; its Views widget
            // and renderer can remain hidden. Registered apps must restore themselves.
            bool maximized = Win.IsZoomed(h);
            string name = ClassName(h);
            if (name == "Chrome_WidgetWin_1") {
                string id = ApplicationId(h);
                if (PackagedWindowActivation.ValidId(id)) {
                    HiddenRestoreMethod = "applicationActivation";
                    // A previous release may have left an OS-visible ghost frame.
                    // Clear that frame so success requires the app itself to show it
                    // again; otherwise the next loop could accept stale visibility
                    // before the shell's asynchronous activation has been handled.
                    if (Visible(h)) HideForApplicationRestore(h);
                    ActivateApplication(id);
                    return;
                }
            }
            if (name.StartsWith("Qt", StringComparison.OrdinalIgnoreCase)) {
                bool restored = false;
                var operation = new Thread(delegate() {
                    try {
                        var element = AutomationElement.FromHandle(h);
                        object value;
                        if (element.TryGetCurrentPattern(WindowPattern.Pattern, out value)) {
                            ((WindowPattern)value).SetWindowVisualState(maximized ?
                                WindowVisualState.Maximized : WindowVisualState.Normal);
                            restored = true;
                        }
                    } catch (ElementNotAvailableException) { }
                    catch (InvalidOperationException) { }
                    catch (System.Runtime.InteropServices.COMException) { }
                    catch (NotSupportedException) { }
                }) { IsBackground = true };
                operation.SetApartmentState(ApartmentState.MTA);
                operation.Start();
                if (!operation.Join(1000))
                    throw new NativeFailure("focusDenied", "应用的窗口恢复接口没有响应；请通过系统托盘打开应用后重试。");
                if (restored) { HiddenRestoreMethod = "accessibility"; return; }
            }
            HiddenRestoreMethod = "systemCommand";
            UIntPtr result;
            if (Win.SendMessageTimeout(h, 0x0112, new IntPtr(maximized ? 0xF030 : 0xF120),
                IntPtr.Zero, 3, 700, out result) == IntPtr.Zero)
                throw new NativeFailure("focusDenied", "应用未接受窗口恢复请求；请通过系统托盘打开应用后重试。");
        }
        public virtual bool Request(IntPtr h) { return Win.SetForegroundWindow(h); }
        public virtual void Pause() { Thread.Sleep(25); }
    }
    public static class WindowFocus
    {
        [ThreadStatic] public static Dictionary<string, object> LastDiagnostic;
        static bool Matches(IntPtr h, FocusDesktop desktop)
        {
            var foreground = desktop.Foreground();
            return foreground != IntPtr.Zero && (foreground == h || desktop.Root(foreground) == h);
        }
        public static bool IsForeground(IntPtr h) { return h != IntPtr.Zero && Matches(h, new FocusDesktop()); }
        public static void Activate(IntPtr h) { Activate(h, new FocusDesktop()); }
        public static void ActivateExplicit(IntPtr h) { Activate(h, new FocusDesktop(), true); }
        public static void Activate(IntPtr h, FocusDesktop desktop)
        {
            Activate(h, desktop, false);
        }
        public static void Activate(IntPtr h, FocusDesktop desktop, bool repairVisible)
        {
            long start = desktop.Milliseconds;
            bool restored = false, shown = false, requested = false, accepted = false;
            bool refreshed = false;
            while (true)
            {
                bool present = h != IntPtr.Zero && desktop.Exists(h);
                bool minimized = present && desktop.Minimized(h);
                bool visible = present && desktop.Visible(h);
                bool enabled = present && desktop.Enabled(h);
                bool responsive = present && visible && !minimized && enabled && desktop.Responsive(h);
                bool matched = present && visible && !minimized && enabled && responsive && Matches(h, desktop);
                long elapsed = desktop.Milliseconds - start;
                LastDiagnostic = Wire.Obj("stage", matched ? "foregroundConfirmed" : "foregroundWait",
                    "elapsedMs", elapsed, "restoreRequested", restored, "activationRequested", requested,
                    "requestAccepted", accepted, "foregroundMatched", matched, "targetPresent", present,
                    "hiddenRestoreRequested", shown, "targetVisible", visible,
                    "targetEnabled", enabled, "targetResponsive", responsive,
                    "hiddenRestoreMethod", desktop.HiddenRestoreMethod,
                    "applicationRestoreRequested", refreshed);
                if (!present)
                {
                    LastDiagnostic["stage"] = "windowUnavailable";
                    throw new NativeFailure("notFound", "The target window closed during activation.", LastDiagnostic);
                }
                if (repairVisible && visible && !minimized && enabled && !refreshed &&
                    desktop.FrameworkWindow(h)) {
                    refreshed = true;
                    shown = true;
                    try { desktop.Show(h); }
                    catch (NativeFailure e) {
                        LastDiagnostic["stage"] = "interactionTimeout";
                        throw new NativeFailure(e.Code, e.Message, LastDiagnostic);
                    }
                    continue;
                }
                if (matched) return;
                long timeout = desktop.HiddenRestoreMethod == "applicationActivation" ? 5000 : 2000;
                if (elapsed >= timeout)
                {
                    LastDiagnostic["stage"] = !visible ? "showTimeout" : minimized ? "restoreTimeout" :
                        !enabled || !responsive ? "interactionTimeout" : "foregroundTimeout";
                    throw new NativeFailure("focusDenied",
                        "The target window did not become interactive and foreground within the activation timeout; input was not sent. Bring the target app forward and retry.", LastDiagnostic);
                }
                // Restoring an already maximized window changes its layout and invalidates recorded coordinates.
                if (!visible && !shown) {
                    shown = true;
                    refreshed = true;
                    try { desktop.Show(h); }
                    catch (NativeFailure e) {
                        LastDiagnostic["stage"] = "showTimeout";
                        throw new NativeFailure(e.Code, e.Message, LastDiagnostic);
                    }
                }
                if (visible && minimized && !restored) { desktop.Restore(h); restored = true; }
                if (visible && !minimized && enabled && responsive && !requested) { accepted = desktop.Request(h); requested = true; }
                // SetForegroundWindow can return before the other thread processes its activation message.
                desktop.Pause();
            }
        }
        public static void BeforeInput(IntPtr h) { BeforeInput(h, new FocusDesktop()); }
        public static void BeforeInput(IntPtr h, FocusDesktop desktop)
        {
            bool present = h != IntPtr.Zero && desktop.Exists(h);
            bool enabled = present && desktop.Enabled(h);
            bool responsive = present && enabled && desktop.Responsive(h);
            bool matched = present && enabled && responsive && desktop.Visible(h) && !desktop.Minimized(h) && Matches(h, desktop);
            if (matched) return;
            var detail = LastDiagnostic == null ? Wire.Obj() : new Dictionary<string, object>(LastDiagnostic);
            detail["stage"] = "beforeInput";
            detail["foregroundMatched"] = matched;
            detail["targetPresent"] = present;
            detail["targetEnabled"] = enabled;
            detail["targetResponsive"] = responsive;
            throw new NativeFailure("focusDenied", !enabled || !responsive ?
                "目标窗口当前没有接受输入（可能正在处理对话框或没有响应）；未发送输入。" :
                "The target window lost foreground before input; input was not sent.", detail);
        }
    }
}
