using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Text;

namespace LaunchFlow.Native
{
    // Every operation reopens and pins the captured process before checking its creation time.
    // No name-based termination, process trees, or save-dialog automation.
    public static class WorkspaceClose
    {
        [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
        [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
        [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool QueryFullProcessImageName(IntPtr process, uint flags, StringBuilder path, ref int size);
        [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetProcessTimes(IntPtr process, out long created, out long exited, out long kernel, out long user);
        [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
        [DllImport("kernel32.dll", SetLastError=true)] static extern bool TerminateProcess(IntPtr process, uint code);
        [DllImport("user32.dll", SetLastError=true)] static extern bool PostMessage(IntPtr window, uint message, IntPtr w, IntPtr l);
        [DllImport("user32.dll")] static extern IntPtr GetWindow(IntPtr window, uint command);
        [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr window, int attribute, out int value, int size);
        static bool CurrentWindow(IntPtr window) {
            int cloaked;
            return DwmGetWindowAttribute(window,14,out cloaked,4)==0 && cloaked==0
                && Win.Class(window)!="Progman" && Win.Class(window)!="WorkerW";
        }
        static string Identity(IntPtr process, out string started) {
            long created,exited,kernel,user; started="";
            var path=new StringBuilder(32768);int size=path.Capacity;
            if(!QueryFullProcessImageName(process,0,path,ref size) || !GetProcessTimes(process,out created,out exited,out kernel,out user)) return "";
            started=created.ToString(System.Globalization.CultureInfo.InvariantCulture);
            return path.ToString();
        }
        static bool Protected(string path, uint pid, uint owner) {
            var name=Path.GetFileName(path).ToLowerInvariant();
            return pid<=4 || pid==owner || pid==(uint)Process.GetCurrentProcess().Id || name.StartsWith("launchflow")
                || new[]{"explorer.exe","applicationframehost.exe","shellexperiencehost.exe","startmenuexperiencehost.exe","searchhost.exe","searchapp.exe","textinputhost.exe","sihost.exe","taskmgr.exe","dwm.exe","winlogon.exe","csrss.exe","services.exe","lsass.exe","smss.exe","wininit.exe","svchost.exe","conhost.exe","dllhost.exe","runtimebroker.exe","lockapp.exe","securityhealthsystray.exe"}.Contains(name);
        }
        public static object Capture(Dictionary<string,object> request) {
            uint owner=(uint)Wire.Num(request,"ownerPid");
            var list=new List<object>();
            var windows=Desktop.Windows().Where(CurrentWindow).ToList();
            foreach(var group in windows.GroupBy(h=>{uint pid;Win.GetWindowThreadProcessId(h,out pid);return pid;})) {
                var handle=OpenProcess(0x101000,false,group.Key);
                string started="",path="";
                if(handle!=IntPtr.Zero) {try{path=Identity(handle,out started);}finally{CloseHandle(handle);}}
                string blocked=path==""?"无法核实程序身份或无权读取进程":Protected(path,group.Key,owner)?"系统组件或 LaunchFlow，已保护":null;
                var target=Wire.Obj("pid",group.Key,"started",started,"executable",path,"handles",group.Select(h=>h.ToInt64().ToString()).ToArray());
                list.Add(Wire.Obj("executable",path,"name",path==""?"无法识别的应用 ("+group.Key+")":Path.GetFileNameWithoutExtension(path),"windows",group.Select(Win.Title).ToArray(),"blocked",blocked,"target",target));
            }
            return list.ToArray();
        }
        public static object Execute(Dictionary<string,object> request) {
            var results=ExecuteLocal(request,null);
            return CompleteAuthorization(request,results,WorkspaceCloseElevation.Request).ToArray();
        }
        internal static List<Dictionary<string,object>> CompleteAuthorization(Dictionary<string,object> request,List<Dictionary<string,object>> results,Func<Dictionary<string,object>,object> authorize) {
            var targets=Wire.List(Wire.Get(request,"targets")).ToList();
            if(Wire.Str(request,"action")!="status") {
                var denied=results.Select((r,i)=>new{Row=r,Index=i}).Where(x=>Wire.Bool(x.Row,"permissionRequired")).ToList();
                if(denied.Count>0) {
                    var retry=new Dictionary<string,object>(request);
                    retry["targets"]=denied.Select(x=>Wire.Get(x.Row,"retryTarget")??targets[x.Index]).ToArray();
                    try {
                        var elevated=Wire.List(authorize(retry)).Select(Wire.Map).ToList();
                        if(elevated.Count!=denied.Count)throw new NativeFailure("closeFailed","管理员关闭结果不完整，请检查退出状态。");
                        for(int i=0;i<denied.Count;i++)results[denied[i].Index]=elevated[i];
                    } catch(NativeFailure e) {
                        foreach(var row in denied){row.Row["state"]="failed";row.Row["message"]=e.Message;}
                    }
                }
            }
            foreach(var row in results){row.Remove("permissionRequired");row.Remove("retryTarget");}
            return results;
        }
        public static List<Dictionary<string,object>> ExecuteLocal(Dictionary<string,object> request,Func<bool> authorized) {
            string action=Wire.Str(request,"action");
            if(!new[]{"graceful","status","force"}.Contains(action)) throw new NativeFailure("invalidRequest","Invalid close action.");
            var results=new List<Dictionary<string,object>>();uint owner=(uint)Wire.Num(request,"ownerPid");
            foreach(var value in Wire.List(Wire.Get(request,"targets"))) {
                var t=Wire.Map(value);uint pid=(uint)Wire.Num(t,"pid");
                if(authorized!=null && !authorized()) {results.Add(Wire.Obj("pid",pid,"state","failed","message","授权请求已过期或调用方已退出，未继续关闭。"));continue;}
                string state="pending",message="仍在运行；请处理保存提示，或稍后重新检查。";
                bool permission=false;object retryTarget=null;
                // SYNCHRONIZE keeps exit checks reliable; PROCESS_TERMINATE only for explicit fallback.
                var p=OpenProcess(0x101000u|(action=="force"?1u:0u),false,pid);
                if(p==IntPtr.Zero) {
                    int code=Marshal.GetLastWin32Error();
                    state=code==87?"closed":"failed";permission=code==5;message=code==87?"进程已退出":"没有关闭权限（Windows "+code+"）。请检查 Windows 授权或应用保护设置。";
                } else try {
                    string started;string path=Identity(p,out started);
                    if(WaitForSingleObject(p,0)==0) {state="closed";message="进程已退出";}
                    else if(path=="" || started!=Wire.Str(t,"started") || !String.Equals(path,Wire.Str(t,"executable"),StringComparison.OrdinalIgnoreCase) || Protected(path,pid,owner)) {state="stale";message="进程身份已变化或受到保护，请重新捕获。";}
                    else {
                        var handles=Wire.List(Wire.Get(t,"handles")).Select(v=>new IntPtr(Int64.Parse(Convert.ToString(v)))).ToList();
                        var actual=Desktop.Windows().Where(h=>{uint id;Win.GetWindowThreadProcessId(h,out id);return id==pid;}).ToList();
                        // Additional windows may contain new work or belong to another virtual desktop.
                        if(action=="force" && actual.Any(h=>!CurrentWindow(h) || !handles.Contains(h))) {state="stale";message="应用出现新窗口或其他桌面窗口；请重新捕获并正常关闭。";}
                        else if(action=="force") {
                            if(TerminateProcess(p,1)) {state=WaitForSingleObject(p,1000)==0?"closed":"pending";message=state=="closed"?"已强制关闭":"已请求强制关闭，等待退出。";}
                            else {int code=Marshal.GetLastWin32Error();permission=code==5;state="failed";message="强制关闭失败（Windows "+code+"）。";}
                        } else if(action=="graceful") {
                            bool sent=false;int error=0;
                            var deniedHandles=new List<string>();
                            // Only unowned top-level windows: never dismiss a newly opened save dialog.
                            foreach(var h in handles.Where(h=>actual.Contains(h) && CurrentWindow(h) && GetWindow(h,4)==IntPtr.Zero)) {
                                uint id;Win.GetWindowThreadProcessId(h,out id);
                                if(id==pid) {if(PostMessage(h,0x10,IntPtr.Zero,IntPtr.Zero))sent=true;else {error=Marshal.GetLastWin32Error();if(error==5)deniedHandles.Add(h.ToInt64().ToString());}}
                            }
                            if(deniedHandles.Count>0) {
                                permission=true;state="failed";message="需要 Windows 管理员授权才能正常关闭此应用。";
                                var retry=new Dictionary<string,object>(t);retry["handles"]=deniedHandles.ToArray();retryTarget=retry;
                            } else if(!sent) {state="failed";message="未找到可正常关闭的原窗口，请处理弹窗或重新捕获。";}
                        }
                    }
                } finally {CloseHandle(p);}
                results.Add(Wire.Obj("pid",pid,"state",state,"message",message,"permissionRequired",permission,"retryTarget",retryTarget));
            }
            return results;
        }
    }
}
