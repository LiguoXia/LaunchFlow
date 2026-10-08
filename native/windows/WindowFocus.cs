using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Threading;

namespace LaunchFlow.Native
{
    // Injectable operations let tests reproduce delayed cross-thread activation without desktop input.
    public class FocusDesktop
    {
        readonly Stopwatch clock = Stopwatch.StartNew();
        public virtual long Milliseconds { get { return clock.ElapsedMilliseconds; } }
        public virtual bool Exists(IntPtr h) { return Win.IsWindow(h); }
        public virtual bool Minimized(IntPtr h) { return Win.IsIconic(h); }
        public virtual IntPtr Foreground() { return Win.GetForegroundWindow(); }
        public virtual void Restore(IntPtr h) { Win.ShowWindowAsync(h, 9); }
        public virtual bool Request(IntPtr h) { return Win.SetForegroundWindow(h); }
        public virtual void Pause() { Thread.Sleep(25); }
    }
    public static class WindowFocus
    {
        [ThreadStatic] public static Dictionary<string, object> LastDiagnostic;
        public static void Activate(IntPtr h) { Activate(h, new FocusDesktop()); }
        public static void Activate(IntPtr h, FocusDesktop desktop)
        {
            long start = desktop.Milliseconds;
            bool restored = false, requested = false, accepted = false;
            while (true)
            {
                bool present = h != IntPtr.Zero && desktop.Exists(h);
                bool minimized = present && desktop.Minimized(h);
                bool matched = present && !minimized && desktop.Foreground() == h;
                long elapsed = desktop.Milliseconds - start;
                LastDiagnostic = Wire.Obj("stage", matched ? "foregroundConfirmed" : "foregroundWait",
                    "elapsedMs", elapsed, "restoreRequested", restored, "activationRequested", requested,
                    "requestAccepted", accepted, "foregroundMatched", matched, "targetPresent", present);
                if (!present)
                {
                    LastDiagnostic["stage"] = "windowUnavailable";
                    throw new NativeFailure("notFound", "The target window closed during activation.", LastDiagnostic);
                }
                if (matched) return;
                if (elapsed >= 2000)
                {
                    LastDiagnostic["stage"] = minimized ? "restoreTimeout" : "foregroundTimeout";
                    throw new NativeFailure("focusDenied",
                        "The target window did not become foreground within 2 seconds; input was not sent. Bring the target app forward and retry.", LastDiagnostic);
                }
                // Restoring an already maximized window changes its layout and invalidates recorded coordinates.
                if (minimized && !restored) { desktop.Restore(h); restored = true; }
                if (!minimized && !requested) { accepted = desktop.Request(h); requested = true; }
                // SetForegroundWindow can return before the other thread processes its activation message.
                desktop.Pause();
            }
        }
        public static void BeforeInput(IntPtr h) { BeforeInput(h, new FocusDesktop()); }
        public static void BeforeInput(IntPtr h, FocusDesktop desktop)
        {
            bool present = h != IntPtr.Zero && desktop.Exists(h);
            bool matched = present && !desktop.Minimized(h) && desktop.Foreground() == h;
            if (matched) return;
            var detail = LastDiagnostic == null ? Wire.Obj() : new Dictionary<string, object>(LastDiagnostic);
            detail["stage"] = "beforeInput";
            detail["foregroundMatched"] = matched;
            detail["targetPresent"] = present;
            throw new NativeFailure("focusDenied", "The target window lost foreground before input; input was not sent.", detail);
        }
    }
}
