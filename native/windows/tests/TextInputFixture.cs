using System;
using System.IO;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Automation;
using System.Windows.Automation.Peers;
using System.Windows.Automation.Provider;
using System.Windows.Threading;
using LaunchFlow.Native;

sealed class TextOnlyBox : TextBox
{
    protected override AutomationPeer OnCreateAutomationPeer() { return new TextOnlyPeer(this); }
}
sealed class TextOnlyPeer : TextBoxAutomationPeer, IValueProvider
{
    public TextOnlyPeer(TextOnlyBox owner) : base(owner) { }
    // Reproduce a provider advertising ValuePattern but not actually applying SetValue.
    public override object GetPattern(PatternInterface pattern) { return pattern == PatternInterface.Value ? this : base.GetPattern(pattern); }
    bool IValueProvider.IsReadOnly { get { return false; } }
    string IValueProvider.Value { get { return ""; } }
    void IValueProvider.SetValue(string value) { }
}
class TextInputFixture
{
    [STAThread] static int Main(string[] args)
    {
        Win.SetProcessDpiAwarenessContext(new IntPtr(-4));
        var app = new Application();
        var window = new Window {Title="LaunchFlow Chinese Text Fixture", Width=620, Height=260, Left=160, Top=200};
        var box = new TextOnlyBox {Margin=new Thickness(35), FontSize=22, AcceptsReturn=true};
        AutomationProperties.SetAutomationId(box, "chinese-input");
        AutomationProperties.SetName(box, "Empty input");
        box.TextChanged += delegate {
            AutomationProperties.SetName(box, box.Text);
            File.WriteAllText(args[0] + ".txt", box.Text);
        };
        window.Content=box;
        window.Loaded += delegate { box.Focus(); File.WriteAllText(args[0]+".txt", box.Text); };
        var timer = new DispatcherTimer {Interval=TimeSpan.FromMilliseconds(100)};
        timer.Tick += delegate {
            if(File.Exists(args[0]+".stop")) window.Close();
            if(File.Exists(args[0]+".append") && box.IsKeyboardFocused && Win.GetForegroundWindow() == new System.Windows.Interop.WindowInteropHelper(window).Handle) {
                var committed=File.ReadAllText(args[0]+".append");File.Delete(args[0]+".append");
                var keys=new System.Collections.Generic.List<Win.INPUT>();
                foreach(char c in committed) {keys.Add(Win.Key(c,false,true));keys.Add(Win.Key(c,true,true));}
                var ownHandle = new System.Windows.Interop.WindowInteropHelper(window).Handle;
                System.Threading.ThreadPool.QueueUserWorkItem(delegate {
                    if (Win.GetForegroundWindow() == ownHandle) Win.Send(keys);
                });
            }
        };
        timer.Start(); app.Run(window); timer.Stop(); return 0;
    }
}
