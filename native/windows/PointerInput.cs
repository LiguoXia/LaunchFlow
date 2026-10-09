using System;
using System.Collections.Generic;
using System.Threading;
namespace LaunchFlow.Native
{
    public static class PointerInput
    {
        [ThreadStatic] public static Dictionary<string, object> Diagnostic;
        public static void Start(string route, string role, string source)
        {
            Diagnostic = Wire.Obj("route", route, "targetRole", role, "positionSource", source,
                "stage", "targetValidation", "inputEventsSent", 0);
        }
        public static NativeFailure Failure(string code, string message)
        {
            return new NativeFailure(code, message, Wire.Obj("pointer", Diagnostic));
        }
        public static void Guard(IntPtr window, double x, double y)
        {
            WindowFocus.BeforeInput(window);
            Win.RECT r;
            if (Double.IsNaN(x) || Double.IsInfinity(x) || Double.IsNaN(y) || Double.IsInfinity(y) ||
                !Win.GetWindowRect(window, out r) || x < r.Left || x >= r.Right || y < r.Top || y >= r.Bottom)
                throw Failure("invalidCoordinates", "The click position is outside the target window; input was not sent.");
            var hit = Win.WindowFromPoint(new Win.POINT { X = (int)Math.Round(x), Y = (int)Math.Round(y) });
            bool matched = hit != IntPtr.Zero && Win.GetAncestor(hit, 2) == window;
            Diagnostic["hitTestMatched"] = matched;
            if (!matched)
                throw Failure("targetObscured", "点击位置被其他窗口遮挡；未发送点击。请移开遮挡窗口后重试。");
        }
        public static void Click(IntPtr window, double x, double y, string kind)
        {
            Guard(window, x, y);
            Win.Send(new List<Win.INPUT> { Win.Mouse(x, y, 0) });
            Diagnostic["stage"] = "pointerMoved";
            // Custom-drawn apps need to process hover before a mouse-down at the new point.
            Thread.Sleep(50);
            Guard(window, x, y);
            int count = kind == "doubleClick" ? 2 : 1;
            uint down = kind == "rightClick" ? 8u : 2u, up = kind == "rightClick" ? 16u : 4u;
            int sent = 0;
            for (int i = 0; i < count; i++)
            {
                Guard(window, x, y);
                Win.Send(new List<Win.INPUT> { Win.Mouse(x, y, down) });
                sent++;
                try { Thread.Sleep(40); }
                finally { Win.Send(new List<Win.INPUT> { Win.Mouse(x, y, up) }); sent++; }
                Diagnostic["inputEventsSent"] = sent;
            }
            // Input dispatch is observable; application-specific business effects are not inferred.
            Diagnostic["stage"] = "inputDispatched";
        }
    }
}
