using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;

namespace LaunchFlow.Native
{
    // Read shell icons without starting the application or asking for elevation.
    public static class ApplicationIcons
    {
        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        struct FileInfo
        {
            public IntPtr icon;
            public int index;
            public uint attributes;
            [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)] public string displayName;
            [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 80)] public string typeName;
        }
        [DllImport("shell32.dll", CharSet = CharSet.Unicode)]
        static extern IntPtr SHGetFileInfo(string path, uint attributes, ref FileInfo info, uint size, uint flags);
        [DllImport("user32.dll")]
        static extern bool DestroyIcon(IntPtr icon);

        static object Read(Dictionary<string, object> source)
        {
            var info = new FileInfo();
            try
            {
                string path = Wire.Str(source, "path");
                if (path.Length < 3 || !Char.IsLetter(path[0]) || path[1] != ':' ||
                    (path[2] != '\\' && path[2] != '/') || !File.Exists(path)) return null;
                path = Path.GetFullPath(path);
                if (new DriveInfo(Path.GetPathRoot(path)).DriveType == DriveType.Network) return null;
                if (SHGetFileInfo(path, 0, ref info, (uint)Marshal.SizeOf(info), 0x100) == IntPtr.Zero ||
                    info.icon == IntPtr.Zero) return null;
                using (var icon = Icon.FromHandle(info.icon))
                using (var bitmap = icon.ToBitmap())
                using (var stream = new MemoryStream())
                {
                    bitmap.Save(stream, ImageFormat.Png);
                    return Wire.Obj("path", path, "png", Convert.ToBase64String(stream.ToArray()));
                }
            }
            catch { return null; }
            finally { if (info.icon != IntPtr.Zero) DestroyIcon(info.icon); }
        }
        public static object ReadBatch(Dictionary<string, object> request)
        {
            var result = new List<object>();
            var sources = Wire.Get(request, "sources") as System.Collections.IEnumerable;
            if (sources != null) foreach (var source in sources)
            {
                if (result.Count >= 24) break;
                result.Add(Read(Wire.Map(source)));
            }
            return result.ToArray();
        }
    }
}
