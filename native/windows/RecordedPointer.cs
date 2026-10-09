using System;
using System.Collections.Generic;
namespace LaunchFlow.Native
{
    public static class RecordedPointer
    {
        // Use the geometry captured at mouse-down, before the click changes the UI.
        public static Dictionary<string, object> Locator(Dictionary<string, object> window, double x, double y)
        {
            var bounds = Wire.Map(Wire.Get(window, "bounds"));
            double left = Wire.Num(bounds, "x"), top = Wire.Num(bounds, "y"),
                width = Wire.Num(bounds, "width"), height = Wire.Num(bounds, "height");
            if (width <= 0 || height <= 0 || Double.IsNaN(x) || Double.IsNaN(y) ||
                x < left || y < top || x >= left + width || y >= top + height)
                throw new NativeFailure("invalidCoordinates", "The recorded point is outside the target window.");
            return Wire.Obj("kind", "relativeCoordinate", "window",
                Wire.Obj("application", Wire.Str(window, "application"), "title", Wire.Str(window, "title"),
                    "className", Wire.Str(window, "className").StartsWith("HwndWrapper[") ? "" : Wire.Str(window, "className")),
                "x", (x - left) / width, "y", (y - top) / height);
        }
        public static bool NeedsPoint(Dictionary<string, object> element)
        {
            var role = Wire.Str(element, "role");
            return role == "Window" || (!Wire.Bool(element, "clickable") &&
                (role == "Pane" || role == "Custom" || role == "Group"));
        }
        public static bool CanCoalesce(string kind)
        {
            // Two clicks on one canvas (even at the same position) are distinct inputs.
            return kind == "inputText" || kind == "inputSecret";
        }
    }
}
