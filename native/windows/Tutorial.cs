using System;
using System.Net;
using System.Net.Sockets;
using System.Text;
using System.Threading;
using System.Windows;

namespace LaunchFlow.Native
{
    // The same packaged harness has a separate, explicitly launched tutorial mode.
    public static class Tutorial
    {
        public static bool Active;
        public static string Title;
        static Mutex instance;
        static EventWaitHandle restart;
        static TcpListener listener;
        static volatile bool stopping;
        public static void Start(string[] args)
        {
            Guid id; int port;
            if ((args.Length != 3 && args.Length != 4) || !Guid.TryParse(args[1], out id) ||
                !int.TryParse(args[2], out port) || port < 1 || port > 65535)
                Environment.Exit(2);
            Guid runId = Guid.NewGuid();
            if (args.Length == 4 && !Guid.TryParse(args[3], out runId)) Environment.Exit(2);
            bool created;
            restart = new EventWaitHandle(false, EventResetMode.AutoReset, "Local\\LaunchFlow-Tutorial-Restart-" + args[1]);
            instance = new Mutex(true, "Local\\LaunchFlow-Tutorial-" + args[1], out created);
            if (!created) {
                // Reset only this template's owned practice window. A unique run title keeps
                // waitWindow from accidentally matching the previous instance during restart.
                restart.Set();
                try { if (!instance.WaitOne(10000)) Environment.Exit(4); }
                catch (AbandonedMutexException) { /* The previous process has exited. */ }
            }
            restart.Reset();
            Active = true;
            Title = "LaunchFlow 步骤练习 · " + runId;
            try {
                listener = new TcpListener(IPAddress.Loopback, int.Parse(args[2]));
                listener.Start();
            } catch (SocketException) {
                MessageBox.Show("练习端口已被占用，请重新载入模板以分配新的端口。", "LaunchFlow 步骤练习");
                Environment.Exit(3);
            }
            var server = new Thread(delegate() {
                try {
                    while (!stopping) {
                        var client = listener.AcceptTcpClient();
                        ThreadPool.QueueUserWorkItem(delegate { Serve(client); });
                    }
                } catch (SocketException) { } catch (ObjectDisposedException) { }
            });
            server.IsBackground = true;
            server.Start();
        }
        public static void Stop()
        {
            if (!Active) return;
            stopping = true;
            listener.Stop();
            instance.ReleaseMutex();
        }
        public static void Attach(Window window)
        {
            if (!Active) return;
            ThreadPool.RegisterWaitForSingleObject(restart, delegate {
                window.Dispatcher.BeginInvoke(new Action(delegate { window.Close(); }));
            }, null, Timeout.Infinite, true);
        }
        static void Serve(TcpClient client)
        {
            using (client) try {
                client.ReceiveTimeout = 1500;
                client.SendTimeout = 1500;
                var stream = client.GetStream();
                var request = new byte[4096];
                if (stream.Read(request, 0, request.Length) == 0) return;
                var body = Encoding.UTF8.GetBytes("<!doctype html><meta charset='utf-8'><title>LaunchFlow 步骤体验</title>" +
                    "<style>body{font:18px system-ui;max-width:760px;margin:80px auto;padding:24px;background:#f2f7f5;color:#163e32}h1{font-size:40px}li{margin:14px 0}</style>" +
                    "<h1>让工作，准备就绪。</h1><p>这张网页由本机练习窗口提供，不需要互联网。</p>" +
                    "<ol><li>启动应用、打开文件和文件夹：观察记事本与资源管理器。</li>" +
                    "<li>等待进程与端口：确认应用和本地服务已就绪。</li>" +
                    "<li>GUI 操作：练习窗口演示点击、中文输入、菜单、下拉框与拖动。</li>" +
                    "<li>条件、汇合与子流程：在运行详情查看分支与子运行。</li>" +
                    "<li>工作区恢复与截图：查看窗口布局以及截图步骤的诊断附件。</li></ol>" +
                    "<p>完成后可关闭本页、记事本和练习窗口。载入的两个场景可以在“我的场景”分别删除。</p>");
                var header = Encoding.ASCII.GetBytes("HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: " + body.Length + "\r\nConnection: close\r\n\r\n");
                stream.Write(header, 0, header.Length);
                stream.Write(body, 0, body.Length);
            } catch (System.IO.IOException) { } catch (SocketException) { }
        }
    }
}
