// Read only the synthetic text just written by the clipboard acceptance test.
using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading;
using System.Windows.Forms;
class ClipboardFixture
{
    [DllImport("user32.dll")] static extern bool OpenClipboard(IntPtr owner);
    [DllImport("user32.dll")] static extern bool CloseClipboard();
    [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr window, int command);
    [STAThread] static void Main(string[] args)
    {
        Console.OutputEncoding=new System.Text.UTF8Encoding(false);
        if(args.Length==2 && args[0]=="paste") {
            using(var form=new Form {Text="LaunchFlow Clipboard Paste Fixture",Width=650,Height=320}) {
                var input=new TextBox {Multiline=true,AcceptsReturn=true,Dock=DockStyle.Fill};
                form.Controls.Add(input);
                input.TextChanged+=delegate {File.WriteAllText(args[1],new System.Web.Script.Serialization.JavaScriptSerializer().Serialize(input.Text));};
                form.Shown+=delegate {ShowWindow(form.Handle,5);input.Focus();File.WriteAllText(args[1],"\"\"");};
                form.Activated+=delegate {input.Focus();};
                Application.Run(form);
            }
            return;
        }
        if(args.Length==0) {
            var json=new System.Web.Script.Serialization.JavaScriptSerializer();
            Console.WriteLine(json.Serialize(Clipboard.GetText(TextDataFormat.UnicodeText)));
            return;
        }
        using(var owner=new Form()) {
            if(!OpenClipboard(owner.Handle)) throw new Exception("Could not hold test clipboard");
            try { File.WriteAllText(args[0],"locked"); Thread.Sleep(3000); }
            finally { CloseClipboard(); }
        }
    }
}
