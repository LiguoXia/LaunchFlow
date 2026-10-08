using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Linq;
using System.Runtime.InteropServices;

namespace LaunchFlow.Native
{
    public static class WorkspaceDesktop
    {
        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        struct MonitorInfo { public int size; public Win.RECT bounds, work; public uint flags; [MarshalAs(UnmanagedType.ByValTStr, SizeConst=32)] public string device; }
        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        struct DisplayDevice { public int size; [MarshalAs(UnmanagedType.ByValTStr, SizeConst=32)] public string name; [MarshalAs(UnmanagedType.ByValTStr, SizeConst=128)] public string description; public uint flags; [MarshalAs(UnmanagedType.ByValTStr, SizeConst=128)] public string id; [MarshalAs(UnmanagedType.ByValTStr, SizeConst=128)] public string key; }
        [StructLayout(LayoutKind.Sequential)]
        struct Placement { public int size; public uint flags, show; public Win.POINT min, max; public Win.RECT normal; }
        delegate bool MonitorCallback(IntPtr monitor, IntPtr dc, IntPtr rect, IntPtr data);
        [DllImport("user32.dll")] static extern bool EnumDisplayMonitors(IntPtr dc, IntPtr clip, MonitorCallback callback, IntPtr data);
        [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern bool GetMonitorInfo(IntPtr monitor, ref MonitorInfo info);
        [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern bool EnumDisplayDevices(string device, uint index, ref DisplayDevice info, uint flags);
        [DllImport("shcore.dll")] static extern int GetDpiForMonitor(IntPtr monitor, int type, out uint x, out uint y);
        [DllImport("user32.dll")] static extern IntPtr MonitorFromWindow(IntPtr window, uint flags);
        [DllImport("user32.dll")] static extern bool GetWindowPlacement(IntPtr window, ref Placement placement);
        [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr window, int attribute, out int value, int size);
        static Dictionary<string,object> Rect(Win.RECT r) { return Win.Rect(r.Left,r.Top,r.Right-r.Left,r.Bottom-r.Top); }
        static MonitorInfo Monitor(IntPtr handle) {
            var info=new MonitorInfo(); info.size=Marshal.SizeOf(info);
            if(!GetMonitorInfo(handle,ref info)) throw new NativeFailure("displayUnavailable","Display information is unavailable.");
            return info;
        }
        static Dictionary<string,object> Descriptor(IntPtr handle) {
            var info=Monitor(handle);
            var device=new DisplayDevice();device.size=Marshal.SizeOf(device);
            bool found=EnumDisplayDevices(info.device,0,ref device,1);
            uint dx=96,dy=96;
            try { GetDpiForMonitor(handle,0,out dx,out dy); } catch { }
            return Wire.Obj("id",found && !String.IsNullOrEmpty(device.id)?device.id:info.device,"name",found?device.description:info.device,"bounds",Rect(info.bounds),"workArea",Rect(info.work),"scale",dx/96.0,"primary",(info.flags&1)!=0);
        }
        public static object Displays() {
            var list=new List<object>();
            EnumDisplayMonitors(IntPtr.Zero,IntPtr.Zero,delegate(IntPtr h,IntPtr dc,IntPtr r,IntPtr data) {list.Add(Descriptor(h));return true;},IntPtr.Zero);
            return list.ToArray();
        }
        public static object Capture() {
            var list=new List<object>();
            foreach(var h in Desktop.Windows()) {
                int cloaked=0; DwmGetWindowAttribute(h,14,out cloaked,4);
                if(cloaked!=0 || Win.Class(h)=="Progman" || Win.Class(h)=="WorkerW") continue;
                var item=Desktop.WindowInfo(h); string executable="";string started=null;
                try { using(var p=Process.GetProcessById((int)Wire.Num(item,"pid"))) {executable=p.MainModule.FileName;started=p.StartTime.ToUniversalTime().ToString("o");} } catch { }
                var monitor=MonitorFromWindow(h,2);var info=Monitor(monitor);
                var placement=new Placement();placement.size=Marshal.SizeOf(placement);
                var normal=Wire.Map(item["bounds"]);
                if(GetWindowPlacement(h,ref placement)) {
                    // WINDOWPLACEMENT uses workspace coordinates; convert to screen coordinates.
                    var r=placement.normal;int dx=info.work.Left-info.bounds.Left,dy=info.work.Top-info.bounds.Top;
                    r.Left+=dx;r.Right+=dx;r.Top+=dy;r.Bottom+=dy;normal=Rect(r);
                }
                item["normalBounds"]=normal;item["executable"]=executable;item["startedAt"]=started;item["displayId"]=Descriptor(monitor)["id"];
                list.Add(item);
            }
            return Wire.Obj("displays",Displays(),"windows",list.ToArray());
        }
        public static object Restore(Dictionary<string,object> request) {
            var h=Desktop.FindWindow(Wire.Map(Wire.Get(request,"window")));
            var b=Wire.Map(Wire.Get(request,"bounds"));
            double x=Wire.Num(b,"x"),y=Wire.Num(b,"y"),w=Wire.Num(b,"width"),height=Wire.Num(b,"height");
            if(new[]{x,y,w,height}.Any(n=>Double.IsNaN(n)||Double.IsInfinity(n)||Math.Abs(n)>100000) || w<=0 || height<=0) throw new NativeFailure("invalidRequest","Invalid layout bounds.");
            Win.ShowWindow(h,9);
            if(!Win.SetWindowPos(h,IntPtr.Zero,(int)Math.Round(x),(int)Math.Round(y),(int)Math.Round(w),(int)Math.Round(height),0x14)) throw new NativeFailure("permissionDenied","The window could not be moved. An elevated target may require an explicitly elevated LaunchFlow session.");
            string state=Wire.Str(request,"state");
            if(state=="maximized")Win.ShowWindow(h,3);else if(state=="minimized")Win.ShowWindow(h,6);
            return Desktop.WindowInfo(h);
        }
    }
}
