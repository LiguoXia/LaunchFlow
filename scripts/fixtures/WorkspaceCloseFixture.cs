using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Windows.Forms;
class WorkspaceCloseFixture {
    [DllImport("user32.dll")] static extern bool RegisterHotKey(IntPtr window,int id,uint modifiers,uint key);
    [DllImport("user32.dll")] static extern void keybd_event(byte code,byte scan,uint flags,UIntPtr extra);
    [STAThread] static void Main(string[] args) {
        if(args[0]=="reserve") {
            if(!RegisterHotKey(IntPtr.Zero,1,0x4007,0x79))Environment.Exit(3);
            File.WriteAllText(args[1],"ready");Application.Run();return;
        }
        if(args[0]=="hotkey") {
            byte[] keys={0x11,0x12,0x10,0x78};
            foreach(var key in keys)keybd_event(key,0,0,UIntPtr.Zero);
            Array.Reverse(keys);foreach(var key in keys)keybd_event(key,0,2,UIntPtr.Zero);return;
        }
        var form=new Form {Text="LF Close Fixture "+args[0],Width=460,Height=170};
        form.Controls.Add(new Label {Text="LaunchFlow 独立关闭验收程序 · "+args[0],Dock=DockStyle.Fill});
        form.FormClosing+=(s,e)=>{File.AppendAllText(args[1],"close\n");if(args[0]=="hold")e.Cancel=true;};
        var timer=new Timer {Interval=100};
        timer.Tick+=(s,e)=>{if(File.Exists(args[1]+".new")){File.Delete(args[1]+".new");new Form {Text="LF Close Fixture new window",Width=300,Height=100}.Show();}};
        timer.Start();
        Application.Run(form);
    }
}
