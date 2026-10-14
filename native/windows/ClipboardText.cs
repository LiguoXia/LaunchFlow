using System;
using System.Threading;
using System.Windows.Forms;
using System.Runtime.InteropServices;

namespace LaunchFlow.Native
{
    public static class ClipboardText
    {
        public static object Copy(System.Collections.Generic.Dictionary<string, object> request)
        {
            string text = Wire.Get(request, "text") as string;
            if (String.IsNullOrEmpty(text) || System.Text.Encoding.UTF8.GetByteCount(text) > 131072 || text.IndexOf('\0') >= 0)
                throw new NativeFailure("invalidRequest", "请输入需要复制的文本（最多 128 KiB，不能包含 NUL 字符）。");
            Exception failure = null;
            var operation = new Thread(delegate() {
                try {
                    var data = new DataObject();
                    data.SetText(text, TextDataFormat.UnicodeText);
                    // copy=true flushes the data so it survives this short-lived worker.
                    Clipboard.SetDataObject(data, true, 10, 50);
                } catch (ExternalException e) { failure = e; }
                catch (ThreadStateException e) { failure = e; }
            }) { IsBackground = true };
            operation.SetApartmentState(ApartmentState.STA);
            operation.Start();
            if (!operation.Join(2000) || failure != null)
                throw new NativeFailure("clipboardBusy", "剪贴板正被其他应用占用或未响应，请稍后重试。");
            return Wire.Obj("copied", true);
        }
    }
}
