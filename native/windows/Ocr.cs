using System;
using System.Linq;
using System.Collections.Generic;
using Windows.Media.Ocr;
using Windows.Storage;
using Windows.Graphics.Imaging;
namespace LaunchFlow.Native
{
    public static class Ocr
    {
        public static object Recognize(string path, Dictionary<string, object> bounds)
        {
            var engine = OcrEngine.TryCreateFromUserProfileLanguages();
            if (engine == null)
                throw new NativeFailure("ocrUnavailable", "Install an OCR language in Windows language settings.");
            var file = StorageFile.GetFileFromPathAsync(path).AsTask().GetAwaiter().GetResult();
            using (var stream = file.OpenAsync(FileAccessMode.Read).AsTask().GetAwaiter().GetResult())
            {
                var decoder = BitmapDecoder.CreateAsync(stream).AsTask().GetAwaiter().GetResult();
                using (var bitmap =
                           decoder.GetSoftwareBitmapAsync(BitmapPixelFormat.Bgra8, BitmapAlphaMode.Premultiplied)
                               .AsTask()
                               .GetAwaiter()
                               .GetResult())
                {
                    var result = engine.RecognizeAsync(bitmap).AsTask().GetAwaiter().GetResult();
                    var words = new List<object>();
                    foreach (var line in result.Lines)
                        foreach (var word in line.Words)
                        {
                            var r = word.BoundingRect;
                            words.Add(Wire.Obj(
                                "text", word.Text, "bounds",
                                Win.Rect(Wire.Num(bounds, "x") + r.X, Wire.Num(bounds, "y") + r.Y, r.Width, r.Height),
                                "confidence", null));
                        }
                    return Wire.Obj("words", words, "confidenceSource",
                                    "unavailable: Windows OCR does not expose recognition confidence", "bounds",
                                    bounds);
                }
            }
        }
    }
}
