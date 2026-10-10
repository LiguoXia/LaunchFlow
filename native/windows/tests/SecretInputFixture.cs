using System;
using System.IO;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Automation;
using System.Windows.Automation.Peers;
using System.Windows.Threading;
using LaunchFlow.Native;

sealed class RawPasswordBox : TextBox
{
    protected override AutomationPeer OnCreateAutomationPeer() { return new RawPasswordPeer(this); }
}
sealed class RawPasswordPeer : TextBoxAutomationPeer
{
    public RawPasswordPeer(RawPasswordBox owner) : base(owner) { }
    protected override bool IsControlElementCore() { return false; }
    protected override bool IsContentElementCore() { return false; }
    protected override bool IsPasswordCore() { return true; }
}
sealed class OffscreenPasswordBox : TextBox
{
    protected override AutomationPeer OnCreateAutomationPeer() { return new OffscreenPasswordPeer(this); }
}
sealed class OffscreenPasswordPeer : TextBoxAutomationPeer
{
    public OffscreenPasswordPeer(OffscreenPasswordBox owner) : base(owner) { }
    protected override bool IsPasswordCore() { return true; }
    protected override bool IsOffscreenCore() { return true; }
}
class SecretInputFixture
{
    [STAThread] static void Main(string[] args)
    {
        Win.SetProcessDpiAwarenessContext(new IntPtr(-4));
        var app = new Application();
        var window = new Window {Title="LaunchFlow Secret Input Fixture", Width=580, Height=400, Left=160, Top=200};
        var panel = new StackPanel {Margin=new Thickness(25)};
        var user = new TextBox {Text="FIXTURE_USER", Height=40};
        AutomationProperties.SetAutomationId(user, "username");
        user.TextChanged += delegate {File.WriteAllText(args[0]+".user",user.Text);};
        window.Loaded += delegate {File.WriteAllText(args[0]+".user",user.Text);};
        var first = new RawPasswordBox {Height=40, Margin=new Thickness(0,15,0,0), Visibility=Visibility.Collapsed};
        var second = new RawPasswordBox {Height=40, Margin=new Thickness(0,15,0,0), Visibility=Visibility.Collapsed};
        var recordable = new PasswordBox {Height=40, Margin=new Thickness(0,15,0,0), Visibility=Visibility.Collapsed};
        var proxy = new OffscreenPasswordBox {Height=40, Margin=new Thickness(0,15,0,0), Visibility=Visibility.Collapsed};
        AutomationProperties.SetAutomationId(first, "raw-secret");
        AutomationProperties.SetAutomationId(second, "second-secret");
        AutomationProperties.SetAutomationId(recordable, "record-secret");
        AutomationProperties.SetAutomationId(proxy, "offscreen-secret");
        var ready = new DispatcherTimer {Interval=TimeSpan.FromMilliseconds(450)};
        ready.Tick += delegate {ready.Stop();first.Visibility=Visibility.Visible;first.Focus();};
        var prepare = new Button {Content="Prepare password", Height=35, Margin=new Thickness(0,15,0,0)};
        AutomationProperties.SetAutomationId(prepare, "prepare");
        prepare.Click += delegate { first.Visibility=Visibility.Collapsed; ready.Start(); };
        first.TextChanged += delegate {File.WriteAllText(args[0]+".value", first.Text);};
        recordable.PasswordChanged += delegate {File.WriteAllText(args[0]+".value", recordable.Password);};
        proxy.TextChanged += delegate {File.WriteAllText(args[0]+".value",proxy.Text);};
        panel.Children.Add(user);panel.Children.Add(prepare);panel.Children.Add(first);panel.Children.Add(second);panel.Children.Add(recordable);panel.Children.Add(proxy);
        window.Content=panel;
        var timer = new DispatcherTimer {Interval=TimeSpan.FromMilliseconds(100)};
        timer.Tick += delegate {
            if(File.Exists(args[0]+".stop")) window.Close();
            if(File.Exists(args[0]+".ambiguous")) second.Visibility=Visibility.Visible;
            if(File.Exists(args[0]+".record")) {first.Visibility=Visibility.Collapsed;recordable.Visibility=Visibility.Visible;}
            if(File.Exists(args[0]+".raw")) {first.Visibility=Visibility.Visible;recordable.Visibility=Visibility.Collapsed;}
            if(File.Exists(args[0]+".proxy")) {first.Visibility=Visibility.Collapsed;proxy.Visibility=Visibility.Visible;}
            if(File.Exists(args[0]+".proxy-focus")) proxy.Focus();
            if(File.Exists(args[0]+".proxy-blur")) user.Focus();
            if(File.Exists(args[0]+".hide")) {first.Visibility=Visibility.Collapsed;second.Visibility=Visibility.Collapsed;recordable.Visibility=Visibility.Collapsed;user.Focus();}
        };
        timer.Start();app.Run(window);timer.Stop();ready.Stop();
    }
}
