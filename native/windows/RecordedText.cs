using System;
using System.Collections.Generic;
using System.Threading;
using System.Linq;
using System.Windows.Automation;
namespace LaunchFlow.Native
{
    // Only the explicitly recorded window's focused edit/document is inspected.
    // Never infer Chinese text from the physical keys used by an IME.
    public sealed class RecordedText
    {
        readonly IntPtr window;
        readonly Action<string, Dictionary<string, object>, Dictionary<string, object>> append;
        readonly Action<string> warning;
        string identity = "", previous = "";
        bool armed, suppressed, warned;
        AutomationElement lastElement;
        public RecordedText(IntPtr target, Action<string, Dictionary<string, object>, Dictionary<string, object>> onText, Action<string> onWarning)
        { window = target; append = onText; warning = onWarning; }
        public static bool IsInput(AutomationElement element)
        {
            return element != null && (element.Current.ControlType == ControlType.Edit || element.Current.ControlType == ControlType.Document);
        }
        public static bool HasFocus(AutomationElement element)
        {
            if (element.Current.HasKeyboardFocus) return true;
            var focused = AutomationElement.FocusedElement;
            return focused != null && focused.GetRuntimeId().SequenceEqual(element.GetRuntimeId());
        }
        public static string Read(AutomationElement element)
        {
            if (!IsInput(element) || element.Current.IsPassword) return null;
            object pattern;
            string value = null;
            if (element.TryGetCurrentPattern(ValuePattern.Pattern, out pattern)) value = ((ValuePattern)pattern).Current.Value;
            if (String.IsNullOrEmpty(value) && element.TryGetCurrentPattern(TextPattern.Pattern, out pattern))
                value = ((TextPattern)pattern).DocumentRange.GetText(32769);
            return value != null && value.Length <= 32768 ? value : null;
        }
        public void Reset() { identity = ""; previous = ""; armed = false; suppressed = false; lastElement = null; }
        AutomationElement Focused()
        {
            if (Win.GetForegroundWindow() != window) return null;
            var element = AutomationElement.FocusedElement;
            return element != null && Desktop.ElementWindow(element) == window ? element : null;
        }
        public void BeforeKey(uint key)
        {
            try {
                if (key == 16 || key == 17 || key == 18 || key == 91 || key == 92) return;
                var element = Focused();
                if (element == null) return;
                if (element.Current.IsPassword) {
                    append("inputSecret", Desktop.Info(element, window), Wire.Obj("secretRef", "unresolved"));
                    return;
                }
                armed = true; suppressed = false;
                Poll(false);
                if (Read(element) == null && !warned) {
                    warned = true;
                    warning("当前输入框未公开可读取文字，无法可靠录制中文。停止后请检查并补充 Input Text 步骤，或重新拾取可访问的输入框。");
                }
            } catch { }
        }
        public void Boundary() { if (armed && lastElement != null) Observe(lastElement, false); armed = false; suppressed = true; }
        public void Poll(bool changedEvent)
        {
            try { Observe(Focused(), changedEvent); } catch { }
        }
        void Observe(AutomationElement element, bool changedEvent)
        {
            try {
                if (element == null || !IsInput(element) || element.Current.IsPassword || Desktop.ElementWindow(element) != window) return;
                lastElement = element;
                string value = Read(element);
                if (value == null) return;
                string current = String.Join(",", element.GetRuntimeId());
                if (identity != current) {
                    identity = current; previous = value;
                    // A focused field may first become discoverable after an IME commit.
                    if ((!armed && !changedEvent) || suppressed) return;
                } else if (previous == value) return;
                previous = value;
                if ((!armed && !changedEvent) || suppressed) return;
                var info = Desktop.Info(element, window);
                var locator = Sessions.Locator(info);
                // Editable names can contain the current text; don't locate a field by its old content.
                locator["name"] = "";
                append("inputText", info, Wire.Obj("text", value, "locators", new[] { locator }));
            } catch { }
        }
        public static bool SameText(string actual, string expected)
        {
            // Some TextPattern providers append a document terminator.
            if (actual == null) return false;
            actual = actual.Replace("\r\n", "\n"); expected = expected.Replace("\r\n", "\n");
            return actual == expected || actual == expected + "\n";
        }
        public static bool WaitForText(AutomationElement element, string expected)
        {
            for (int i = 0; i < 6; i++) {
                try { if (SameText(Read(element), expected)) return true; } catch { }
                Thread.Sleep(50);
            }
            return false;
        }
    }
}
