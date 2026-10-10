using System;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Automation;
using System.Windows.Input;
using System.Windows.Media;
using System.Windows.Threading;
namespace LaunchFlow.Native
{
    public sealed class VisionSurface : FrameworkElement
    {
        protected override void OnRender(DrawingContext dc)
        {
            dc.DrawRectangle(Brushes.White, null, new Rect(0, 0, ActualWidth, 120));
            dc.DrawRectangle(Brushes.Teal, null, new Rect(16, 18, 85, 70));
            dc.DrawText(new FormattedText("VISION TARGET 472", System.Globalization.CultureInfo.InvariantCulture,
                                          FlowDirection.LeftToRight, new Typeface("Segoe UI"), 22, Brushes.Black, 1.0),
                        new Point(135, 32));
        }
    }
    public static class Harness
    {
        static TextBlock result;
        static TextBox input;
        static ComboBox choice;
        static StackPanel dynamicArea;
        static int clicks;
        static T Identify<T>(T element, string id, string name)
            where T : FrameworkElement
        {
            AutomationProperties.SetAutomationId(element, id);
            AutomationProperties.SetName(element, name);
            return element;
        }
        static void Result(string text)
        {
            result.Text = text;
            AutomationProperties.SetName(result, text);
        }
        [STAThread]
        public static void Main(string[] args)
        {
            Win.SetProcessDpiAwarenessContext(new IntPtr(-4));
            if (args.Length > 0 && args[0] == "--tutorial") Tutorial.Start(args);
            var app = new Application();
            string title = Tutorial.Active ? Tutorial.Title : "LaunchFlow Automation Test Harness";
            var window = Identify(new Window { Title = title, Width = 800, Height = 760,
                                               Left = 140, Top = 100,
                                               Background = new SolidColorBrush(Color.FromRgb(242, 247, 245)) },
                                  "test-window", title);
            if (Tutorial.Active) {
                window.MaxHeight = SystemParameters.WorkArea.Height;
                window.WindowStartupLocation = WindowStartupLocation.CenterScreen;
                Tutorial.Attach(window);
            }
            var dock = new DockPanel();
            window.Content = dock;
            var menu = Identify(new Menu(), "menu", "Harness Menu");
            DockPanel.SetDock(menu, Dock.Top);
            dock.Children.Add(menu);
            var file = Identify(new MenuItem { Header = "_File" }, "file-menu", "File");
            menu.Items.Add(file);
            var dialog = Identify(new MenuItem { Header = "Open Dialog" }, "dialog-menu", "Open Dialog");
            file.Items.Add(dialog);
            dialog.Click += delegate
            {
                var d = new Window { Title = Tutorial.Active ? title + " · Dialog" : "Harness Dialog", Owner = window, Width = 300, Height = 170,
                                     WindowStartupLocation = WindowStartupLocation.CenterOwner };
                var close = Identify(new Button { Content = "Confirm Dialog", Margin = new Thickness(20) },
                                     "confirm-dialog", "Confirm Dialog");
                close.Click += delegate
                {
                    Result("Dialog confirmed");
                    d.Close();
                };
                d.Content = close;
                d.Show();
            };
            var scroll = Identify(new ScrollViewer { VerticalScrollBarVisibility = ScrollBarVisibility.Auto },
                                  "scroll-area", "Scroll Area");
            dock.Children.Add(scroll);
            var stack = new StackPanel { Margin = new Thickness(28) };
            scroll.Content = stack;
            stack.Children.Add(new TextBlock { Text = Tutorial.Active ? "LaunchFlow · 步骤练习窗口" : "LaunchFlow · Automation Harness", FontSize = 24,
                                               FontWeight = FontWeights.Bold, Margin = new Thickness(0, 0, 0, 20) });
            var button = Identify(
                new Button { Content = "Start Task", Height = 42, HorizontalAlignment = HorizontalAlignment.Stretch },
                "start-button", "Start Task");
            stack.Children.Add(button);
            button.Click += delegate
            {
                clicks++;
                input.IsEnabled = true;
                Result("Task started " + clicks);
            };
            button.MouseDoubleClick += delegate
            {
                Result("Double click received");
            };
            var context = new ContextMenu();
            var contextItem = Identify(new MenuItem { Header = "Context Action" }, "context-action", "Context Action");
            contextItem.Click += delegate
            {
                Result("Context action received");
            };
            context.Items.Add(contextItem);
            button.ContextMenu = context;
            stack.Children.Add(new TextBlock { Text = "Project name", Margin = new Thickness(0, 14, 0, 4) });
            input = Identify(new TextBox { Height = 36, FontSize = 17 }, "project-input", "Project name");
            stack.Children.Add(input);
            var check = Identify(new CheckBox { Content = "Enable feature", Margin = new Thickness(0, 14, 0, 12) },
                                 "feature-checkbox", "Enable feature");
            stack.Children.Add(check);
            check.Checked += delegate
            {
                Result("Feature enabled");
            };
            check.Unchecked += delegate
            {
                Result("Feature disabled");
            };
            choice = Identify(new ComboBox { Height = 34 }, "environment-choice", "Environment");
            foreach (var name in new[] { "Development", "Staging", "Production" })
                choice.Items.Add(
                    Identify(new ComboBoxItem { Content = name }, "option-" + name.ToLowerInvariant(), name));
            choice.SelectedIndex = 0;
            stack.Children.Add(choice);
            var submit = Identify(
                new Button { Content = "Submit · Ctrl+Enter", Height = 40, Margin = new Thickness(0, 14, 0, 10) },
                "submit-button", "Submit");
            Action finish = delegate
            {
                var selected = choice.SelectedItem as ComboBoxItem;
                Result("Result: " + input.Text + " / " + Convert.ToString(selected.Content));
            };
            submit.Click += delegate
            {
                finish();
            };
            window.PreviewKeyDown += delegate(object sender, KeyEventArgs e)
            {
                if (e.Key == Key.Enter && (Keyboard.Modifiers & ModifierKeys.Control) != 0)
                {
                    finish();
                    e.Handled = true;
                }
            };
            stack.Children.Add(submit);
            result = Identify(new TextBlock { Text = "Ready", FontSize = 19, Foreground = Brushes.DarkGreen,
                                              Margin = new Thickness(0, 5, 0, 15) },
                              "result-label", "Ready");
            stack.Children.Add(result);
            var show = Identify(new Button { Content = "Show dynamic element", Height = 34 }, "dynamic-button",
                                "Show dynamic element");
            stack.Children.Add(show);
            dynamicArea = new StackPanel();
            stack.Children.Add(dynamicArea);
            show.Click += delegate
            {
                var timer = new DispatcherTimer { Interval = TimeSpan.FromMilliseconds(650) };
                timer.Tick += delegate
                {
                    timer.Stop();
                    dynamicArea.Children.Clear();
                    var remove = Identify(
                        new Button { Content = "Dynamic element", Height = 34, Margin = new Thickness(0, 8, 0, 8) },
                        "dynamic-element", "Dynamic element");
                    remove.Click += delegate
                    {
                        dynamicArea.Children.Clear();
                        Result("Dynamic element removed");
                    };
                    dynamicArea.Children.Add(remove);
                };
                timer.Start();
            };
            stack.Children.Add(
                new TextBlock { Text = "Password (never record value)", Margin = new Thickness(0, 14, 0, 4) });
            stack.Children.Add(Identify(new PasswordBox { Height = 34 }, "password-input", "Password"));
            if (!Tutorial.Active) stack.Children.Add(new VisionSurface { Height = 120, Margin = new Thickness(0, 14, 0, 10) });
            var drag = Identify(new System.Windows.Controls.Primitives.Thumb { Width = 120, Height = 36,
                                                                               Margin = new Thickness(0, 6, 0, 6),
                                                                               Background = Brushes.Teal },
                                "drag-target", "Drag target");
            drag.DragDelta += delegate
            {
                Result("Drag received");
            };
            stack.Children.Add(drag);
            for (int i = 0; i < 15; i++)
                stack.Children.Add(
                    Identify(new TextBlock { Text = "Scroll row " + i, Height = 32 }, "row-" + i, "Scroll row " + i));
            app.Run(window);
            Tutorial.Stop();
        }
    }
}
