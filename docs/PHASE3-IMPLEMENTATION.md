# Phase 3 implementation notes

The Phase 2 platform audit is complete: Engine depends only on PlatformAdapter and NodeRunner; native details remain outside scheduling. Existing timeout/retry/failure policies and snapshots are retained.

The GUI layer adds AutomationProvider and WindowProvider, a shared Locator model, attempts/diagnostics, and isolated native workers. Windows workers use .NET's Microsoft UI Automation bindings and Win32; macOS workers use Swift / AX / CoreGraphics / Vision. Worker processes provide a cancellation boundary for unresponsive accessibility providers. Requests use stdin JSON, never shell interpolation or command-line text arguments. Native workers are bundled resources, not downloaded at runtime.

All physical input is serialized across runs. Waits use bounded polling and release the input lock between observations. An action resolves all locators before performing its one side effect; an action failure never silently clicks another fallback target. Accessibility matches must be unambiguous.

Picker and Recorder are explicit, scoped sessions. Recorder stores semantic actions in memory until the user reviews and inserts them; secure controls produce unresolved secret references without reading values. Password rectangles are masked before diagnostic screenshots / OCR. Assets are separate content files; Scene export includes an asset manifest and files.

Work order: native test harness and inspection/actions; typed providers and runners; fallback/image/OCR diagnostics; picker/recorder; Tauri/UI; real desktop integration and Windows bundle; macOS source/configuration and explicit verification limitations. Do not enter Phase 4.

Reference APIs: Microsoft System.Windows.Automation, IUIAutomation2 timeout guidance, Windows.Media.Ocr; Apple AXUIElement / AXIsProcessTrustedWithOptions, CoreGraphics screen permissions and Vision VNRecognizeTextRequest.
