using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;

namespace LaunchFlow.Native {
    public static class Vault {
        const string Prefix="LaunchFlow/v1/";
        [StructLayout(LayoutKind.Sequential,CharSet=CharSet.Unicode)]
        struct Credential {
            public uint flags,type;
            public string target,comment;
            public System.Runtime.InteropServices.ComTypes.FILETIME modified;
            public uint size;
            public IntPtr blob;
            public uint persist,attributeCount;
            public IntPtr attributes;
            public string alias,user;
        }
        [DllImport("advapi32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool CredWriteW(ref Credential credential,uint flags);
        [DllImport("advapi32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool CredReadW(string target,uint type,uint flags,out IntPtr credential);
        [DllImport("advapi32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool CredDeleteW(string target,uint type,uint flags);
        [DllImport("advapi32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool CredEnumerateW(string filter,uint flags,out uint count,out IntPtr credentials);
        [DllImport("advapi32.dll")] static extern void CredFree(IntPtr buffer);
        static NativeFailure Error(int code) { return new NativeFailure(code==1168?"secretMissing":"vaultUnavailable",code==1168?"The secret reference is not available on this device.":"Windows Credential Manager could not complete the operation."); }
        static object Metadata(Credential c) {
            long time=((long)c.modified.dwHighDateTime<<32)|(uint)c.modified.dwLowDateTime;
            return Wire.Obj("id",c.target.Substring(Prefix.Length),"label",c.comment??"","updatedAt",DateTime.FromFileTimeUtc(time).ToString("o"));
        }
        public static object Dispatch(Dictionary<string,object> request) {
            string action=Wire.Str(request,"action"),id=Wire.Str(request,"id");
            if(action=="list") {
                uint count;IntPtr entries;
                if(!CredEnumerateW(Prefix+"*",0,out count,out entries)) {int code=Marshal.GetLastWin32Error();if(code==1168)return new object[0];throw Error(code);}
                try {var result=new List<object>();for(int i=0;i<count;i++){var p=Marshal.ReadIntPtr(entries,i*IntPtr.Size);var c=(Credential)Marshal.PtrToStructure(p,typeof(Credential));if(c.type==1&&c.target.StartsWith(Prefix,StringComparison.Ordinal))result.Add(Metadata(c));}return result.ToArray();}finally{CredFree(entries);}
            }
            if(!Regex.IsMatch(id,@"\A[A-Za-z0-9_.-]{1,64}\z")) throw new NativeFailure("invalidRequest","Secret IDs must contain 1–64 letters, digits, dots, underscores or hyphens.");
            string target=Prefix+id;
            if(action=="delete") {if(!CredDeleteW(target,1,0))throw Error(Marshal.GetLastWin32Error());return Wire.Obj("deleted",true);}
            if(action=="read") {
                IntPtr p;if(!CredReadW(target,1,0,out p))throw Error(Marshal.GetLastWin32Error());
                try {var c=(Credential)Marshal.PtrToStructure(p,typeof(Credential));if(c.size>2560)throw new NativeFailure("invalidSecret","Secret exceeds the supported size.");var bytes=new byte[c.size];try{Marshal.Copy(c.blob,bytes,0,bytes.Length);return Wire.Obj("value",Encoding.UTF8.GetString(bytes));}finally{Array.Clear(bytes,0,bytes.Length);}}finally{CredFree(p);}
            }
            if(action!="create"&&action!="update")throw new NativeFailure("invalidRequest","Unknown vault action.");
            IntPtr existing;bool exists=CredReadW(target,1,0,out existing);int readError=Marshal.GetLastWin32Error();if(exists)CredFree(existing);else if(readError!=1168)throw Error(readError);
            if(action=="create"&&exists)throw new NativeFailure("secretExists","This secret ID already exists. Choose Update to replace it.");
            if(action=="update"&&!exists)throw Error(1168);
            var data=Encoding.UTF8.GetBytes(Wire.Str(request,"value"));string label=Wire.Str(request,"label");
            if(data.Length==0||data.Length>2560||label.Length>80)throw new NativeFailure("invalidRequest","Use a nonempty secret of at most 2560 UTF-8 bytes and a label of at most 80 characters.");
            var credential=new Credential{type=1,target=target,comment=label,user="LaunchFlow",persist=2,size=(uint)data.Length,blob=Marshal.AllocHGlobal(data.Length)};
            try {Marshal.Copy(data,0,credential.blob,data.Length);if(!CredWriteW(ref credential,0))throw Error(Marshal.GetLastWin32Error());return Wire.Obj("saved",true);}finally{Array.Clear(data,0,data.Length);Marshal.Copy(data,0,credential.blob,data.Length);Marshal.FreeHGlobal(credential.blob);}
        }
    }
}
