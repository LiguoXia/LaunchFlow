using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

namespace LaunchFlow.Native
{
    // Read-only discovery. Nothing is opened, registered or elevated while capturing.
    public static class ApplicationDiscovery
    {
        [DllImport("shlwapi.dll", CharSet=CharSet.Unicode)]
        static extern int AssocQueryString(uint flags, uint kind, string association, string extra, StringBuilder value, ref uint length);
        [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
        [DllImport("kernel32.dll", CharSet=CharSet.Unicode)] static extern bool QueryFullProcessImageName(IntPtr process, uint flags, StringBuilder path, ref uint size);
        [DllImport("kernel32.dll", CharSet=CharSet.Unicode)] static extern int GetApplicationUserModelId(IntPtr process, ref uint size, StringBuilder id);
        [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
        static string Explorer { get { return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Windows), "explorer.exe"); } }
        static string Assoc(string association, uint kind)
        {
            uint size = 32768;
            var value = new StringBuilder((int)size);
            // ASSOCF_IS_PROTOCOL for http/https/mailto; extensions use per-user defaults.
            return AssocQueryString(association.StartsWith(".") ? 0u : 0x1000u, kind, association, null, value, ref size) == 0 ? value.ToString() : "";
        }
        static string Property(dynamic item, string name) { try { return Convert.ToString(item.ExtendedProperty(name)) ?? ""; } catch { return ""; } }
        static string Friendly(string path)
        {
            try { var text=FileVersionInfo.GetVersionInfo(path).FileDescription; if(!String.IsNullOrWhiteSpace(text)) return text; } catch { }
            return Path.GetFileNameWithoutExtension(path);
        }
        static Dictionary<string,object> Candidate(string name, string path, string appId, string category, string unavailable = "")
        {
            bool packaged = !String.IsNullOrEmpty(appId) && appId.Contains("!");
            return Wire.Obj("name", name, "executable", packaged ? Explorer : path,
                "arguments", packaged ? new [] { "shell:AppsFolder\\" + appId } : new string[0],
                "processName", packaged ? "" : Path.GetFileName(path), "category", category, "unavailable", unavailable);
        }
        static object Capture(string source)
        {
            var rows = new List<object>();
            if (source == "workspace") {
                foreach (var group in Desktop.Windows().Select(Desktop.WindowInfo).GroupBy(w => Convert.ToUInt32(w["pid"]))) {
                    var handle = OpenProcess(0x1000, false, group.Key);
                    string path = "", appId = "";
                    if (handle != IntPtr.Zero) try {
                        uint size = 32768; var buffer = new StringBuilder((int)size);
                        if(QueryFullProcessImageName(handle, 0, buffer, ref size)) path = buffer.ToString();
                        size = 1024; buffer = new StringBuilder((int)size);
                        if(GetApplicationUserModelId(handle, ref size, buffer) == 0) appId = buffer.ToString();
                    } finally { CloseHandle(handle); }
                    var name = Path.GetFileName(path);
                    if (new [] { "launchflow.exe", "launchflow-automation.exe", "applicationframehost.exe", "shellexperiencehost.exe", "startmenuexperiencehost.exe", "searchhost.exe", "textinputhost.exe" }.Contains(name.ToLowerInvariant())) continue;
                    rows.Add(Candidate(path == "" ? Wire.Str(group.First(), "application") : Friendly(path), path, appId,
                        "工作区 · " + group.Count() + " 个窗口", path == "" ? "无法读取应用路径，请手动添加" : ""));
                }
                return Wire.Obj("apps", rows.ToArray(), "warnings", new string[0]);
            }
            if (source != "system") throw new NativeFailure("invalidRequest", "Unknown application capture source.");
            var warnings = new List<string>();
            var packagedNames = new Dictionary<string,string>(StringComparer.OrdinalIgnoreCase);
            // AppsFolder exposes only apps registered for this user, including Store applications.
            object shell = null, folder = null, items = null;
            try {
                shell = Activator.CreateInstance(Type.GetTypeFromProgID("Shell.Application"));
                folder = ((dynamic)shell).NameSpace("shell:AppsFolder");
                items = ((dynamic)folder).Items();
                int count = (int)((dynamic)items).Count;
                for (int i=0; i<count && i<2048; i++) {
                    object item = ((dynamic)items).Item(i);
                    try {
                        string appId = Property(item, "System.AppUserModel.ID");
                        if (appId == "") appId = Convert.ToString(((dynamic)item).Path);
                        if (String.IsNullOrEmpty(appId) || !appId.Contains("!")) continue;
                        string name = Convert.ToString(((dynamic)item).Name);
                        packagedNames[appId] = name;
                        if (new [] { "Microsoft.WindowsNotepad_", "Microsoft.Paint_", "Microsoft.WindowsCalculator_", "Microsoft.Windows.Photos_", "Microsoft.ScreenSketch_", "Microsoft.ZuneMusic_", "Microsoft.ZuneVideo_", "Microsoft.WindowsTerminal_", "Microsoft.WindowsSoundRecorder_", "Microsoft.OutlookForWindows_", "Microsoft.WindowsStore_" }.Any(prefix => appId.StartsWith(prefix, StringComparison.OrdinalIgnoreCase)))
                            rows.Add(Candidate(name, "", appId, "Windows 内置应用"));
                    } finally { if (Marshal.IsComObject(item)) Marshal.ReleaseComObject(item); }
                }
            } catch { warnings.Add("部分商店应用未能读取，已保留其他可捕获应用。"); }
            finally {
                foreach(var value in new [] { items, folder, shell }) if(value != null && Marshal.IsComObject(value)) Marshal.ReleaseComObject(value);
            }
            string windows = Environment.GetFolderPath(Environment.SpecialFolder.Windows);
            var builtins = new [] {
                new [] { "记事本", "System32\\notepad.exe", "Microsoft.WindowsNotepad_" },
                new [] { "计算器", "System32\\calc.exe", "Microsoft.WindowsCalculator_" },
                new [] { "画图", "System32\\mspaint.exe", "Microsoft.Paint_" },
                new [] { "截图工具", "System32\\SnippingTool.exe", "Microsoft.ScreenSketch_" },
                new [] { "文件资源管理器", "explorer.exe", "" },
                new [] { "任务管理器", "System32\\Taskmgr.exe", "" },
                new [] { "远程桌面连接", "System32\\mstsc.exe", "" },
                new [] { "命令提示符", "System32\\cmd.exe", "" },
                new [] { "Windows PowerShell", "System32\\WindowsPowerShell\\v1.0\\powershell.exe", "" }
            };
            foreach (var builtin in builtins) {
                if (builtin[2] != "" && packagedNames.Keys.Any(id => id.StartsWith(builtin[2], StringComparison.OrdinalIgnoreCase))) continue;
                string path = Path.Combine(windows, builtin[1]);
                if (File.Exists(path)) rows.Add(Candidate(builtin[0], path, "", "Windows 内置应用"));
            }
            foreach (var association in new [] { new [] { "https", "默认浏览器 (HTTPS)" }, new [] { "http", "默认浏览器 (HTTP)" }, new [] { "mailto", "默认邮件" }, new [] { ".jpg", "默认图片查看器" }, new [] { ".png", "默认 PNG 查看器" }, new [] { ".mp3", "默认音乐播放器" }, new [] { ".mp4", "默认视频播放器" }, new [] { ".pdf", "默认 PDF 阅读器" }, new [] { ".txt", "默认文本编辑器" } }) {
                string appId = Assoc(association[0], 21); // ASSOCSTR_APPID
                string path = Assoc(association[0], 2); // ASSOCSTR_EXECUTABLE
                string name = Assoc(association[0], 4); // ASSOCSTR_FRIENDLYAPPNAME
                if (packagedNames.ContainsKey(appId)) name = packagedNames[appId];
                bool packaged = appId.Contains("!") && packagedNames.ContainsKey(appId);
                if (!packaged && (!File.Exists(path) || new [] { "launchwinapp.exe", "openwith.exe", "rundll32.exe" }.Contains(Path.GetFileName(path).ToLowerInvariant()))) {
                    warnings.Add(association[1] + "：未配置或无法解析可启动应用"); continue;
                }
                rows.Add(Candidate(name == "" ? Friendly(path) : name, path, packaged ? appId : "", association[1]));
            }
            return Wire.Obj("apps", rows.ToArray(), "warnings", warnings.ToArray());
        }
        public static object Discover(Dictionary<string,object> request)
        {
            object result = null; Exception error = null;
            var thread = new Thread(() => { try { result=Capture(Wire.Str(request, "source")); } catch(Exception e) { error=e; } });
            thread.SetApartmentState(ApartmentState.STA); thread.Start(); thread.Join();
            if(error != null) throw error;
            return result;
        }
    }
}
