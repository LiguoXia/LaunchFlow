using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.IO.Pipes;
using System.Linq;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;

namespace LaunchFlow.Native
{
    // One explicit UAC consent per denied batch. No service, stored credential or persistent task.
    public static class WorkspaceCloseElevation
    {
        [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetNamedPipeClientProcessId(IntPtr pipe,out uint pid);
        [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetNamedPipeServerProcessId(IntPtr pipe,out uint pid);
        static NativeFailure Failure(string message) { return new NativeFailure("workspaceCloseAuthorization",message); }
        static string Read(StreamReader reader) {
            var read=reader.ReadLineAsync();
            if(!read.Wait(15000) || read.Result==null || read.Result.Length>1048576)
                throw Failure("管理员关闭助手未返回有效结果，请检查退出状态后再操作。");
            return read.Result;
        }
        public static object Request(Dictionary<string,object> request) {
            if(Thread.CurrentThread.GetApartmentState()!=ApartmentState.STA) {
                object result=null;Exception failure=null;
                var thread=new Thread(()=>{try{result=Request(request);}catch(Exception e){failure=e;}});
                thread.SetApartmentState(ApartmentState.STA);thread.Start();thread.Join();
                if(failure!=null)throw failure;
                return result;
            }
            string payload=Wire.Json.Serialize(request);
            if(payload.Length>1048576)throw Failure("关闭请求过长，请减少本次选择的应用。");
            string helper=Path.Combine(Path.GetDirectoryName(Assembly.GetExecutingAssembly().Location),"launchflow-authorized.exe");
            if(!File.Exists(helper))throw Failure("管理员关闭助手缺失，请重新安装完整版本。");
            string name="LaunchFlow-Close-"+Guid.NewGuid().ToString("N");
            var acl=new PipeSecurity();acl.SetAccessRuleProtection(true,false);
            acl.AddAccessRule(new PipeAccessRule(WindowsIdentity.GetCurrent().User,PipeAccessRights.FullControl,AccessControlType.Allow));
            using(var pipe=new NamedPipeServerStream(name,PipeDirection.InOut,1,PipeTransmissionMode.Byte,PipeOptions.Asynchronous,4096,4096,acl))
            using(var self=Process.GetCurrentProcess()) {
                var connection=pipe.BeginWaitForConnection(null,null);
                try {
                    using(var child=Process.Start(new ProcessStartInfo(helper,"--close-workspace "+name+" "+self.Id+" "+self.StartTime.ToUniversalTime().Ticks) {
                        UseShellExecute=true,Verb="runas",WindowStyle=ProcessWindowStyle.Hidden
                    })) {
                        if(child==null || !connection.AsyncWaitHandle.WaitOne(5000))throw Failure("未连接管理员关闭助手；请使用当前账户授权，或检查系统策略。");
                        pipe.EndWaitForConnection(connection);
                        uint sender;
                        if(!GetNamedPipeClientProcessId(pipe.SafePipeHandle.DangerousGetHandle(),out sender) || sender!=child.Id)
                            throw Failure("管理员关闭助手身份不匹配，未继续操作。");
                        using(var reader=new StreamReader(pipe,Encoding.UTF8,false,4096,true))
                        using(var writer=new StreamWriter(pipe,new UTF8Encoding(false),4096,true){AutoFlush=true}) {
                            var ready=Wire.Map(Wire.Json.DeserializeObject(Read(reader)));
                            if(!Wire.Bool(ready,"ready"))throw Failure("管理员关闭助手未就绪。");
                            writer.WriteLine(payload);
                            var response=Wire.Map(Wire.Json.DeserializeObject(Read(reader)));
                            if(!Wire.Bool(response,"ok"))throw Failure(Wire.Str(response,"message","管理员关闭失败，请检查退出状态。"));
                            return Wire.Get(response,"result");
                        }
                    }
                } catch(System.ComponentModel.Win32Exception e) {
                    if(e.NativeErrorCode==1223)throw Failure("已取消 Windows 管理员授权；这些应用未继续关闭，可再次点击一键关闭重试。");
                    throw Failure("Windows 未允许管理员关闭（错误码 "+e.NativeErrorCode+"）。请检查账户权限与系统策略。");
                } catch(NativeFailure) {throw;}
                catch(Exception e) {throw Failure("管理员关闭通信失败（"+e.GetType().Name+" / 0x"+e.HResult.ToString("X8")+"）。请检查退出状态后重试。");}
            }
        }
        public static int Run(string name,string pidText,string started) {
            try {
                int pid;
                if(!Regex.IsMatch(name,"\\ALaunchFlow-Close-[a-f0-9]{32}\\z") || !Int32.TryParse(pidText,out pid))return 11;
                if(!new WindowsPrincipal(WindowsIdentity.GetCurrent()).IsInRole(WindowsBuiltInRole.Administrator))return 10;
                using(var parent=Process.GetProcessById(pid)) {
                    string expected=Path.Combine(Path.GetDirectoryName(Assembly.GetExecutingAssembly().Location),"launchflow-automation.exe");
                    if(parent.HasExited || parent.StartTime.ToUniversalTime().Ticks.ToString()!=started || parent.SessionId!=Process.GetCurrentProcess().SessionId ||
                        !String.Equals(parent.MainModule.FileName,expected,StringComparison.OrdinalIgnoreCase))return 11;
                    using(var pipe=new NamedPipeClientStream(".",name,PipeDirection.InOut,PipeOptions.Asynchronous)) {
                        pipe.Connect(5000);uint server;
                        if(!GetNamedPipeServerProcessId(pipe.SafePipeHandle.DangerousGetHandle(),out server) || server!=pid)return 11;
                        using(var reader=new StreamReader(pipe,Encoding.UTF8,false,4096,true))
                        using(var writer=new StreamWriter(pipe,new UTF8Encoding(false),4096,true){AutoFlush=true}) {
                            writer.WriteLine(Wire.Json.Serialize(Wire.Obj("ready",true)));
                            var request=Wire.Map(Wire.Json.DeserializeObject(Read(reader)));
                            var action=Wire.Str(request,"action");
                            if(Wire.Str(request,"op")!="workspaceClose" || (action!="graceful" && action!="force") || Wire.List(Wire.Get(request,"targets")).Count()>256)return 11;
                            var deadline=DateTime.UtcNow.AddSeconds(20);
                            var results=WorkspaceClose.ExecuteLocal(request,()=>!parent.HasExited && DateTime.UtcNow<deadline);
                            writer.WriteLine(Wire.Json.Serialize(Wire.Obj("ok",true,"result",results)));
                        }
                    }
                }
                return 0;
            } catch {return 12;}
        }
    }
}
