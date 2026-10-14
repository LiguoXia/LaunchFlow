// JSON worker: AX for semantics, scoped ScreenCaptureKit/Vision for fallback.
// Never query AXValue on a secure field. Requests and secrets arrive only via stdin.
import AppKit
import ApplicationServices
import ScreenCaptureKit
import Vision
import CoreImage
import CoreMedia
import Security

typealias Object = [String: Any]
struct Failure: Error {
    let code: String
    let message: String
    var permission: String? = nil
    var json: Object { ["code": code, "message": message, "permission": permission as Any? ?? NSNull(), "platform": "macos"] }
}
func str(_ o: Object, _ k: String) -> String { o[k] as? String ?? "" }
func num(_ o: Object, _ k: String, _ fallback: Double = 0) -> Double { (o[k] as? NSNumber)?.doubleValue ?? fallback }
func obj(_ a: Any?) -> Object { a as? Object ?? [:] }
let outputLock = NSLock()
func emit(_ value: Object) {
    guard let data = try? JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]) else { return }
    outputLock.lock(); defer { outputLock.unlock() }
    FileHandle.standardOutput.write(data); FileHandle.standardOutput.write(Data([10]))
}
func permission(_ name: String) throws {
    let ok = name == "accessibility" ? AXIsProcessTrusted() : name == "screenRecording" ? CGPreflightScreenCaptureAccess() : CGPreflightListenEventAccess()
    if !ok { throw Failure(code: "permissionDenied", message: "Grant \(name) to LaunchFlow in System Settings, then relaunch the application.", permission: name) }
}
func attr(_ element: AXUIElement, _ name: String) -> CFTypeRef? {
    var result: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element, name as CFString, &result) == .success else { return nil }
    return result
}
func text(_ element: AXUIElement, _ name: String) -> String { attr(element, name) as? String ?? "" }
func children(_ e: AXUIElement) -> [AXUIElement] { attr(e, kAXChildrenAttribute) as? [AXUIElement] ?? [] }
func parent(_ e: AXUIElement) -> AXUIElement? {
    guard let p = attr(e, kAXParentAttribute), CFGetTypeID(p) == AXUIElementGetTypeID() else { return nil }
    return (p as! AXUIElement)
}
func secure(_ e: AXUIElement) -> Bool {
    text(e, kAXSubroleAttribute) == "AXSecureTextField" || text(e, kAXRoleAttribute) == "AXSecureTextField"
}
func bounds(_ e: AXUIElement) -> CGRect {
    var point = CGPoint.zero; var size = CGSize.zero
    if let a = attr(e, kAXPositionAttribute), CFGetTypeID(a) == AXValueGetTypeID() { AXValueGetValue(a as! AXValue, .cgPoint, &point) }
    if let a = attr(e, kAXSizeAttribute), CFGetTypeID(a) == AXValueGetTypeID() { AXValueGetValue(a as! AXValue, .cgSize, &size) }
    return CGRect(origin: point, size: size)
}
func rectJSON(_ r: CGRect) -> Object { ["x":r.minX,"y":r.minY,"width":r.width,"height":r.height] }
func rect(_ o: Object) -> CGRect { CGRect(x:num(o,"x"),y:num(o,"y"),width:num(o,"width"),height:num(o,"height")) }
func set(_ e: AXUIElement, _ name: String, _ value: CFTypeRef) throws {
    let status = AXUIElementSetAttributeValue(e, name as CFString, value)
    if status != .success { throw Failure(code: status == .apiDisabled ? "permissionDenied" : "unsupported", message: "Accessibility attribute \(name) could not be set.", permission: status == .apiDisabled ? "accessibility" : nil) }
}
func press(_ e: AXUIElement) throws {
    if AXUIElementPerformAction(e, kAXPressAction as CFString) != .success { throw Failure(code:"unsupported",message:"Element does not expose the Press action.") }
}
func attributes(_ e: AXUIElement) -> Object {
    let raw = text(e,kAXRoleAttribute)
    let roles = ["AXButton":"Button","AXCheckBox":"CheckBox","AXRadioButton":"RadioButton","AXTextField":"Edit","AXTextArea":"Document","AXSecureTextField":"Edit","AXStaticText":"Text","AXPopUpButton":"ComboBox","AXComboBox":"ComboBox","AXMenuItem":"MenuItem","AXMenuBar":"MenuBar","AXMenu":"Menu","AXWindow":"Window","AXScrollArea":"Pane","AXGroup":"Group"]
    var name = text(e,kAXTitleAttribute)
    if name.isEmpty { name = text(e,kAXDescriptionAttribute) }
    if name.isEmpty && raw == "AXStaticText" && !secure(e) { name = text(e,kAXValueAttribute) }
    return ["role":roles[raw] ?? raw,"name":secure(e) ? "" : name,"automationId":text(e,"AXIdentifier"),"className":raw,"frameworkId":"AppKit","secure":secure(e)]
}
struct Window {
    let app: NSRunningApplication
    let element: AXUIElement
    let index: Int
    var json: Object { ["application":app.bundleIdentifier ?? app.executableURL?.lastPathComponent ?? "","title":text(element,kAXTitleAttribute),"className":"AXWindow","pid":app.processIdentifier,"handle":"\(app.processIdentifier):\(index)","bounds":rectJSON(bounds(element)),"state":(attr(element,kAXMinimizedAttribute) as? Bool ?? false) ? "minimized":"normal","focused":app.isActive] }
}
func windows() throws -> [Window] {
    try permission("accessibility")
    var result: [Window] = []
    for app in NSWorkspace.shared.runningApplications where app.activationPolicy != .prohibited {
        let root = AXUIElementCreateApplication(app.processIdentifier); AXUIElementSetMessagingTimeout(root, 1)
        for (index,e) in (attr(root,kAXWindowsAttribute) as? [AXUIElement] ?? []).enumerated() { result.append(Window(app:app,element:e,index:index)) }
    }
    return result
}
func windowMatches(_ w: Window, _ locator: Object) -> Bool {
    let info = w.json
    for key in ["application","title","className","handle"] where !str(locator,key).isEmpty {
        if str(locator,key).caseInsensitiveCompare(str(info,key)) != .orderedSame { return false }
    }
    return locator["pid"] == nil || locator["pid"] is NSNull || num(locator,"pid") == Double(w.app.processIdentifier)
}
func findWindow(_ locator: Object) throws -> Window {
    guard !str(locator,"application").isEmpty || !str(locator,"title").isEmpty || locator["pid"] as? NSNumber != nil || !str(locator,"handle").isEmpty else { throw Failure(code:"invalidLocator",message:"A target window is required.") }
    let matches = try windows().filter { windowMatches($0,locator) }
    guard matches.count == 1 else { throw Failure(code:matches.isEmpty ? "notFound":"ambiguous",message:"Window locator must match exactly one window.") }
    return matches[0]
}
func elements(_ root: AXUIElement) -> [(AXUIElement,[Int])] {
    var queue: [(AXUIElement,[Int])] = [(root,[])]; var index = 0
    while index < queue.count && queue.count < 2048 {
        let (e,path) = queue[index]; index += 1
        if path.count < 24 { for (i,child) in children(e).enumerated() { if queue.count >= 2048 { break }; queue.append((child,path+[i])) } }
    }
    return queue
}
func info(_ e: AXUIElement, _ w: Window, _ path: [Int] = []) -> Object {
    var result = attributes(e); result["bounds"] = rectJSON(bounds(e)); result["window"] = w.json
    result["enabled"] = attr(e,kAXEnabledAttribute) as? Bool ?? true; result["offscreen"] = bounds(e).isEmpty
    result["runtimeId"] = path; var ancestors: [Object] = []; var current = parent(e)
    for _ in 0..<12 { guard let p = current else { break }; if text(p,kAXRoleAttribute) == "AXApplication" { break }; ancestors.insert(attributes(p),at:0); if CFEqual(p,w.element) { break }; current = parent(p) }
    result["ancestorPath"] = ancestors
    if !secure(e) { let value = text(e,kAXValueAttribute); if !value.isEmpty && value.count <= 32768 { result["value"] = value } }
    return result
}
func matches(_ info: Object, _ locator: Object) -> Bool {
    for key in ["role","name","automationId","className","frameworkId"] where !str(locator,key).isEmpty { if str(info,key) != str(locator,key) { return false } }
    return true
}
func find(_ w: Window, _ locator: Object) throws -> (AXUIElement,[Int]) {
    let found = elements(w.element).filter { e,path in
        let value = info(e,w,path)
        if bounds(e).isEmpty { return false }
        if str(locator,"kind") == "text" { return str(value,"name") == str(locator,"text") }
        if !matches(value,locator) { return false }
        if let runtime = locator["runtimeId"] as? [Int], runtime != path { return false }
        let actual = value["ancestorPath"] as? [Object] ?? []; var cursor = 0
        for expected in locator["ancestorPath"] as? [Object] ?? [] { while cursor < actual.count && !matches(actual[cursor],expected) { cursor += 1 }; if cursor >= actual.count { return false }; cursor += 1 }
        return true
    }
    guard found.count == 1 else { throw Failure(code:found.isEmpty ? "notFound":"ambiguous",message:"Element locator must match exactly one element.") }
    return found[0]
}
func activate(_ w: Window) throws {
    if attr(w.element,kAXMinimizedAttribute) as? Bool == true { try set(w.element,kAXMinimizedAttribute,kCFBooleanFalse) }
    w.app.activate(options:[.activateIgnoringOtherApps]); AXUIElementPerformAction(w.element,kAXRaiseAction as CFString)
    let deadline = Date().addingTimeInterval(0.5)
    while !w.app.isActive && Date() < deadline { RunLoop.current.run(until:Date().addingTimeInterval(0.02)) }
    if !w.app.isActive { throw Failure(code:"focusDenied",message:"Bring the target application to the foreground before sending input.") }
}
let keys: [String:CGKeyCode] = ["A":0,"S":1,"D":2,"F":3,"H":4,"G":5,"Z":6,"X":7,"C":8,"V":9,"B":11,"Q":12,"W":13,"E":14,"R":15,"Y":16,"T":17,"1":18,"2":19,"3":20,"4":21,"6":22,"5":23,"9":25,"7":26,"8":28,"0":29,"O":31,"U":32,"I":34,"P":35,"L":37,"J":38,"K":40,"N":45,"M":46,"Enter":36,"Tab":48,"Space":49,"Backspace":51,"Escape":53,"Esc":53,"Meta":55,"Command":55,"Shift":56,"Alt":58,"Ctrl":59,"Control":59,"Delete":117,"Home":115,"End":119,"PageUp":116,"PageDown":121,"Left":123,"Right":124,"Down":125,"Up":126,"F1":122,"F2":120,"F3":99,"F4":118,"F5":96,"F6":97,"F7":98,"F8":100,"F9":101,"F10":109,"F11":103,"F12":111]
func keyboard(_ names: [String]) throws {
    var codes: [CGKeyCode] = []; var flags: CGEventFlags = []
    for name in names { guard let code = keys[name] ?? keys[name.uppercased()] else { throw Failure(code:"invalidAction",message:"Unsupported key name.") }; codes.append(code); if code == 55 { flags.insert(.maskCommand) }; if code == 56 { flags.insert(.maskShift) }; if code == 58 { flags.insert(.maskAlternate) }; if code == 59 { flags.insert(.maskControl) } }
    for code in codes { let e=CGEvent(keyboardEventSource:nil,virtualKey:code,keyDown:true);e?.flags=flags;e?.post(tap:.cghidEventTap) }
    for code in codes.reversed() { let e=CGEvent(keyboardEventSource:nil,virtualKey:code,keyDown:false);e?.flags=flags;e?.post(tap:.cghidEventTap) }
}
func mouse(_ p: CGPoint, _ type: CGEventType, _ right: Bool = false, _ count: Int64 = 1) {
    let event=CGEvent(mouseEventSource:nil,mouseType:type,mouseCursorPosition:p,mouseButton:right ? .right:.left)
    event?.setIntegerValueField(.mouseEventClickState,value:count);event?.post(tap:.cghidEventTap)
}
func perform(_ w: Window, _ e: AXUIElement?, _ action: Object, _ point: Object) throws {
    let kind=str(action,"kind")
    if kind == "activateWindow" { try activate(w);return }
    if kind == "moveWindow" { var p=CGPoint(x:num(action,"x"),y:num(action,"y"));try set(w.element,kAXPositionAttribute,AXValueCreate(.cgPoint,&p)!);return }
    if kind == "resizeWindow" { var size=CGSize(width:num(action,"width"),height:num(action,"height"));guard size.width>=100 && size.height>=80 else { throw Failure(code:"invalidAction",message:"Invalid window size.") };try set(w.element,kAXSizeAttribute,AXValueCreate(.cgSize,&size)!);return }
    if kind == "minimize" { try set(w.element,kAXMinimizedAttribute,kCFBooleanTrue);return }
    if kind == "maximize" {
        let current=bounds(w.element);let top=CGDisplayBounds(CGMainDisplayID()).height
        if let display=NSScreen.screens.first(where:{$0.frame.contains(CGPoint(x:current.midX,y:top-current.midY))}) {let available=display.visibleFrame;if current.width>=available.width-3 && current.height>=available.height-3{return}}
        guard let button=attr(w.element,kAXZoomButtonAttribute),CFGetTypeID(button) == AXUIElementGetTypeID() else { throw Failure(code:"unsupported",message:"Window has no Zoom button.") };try press(button as! AXUIElement);return }
    if kind == "focus" { guard let e=e else { throw Failure(code:"unsupported",message:"Focus needs an accessible element.") };try set(e,kAXFocusedAttribute,kCFBooleanTrue);return }
    if kind == "inputText" || kind == "inputSecret" {
        guard let e=e else { throw Failure(code:"unsupported",message:"Text input needs an accessible field.") }
        if secure(e) != (kind == "inputSecret") { throw Failure(code:"secureInputRequired",message:"Secure fields require Input Secret; Input Secret requires a secure field.") }
        let value=str(action,"text");guard value.count<=32768 else { throw Failure(code:"invalidAction",message:"Input text is too long.") }
        var settable=DarwinBoolean(false);AXUIElementIsAttributeSettable(e,kAXValueAttribute as CFString,&settable)
        if settable.boolValue { try set(e,kAXValueAttribute,value as CFString);return }
        try activate(w);try set(e,kAXFocusedAttribute,kCFBooleanTrue);try keyboard(["Meta","A"])
        let utf16=Array(value.utf16);let down=CGEvent(keyboardEventSource:nil,virtualKey:0,keyDown:true);let up=CGEvent(keyboardEventSource:nil,virtualKey:0,keyDown:false)
        utf16.withUnsafeBufferPointer { buffer in if let base=buffer.baseAddress { down?.keyboardSetUnicodeString(stringLength:buffer.count,unicodeString:base);up?.keyboardSetUnicodeString(stringLength:buffer.count,unicodeString:base) } };down?.post(tap:.cghidEventTap);up?.post(tap:.cghidEventTap);return
    }
    if kind == "selectMenu" {
        let root=AXUIElementCreateApplication(w.app.processIdentifier);guard let bar=attr(root,kAXMenuBarAttribute),CFGetTypeID(bar) == AXUIElementGetTypeID() else { throw Failure(code:"notFound",message:"Application menu is unavailable.") };var scope=bar as! AXUIElement
        for name in action["menuPath"] as? [String] ?? [] { let candidates=elements(scope).filter { str(attributes($0.0),"name") == name };guard candidates.count == 1 else { throw Failure(code:"notFound",message:"Menu path is unavailable or ambiguous.") };scope=candidates[0].0;try press(scope) };return
    }
    if kind == "selectOption" { guard let e=e else { throw Failure(code:"unsupported",message:"Select Option needs an accessible element.") };try activate(w);try press(e);let deadline=Date().addingTimeInterval(1);repeat { let candidates=elements(e).filter { str(attributes($0.0),"name") == str(action,"option") && text($0.0,kAXRoleAttribute) == "AXMenuItem" };if candidates.count == 1 { try press(candidates[0].0);return };RunLoop.current.run(until:Date().addingTimeInterval(0.1)) } while Date()<deadline;throw Failure(code:"notFound",message:"Option is unavailable.") }
    if kind == "click" || kind == "invoke" { if let e=e { var actions:CFArray?;AXUIElementCopyActionNames(e,&actions);if (actions as? [String] ?? []).contains(kAXPressAction) { try press(e);return } };if kind == "invoke" { throw Failure(code:"unsupported",message:"Press action is unavailable.") } }
    try activate(w)
    if kind == "pressKey" || kind == "shortcut" { if let e=e { try? set(e,kAXFocusedAttribute,kCFBooleanTrue) };try keyboard(kind == "pressKey" ? [str(action,"key")] : action["keys"] as? [String] ?? []);return }
    let r=e.map(bounds);let p=r.map { CGPoint(x:$0.midX,y:$0.midY) } ?? CGPoint(x:num(point,"x"),y:num(point,"y"))
    switch kind {
    case "click","doubleClick","rightClick": for i in 1...(kind == "doubleClick" ? 2:1) { mouse(p,kind == "rightClick" ? .rightMouseDown:.leftMouseDown,kind == "rightClick",Int64(i));mouse(p,kind == "rightClick" ? .rightMouseUp:.leftMouseUp,kind == "rightClick",Int64(i)) }
    case "scroll": mouse(p,.mouseMoved);CGEvent(scrollWheelEvent2Source:nil,units:.line,wheelCount:1,wheel1:Int32(-num(action,"delta",3)),wheel2:0,wheel3:0)?.post(tap:.cghidEventTap)
    case "drag": mouse(p,.leftMouseDown);let end=CGPoint(x:num(action,"endX"),y:num(action,"endY"));for i in 1...12 { let t=Double(i)/12;mouse(CGPoint(x:p.x+(end.x-p.x)*t,y:p.y+(end.y-p.y)*t),.leftMouseDragged) };mouse(end,.leftMouseUp)
    case "movePointer":mouse(p,.mouseMoved)
    default:throw Failure(code:"unsupported",message:"Unknown GUI action.")
    }
}

// One bounded ScreenCaptureKit frame; never capture the entire desktop.
final class FrameOutput: NSObject, SCStreamOutput {
    let lock=NSLock();var image:CGImage?
    func stream(_ stream:SCStream,didOutputSampleBuffer buffer:CMSampleBuffer,of type:SCStreamOutputType) {
        guard type == .screen,buffer.isValid,let pixel=buffer.imageBuffer else { return }
        guard let attachments=CMSampleBufferGetSampleAttachmentsArray(buffer,createIfNecessary:false) as? [[SCStreamFrameInfo:Any]],let raw=attachments.first?[.status] as? Int,SCFrameStatus(rawValue:raw) == .complete else { return }
        lock.lock();defer{lock.unlock()};if image == nil { let ci=CIImage(cvPixelBuffer:pixel);image=CIContext().createCGImage(ci,from:ci.extent) }
    }
    func current()->CGImage? {lock.lock();defer{lock.unlock()};return image}
}
func pump(until condition:()->Bool,seconds:Double) throws {let deadline=Date().addingTimeInterval(seconds);while !condition() && Date()<deadline {RunLoop.current.run(until:Date().addingTimeInterval(0.03))};if !condition(){throw Failure(code:"nativeTimeout",message:"Native operation timed out.")}}
func capture(_ w:Window,_ region:Object,_ path:String) throws -> Object {
    try permission("screenRecording")
    var content:SCShareableContent?;var completed=false;var denied=false
    SCShareableContent.getExcludingDesktopWindows(true,onScreenWindowsOnly:true) { value,error in DispatchQueue.main.async {content=value;denied=error != nil;completed=true} }
    try pump(until:{completed},seconds:6)
    if denied {throw Failure(code:"permissionDenied",message:"Screen capture was denied; grant Screen Recording and relaunch.",permission:"screenRecording")}
    let frame=bounds(w.element)
    let candidates=content?.windows.filter {$0.owningApplication?.processID == w.app.processIdentifier && ($0.title == text(w.element,kAXTitleAttribute) || $0.frame == frame)} ?? []
    guard candidates.count == 1 else {throw Failure(code:"notFound",message:"Capture window must be visible and unique.")}
    let scale=2.0;let width=Int(frame.width*scale),height=Int(frame.height*scale)
    guard width>0 && height>0 && width*height<=16_000_000 else {throw Failure(code:"invalidRegion",message:"Window capture exceeds 16 megapixels.")}
    let config=SCStreamConfiguration();config.width=width;config.height=height;config.showsCursor=false;config.queueDepth=3;config.minimumFrameInterval=CMTime(value:1,timescale:5)
    let sink=FrameOutput();let stream=SCStream(filter:SCContentFilter(desktopIndependentWindow:candidates[0]),configuration:config,delegate:nil)
    try stream.addStreamOutput(sink,type:.screen,sampleHandlerQueue:DispatchQueue(label:"launchflow.capture"))
    var failed=false;stream.startCapture { error in if error != nil {DispatchQueue.main.async{failed=true}} };defer{stream.stopCapture(completionHandler:nil)}
    try pump(until:{sink.current() != nil || failed},seconds:6)
    guard let source=sink.current(),let context=CGContext(data:nil,width:width,height:height,bitsPerComponent:8,bytesPerRow:0,space:CGColorSpaceCreateDeviceRGB(),bitmapInfo:CGImageAlphaInfo.premultipliedLast.rawValue) else {throw Failure(code:"captureFailed",message:"Window frame unavailable.")}
    context.draw(source,in:CGRect(x:0,y:0,width:width,height:height));context.setFillColor(CGColor(gray:0,alpha:1))
    for (e,_) in elements(w.element) where secure(e) {let r=bounds(e);context.fill(CGRect(x:(r.minX-frame.minX)*scale,y:Double(height)-(r.maxY-frame.minY)*scale,width:r.width*scale,height:r.height*scale))}
    guard var image=context.makeImage() else {throw Failure(code:"captureFailed",message:"Could not mask capture.")}
    var logical=frame
    if !region.isEmpty {let r=rect(region);guard r.width>0 && r.height>0 && r.minX>=0 && r.minY>=0 && r.maxX<=frame.width && r.maxY<=frame.height else {throw Failure(code:"invalidRegion",message:"Region lies outside the window.")};guard let crop=image.cropping(to:CGRect(x:r.minX*scale,y:r.minY*scale,width:r.width*scale,height:r.height*scale)) else {throw Failure(code:"invalidRegion",message:"Region crop failed.")};image=crop;logical=CGRect(x:frame.minX+r.minX,y:frame.minY+r.minY,width:r.width,height:r.height)}
    let bitmap=NSBitmapImageRep(cgImage:image);guard let png=bitmap.representation(using:.png,properties:[:]) else {throw Failure(code:"captureFailed",message:"PNG encoding failed.")};try png.write(to:URL(fileURLWithPath:path),options:.atomic)
    return ["path":path,"bounds":rectJSON(logical),"scale":scale,"secureRegionsMasked":true]
}
func ocr(_ w:Window,_ request:Object) throws -> Object {
    let captured=try capture(w,obj(request["region"]),str(request,"path"));let region=rect(obj(captured["bounds"]));var words:[Object]=[]
    let task=VNRecognizeTextRequest();task.recognitionLevel = .accurate;task.usesLanguageCorrection=false
    try VNImageRequestHandler(url:URL(fileURLWithPath:str(request,"path"))).perform([task])
    for observation in task.results ?? [] {guard let candidate=observation.topCandidates(1).first else {continue};let sentence=candidate.string
        sentence.enumerateSubstrings(in:sentence.startIndex..<sentence.endIndex,options:.byWords) {word,range,_,_ in guard let word=word,let box=try? candidate.boundingBox(for:range) else {return};let b=box.boundingBox;words.append(["text":word,"confidence":candidate.confidence,"bounds":rectJSON(CGRect(x:region.minX+b.minX*region.width,y:region.minY+(1-b.maxY)*region.height,width:b.width*region.width,height:b.height*region.height))])}
    };return ["words":words,"confidenceSource":"Vision VNRecognizedText.confidence","bounds":captured["bounds"]!]
}

final class Overlay {
    let panel:NSPanel
    init() {panel=NSPanel(contentRect:.zero,styleMask:[.borderless,.nonactivatingPanel],backing:.buffered,defer:false);panel.isOpaque=false;panel.backgroundColor = .clear;panel.level = .floating;panel.ignoresMouseEvents=true;panel.hasShadow=false;panel.contentView?.wantsLayer=true;panel.contentView?.layer?.borderColor=NSColor.systemGreen.cgColor;panel.contentView?.layer?.borderWidth=3}
    func draw(_ r:CGRect) {let top=CGDisplayBounds(CGMainDisplayID()).height;panel.setFrame(CGRect(x:r.minX-3,y:top-r.maxY-3,width:r.width+6,height:r.height+6),display:true);panel.orderFrontRegardless()}
    deinit {panel.close()}
}
func generatedLocator(_ value:Object)->Object {let w=obj(value["window"]);var result:Object=["kind":"accessibility","window":["application":str(w,"application"),"title":str(w,"title")],"ancestorPath":value["ancestorPath"] ?? []];for key in ["role","name","automationId","className","frameworkId"] {result[key]=value[key]};return result}
final class Session: NSObject {
    let picking:Bool;let scope:Object;let overlay=Overlay();var stopped=false;var paused=false;var selected=false;var hovered:Object?;var actions:[Object]=[];var last=Date.distantPast;var timer:Timer?;var tap:CFMachPort?;var banner:NSPanel?;var pauseButton:NSButton?
    init(_ request:Object) {picking=str(request,"op") == "pick";scope=obj(request["window"]);super.init()}
    func append(_ kind:String,_ element:Object,_ values:Object=[:]) {
        if paused || stopped || actions.count>=256{return};let locator=generatedLocator(element);var action:Object=["kind":kind,"locators":[locator]];for(k,v)in values{action[k]=v}
        let same=actions.last.map {NSDictionary(dictionary:obj(($0["locators"] as? [Object])?.first)).isEqual(to:locator)} ?? false
        if same && str(actions.last ?? [:],"kind") == kind && Date().timeIntervalSince(last)<1.5 {if kind == "inputText"{actions[actions.count-1]=action}else if kind == "click" || kind == "inputSecret" {return}else{actions.append(action)}}else{actions.append(action)}
        last=Date();emit(["event":"actions","actions":actions]);if actions.count>=256{stop()}
    }
    func point(_ p:CGPoint)->Object? {
        var result:AXUIElement?;guard AXUIElementCopyElementAtPosition(AXUIElementCreateSystemWide(),Float(p.x),Float(p.y),&result) == .success, var e=result else{return nil}
        if text(e,kAXRoleAttribute) == "AXStaticText",let p=parent(e),["AXButton","AXCheckBox"].contains(text(p,kAXRoleAttribute)){e=p}
        var pid:pid_t=0;AXUIElementGetPid(e,&pid)
        guard let w=(try? windows())?.first(where:{$0.app.processIdentifier == pid && bounds($0.element).contains(p) && (scope.isEmpty || windowMatches($0,scope))}) else{return nil}
        let path=elements(w.element).first(where:{CFEqual($0.0,e)})?.1 ?? [];return info(e,w,path)
    }
    func focused()->(AXUIElement,Window)? {
        guard let w=try? findWindow(scope),w.app.isActive,let raw=attr(AXUIElementCreateApplication(w.app.processIdentifier),kAXFocusedUIElementAttribute),CFGetTypeID(raw) == AXUIElementGetTypeID() else{return nil};return (raw as! AXUIElement,w)
    }
    @objc func stop(){stopped=true}
    @objc func togglePause(){paused.toggle();last = .distantPast;pauseButton?.title=paused ? "Resume":"Pause Recording";emit(["event":"state","state":paused ? "paused":"recording"])}
    func event(_ type:CGEventType,_ event:CGEvent)->Unmanaged<CGEvent>? {
        if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput {if let tap=tap{CGEvent.tapEnable(tap:tap,enable:true)};return Unmanaged.passUnretained(event)}
        if picking {
            if type == .keyDown && event.getIntegerValueField(.keyboardEventKeycode) == 53 {emit(["event":"cancelled"]);stop();return nil}
            if type == .leftMouseDown {if let value=hovered{selected=true;emit(["event":"selected","element":value,"locator":generatedLocator(value)])};return nil}
            if type == .leftMouseUp && selected {stop();return nil}
        } else if !paused && !stopped {
            // Defer AX queries so the system event tap stays responsive.
            if type == .leftMouseUp {let p=event.location;DispatchQueue.main.async {if let e=self.point(p){self.append("click",e)}}}
            if type == .keyDown {let code=CGKeyCode(event.getIntegerValueField(.keyboardEventKeycode));let flags=event.flags
                DispatchQueue.main.async {guard let(e,w)=self.focused() else{return};let value=info(e,w)
                    if secure(e){self.append("inputSecret",value,["secretRef":"unresolved"]);return}
                    let special:[CGKeyCode:String]=[36:"Enter",48:"Tab",53:"Escape",123:"Left",124:"Right",125:"Down",126:"Up"]
                    let modified=flags.contains(.maskCommand)||flags.contains(.maskControl)||flags.contains(.maskAlternate)
                    if let name=special[code] ?? (modified ? keys.first(where:{$0.value == code && $0.key.count == 1})?.key:nil) {var names:[String]=[];if flags.contains(.maskCommand){names.append("Meta")};if flags.contains(.maskControl){names.append("Ctrl")};if flags.contains(.maskAlternate){names.append("Alt")};if flags.contains(.maskShift){names.append("Shift")};names.append(name);self.append(names.count>1 ? "shortcut":"pressKey",value,names.count>1 ? ["keys":names]:["key":name])}
                    else {DispatchQueue.main.asyncAfter(deadline:.now()+0.12){if !secure(e) && ["AXTextField","AXTextArea"].contains(text(e,kAXRoleAttribute)){let input=text(e,kAXValueAttribute);if input.count<=32768{self.append("inputText",info(e,w),["text":input])}}}}
                }
            }
        };return Unmanaged.passUnretained(event)
    }
    func run() throws {
        try permission("accessibility");try permission("inputMonitoring")
        if !picking {let w=try findWindow(scope);let window:Object=["application":str(w.json,"application"),"title":str(w.json,"title")];actions.append(["kind":"activateWindow","locators":[["kind":"window","window":window]]])}
        let mask=[CGEventType.leftMouseDown,.leftMouseUp,.keyDown].reduce(CGEventMask(0)){$0 | (1 << $1.rawValue)}
        tap=CGEvent.tapCreate(tap:.cgSessionEventTap,place:.headInsertEventTap,options:picking ? .defaultTap:.listenOnly,eventsOfInterest:mask,callback:{_,type,event,context in guard let context=context else{return Unmanaged.passUnretained(event)};return Unmanaged<Session>.fromOpaque(context).takeUnretainedValue().event(type,event)},userInfo:Unmanaged.passUnretained(self).toOpaque())
        guard let tap=tap,let source=CFMachPortCreateRunLoopSource(kCFAllocatorDefault,tap,0) else{throw Failure(code:"permissionDenied",message:"Input event access was denied.",permission:"inputMonitoring")}
        CFRunLoopAddSource(CFRunLoopGetMain(),source,.commonModes);CGEvent.tapEnable(tap:tap,enable:true)
        defer{timer?.invalidate();CGEvent.tapEnable(tap:tap,enable:false);CFRunLoopRemoveSource(CFRunLoopGetMain(),source,.commonModes);CFMachPortInvalidate(tap);banner?.close();emit(["event":"stopped","actions":actions])}
        DispatchQueue.global().async {while let line=readLine(){guard let data=line.data(using:.utf8),let request=(try? JSONSerialization.jsonObject(with:data)) as? Object else{continue};DispatchQueue.main.async{switch str(request,"op"){case "stop":self.stop();case "pause":if !self.paused{self.togglePause()};case "resume":if self.paused{self.togglePause()};default:break}}};DispatchQueue.main.async{self.stop()}}
        if picking {timer=Timer.scheduledTimer(withTimeInterval:0.15,repeats:true){_ in if let p=CGEvent(source:nil)?.location,let value=self.point(p){self.hovered=value;self.overlay.draw(rect(obj(value["bounds"])));emit(["event":"hover","element":value])}}}
        else {let panel=NSPanel(contentRect:CGRect(x:30,y:CGDisplayBounds(CGMainDisplayID()).height-90,width:400,height:50),styleMask:[.borderless,.nonactivatingPanel],backing:.buffered,defer:false);panel.level = .floating;panel.backgroundColor = .windowBackgroundColor;let label=NSTextField(labelWithString:"● Recording · LaunchFlow");label.frame=CGRect(x:12,y:16,width:180,height:20);panel.contentView?.addSubview(label);let pause=NSButton(title:"Pause Recording",target:self,action:#selector(Session.togglePause));pause.frame=CGRect(x:190,y:10,width:130,height:30);let stop=NSButton(title:"Stop",target:self,action:#selector(Session.stop));stop.frame=CGRect(x:325,y:10,width:65,height:30);panel.contentView?.addSubview(pause);panel.contentView?.addSubview(stop);panel.orderFrontRegardless();banner=panel;pauseButton=pause}
        emit(["event":"state","state":picking ? "picking":"recording"]);emit(["event":"actions","actions":actions])
        while !stopped {RunLoop.current.run(until:Date().addingTimeInterval(0.05))}
    }
}

func displayDescriptors() -> [Object] {
    let mainHeight = CGDisplayBounds(CGMainDisplayID()).height
    return NSScreen.screens.compactMap { screen in
        guard let number = screen.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber else { return nil }
        let display = CGDirectDisplayID(number.uint32Value)
        let visible = screen.visibleFrame
        let work = CGRect(x: visible.minX, y: mainHeight-visible.maxY, width: visible.width, height: visible.height)
        let uuid = CGDisplayCreateUUIDFromDisplayID(display).takeRetainedValue()
        let id = CFUUIDCreateString(nil, uuid) as String
        return ["id":id,"name":screen.localizedName,"bounds":rectJSON(CGDisplayBounds(display)),"workArea":rectJSON(work),"scale":screen.backingScaleFactor,"primary":display == CGMainDisplayID()]
    }
}
func applicationIcons(_ request: Object) -> [Any] {
    ((request["sources"] as? [Object]) ?? []).prefix(24).map { source -> Any in
        let requested = str(source, "path")
        let path = requested.isEmpty
            ? NSWorkspace.shared.urlForApplication(withBundleIdentifier: str(source, "bundleId"))?.path ?? ""
            : requested
        guard path.hasPrefix("/"), FileManager.default.fileExists(atPath: path),
              let bitmap = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: 64, pixelsHigh: 64,
                  bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
                  colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0),
              let context = NSGraphicsContext(bitmapImageRep: bitmap) else { return NSNull() }
        NSGraphicsContext.saveGraphicsState()
        NSGraphicsContext.current = context
        NSWorkspace.shared.icon(forFile: path).draw(in: NSRect(x: 0, y: 0, width: 64, height: 64),
            from: .zero, operation: .copy, fraction: 1)
        NSGraphicsContext.restoreGraphicsState()
        guard let png = bitmap.representation(using: .png, properties: [:]) else { return NSNull() }
        return ["path": path, "png": png.base64EncodedString()]
    }
}

func workspaceCapture() throws -> Object {
    let displays = displayDescriptors()
    let captured: [Object] = try windows().compactMap { w in
        let b = bounds(w.element)
        guard b.width > 0, b.height > 0, let display = displays.max(by: { rect(obj($0["bounds"])).intersection(b).area < rect(obj($1["bounds"])).intersection(b).area }) else { return nil }
        var item = w.json
        item["normalBounds"] = rectJSON(b)
        item["executable"] = w.app.bundleURL?.path ?? w.app.executableURL?.path ?? ""
        item["bundleId"] = w.app.bundleIdentifier ?? ""
        if let date=w.app.launchDate {item["startedAt"]=ISO8601DateFormatter().string(from:date)} else {item["startedAt"]=NSNull()}
        item["displayId"] = display["id"]
        let work = rect(obj(display["workArea"]))
        if str(item,"state") != "minimized" && abs(b.width-work.width)<3 && abs(b.height-work.height)<3 { item["state"]="maximized" }
        return item
    }
    return ["displays":displays,"windows":captured]
}
extension CGRect { var area: CGFloat { isNull ? 0 : width*height } }
func workspaceRestore(_ request: Object) throws -> Object {
    let w = try findWindow(obj(request["window"]))
    var b = rect(obj(request["bounds"]))
    guard [b.minX,b.minY,b.width,b.height].allSatisfy({$0.isFinite && abs($0)<100000}), b.width>0, b.height>0 else { throw Failure(code:"invalidRequest",message:"Invalid layout bounds.") }
    try set(w.element,kAXMinimizedAttribute,kCFBooleanFalse)
    if str(request,"state")=="maximized",let display=displayDescriptors().max(by:{rect(obj($0["bounds"])).intersection(b).area < rect(obj($1["bounds"])).intersection(b).area}) { b=rect(obj(display["workArea"])) }
    var point=b.origin;var size=b.size
    try set(w.element,kAXPositionAttribute,AXValueCreate(.cgPoint,&point)!)
    try set(w.element,kAXSizeAttribute,AXValueCreate(.cgSize,&size)!)
    if str(request,"state")=="minimized" {try set(w.element,kAXMinimizedAttribute,kCFBooleanTrue)}
    return w.json
}
func vault(_ request:Object) throws -> Any {
    let action=str(request,"action"),id=str(request,"id")
    var query:Object=[kSecClass as String:kSecClassGenericPassword,kSecAttrService as String:"com.launchflow.vault.v1",kSecAttrSynchronizable as String:false]
    func fail(_ status:OSStatus) -> Failure { Failure(code:status == errSecItemNotFound ? "secretMissing":"vaultUnavailable",message:status == errSecItemNotFound ? "The secret reference is not available on this device.":"Keychain could not complete the operation. Unlock the login keychain and allow LaunchFlow access.") }
    if action=="list" {
        query[kSecReturnAttributes as String]=true;query[kSecMatchLimit as String]=kSecMatchLimitAll
        var result:CFTypeRef?;let status=SecItemCopyMatching(query as CFDictionary,&result)
        if status==errSecItemNotFound {return [Object]()};if status != errSecSuccess {throw fail(status)}
        return (result as? [Object] ?? []).map { item -> Object in ["id":item[kSecAttrAccount as String] as? String ?? "","label":item[kSecAttrLabel as String] as? String ?? "","updatedAt":(item[kSecAttrModificationDate as String] as? Date).map{ISO8601DateFormatter().string(from:$0)} ?? ""] }
    }
    guard id.range(of:"^[A-Za-z0-9_.-]{1,64}$",options:.regularExpression) != nil else {throw Failure(code:"invalidRequest",message:"Invalid secret ID.")}
    query[kSecAttrAccount as String]=id
    if action=="delete" {let status=SecItemDelete(query as CFDictionary);if status != errSecSuccess {throw fail(status)};return ["deleted":true]}
    if action=="read" {query[kSecReturnData as String]=true;query[kSecMatchLimit as String]=kSecMatchLimitOne;var result:CFTypeRef?;let status=SecItemCopyMatching(query as CFDictionary,&result);if status != errSecSuccess {throw fail(status)};guard let data=result as? Data,let value=String(data:data,encoding:.utf8) else {throw Failure(code:"invalidSecret",message:"Invalid secret encoding.")};return ["value":value]}
    let data=Data(str(request,"value").utf8),label=str(request,"label")
    guard ["create","update"].contains(action),!data.isEmpty,data.count<=2560,label.count<=80 else {throw Failure(code:"invalidRequest",message:"Invalid secret length, label or action.")}
    let attributes:Object=[kSecValueData as String:data,kSecAttrLabel as String:label]
    let status:OSStatus
    if action=="create" {query.merge(attributes){_,new in new};status=SecItemAdd(query as CFDictionary,nil)} else {status=SecItemUpdate(query as CFDictionary,attributes as CFDictionary)}
    if status==errSecDuplicateItem {throw Failure(code:"secretExists",message:"This secret ID already exists. Choose Update to replace it.")}
    if status != errSecSuccess {throw fail(status)}
    return ["saved":true]
}
func workspaceCloseCapture(_ request:Object) -> [Object] {
    let visible = CGWindowListCopyWindowInfo([.optionOnScreenOnly,.excludeDesktopElements],kCGNullWindowID) as? [Object] ?? []
    return NSWorkspace.shared.runningApplications.compactMap { app -> Object? in
        let rows=visible.filter{num($0,kCGWindowOwnerPID as String)==Double(app.processIdentifier) && num($0,kCGWindowLayer as String)==0}
        guard app.activationPolicy == .regular, !rows.isEmpty else {return nil}
        let path=app.bundleURL?.path ?? app.executableURL?.path ?? ""
        let started=app.launchDate.map{String($0.timeIntervalSince1970)} ?? ""
        let protected=app.processIdentifier == Int32(num(request,"ownerPid")) || app.bundleIdentifier == "app.launchflow.desktop" || app.bundleIdentifier == "com.apple.finder" || (app.localizedName ?? "").lowercased().hasPrefix("launchflow")
        let blocked: Any
        if protected { blocked = "系统组件或 LaunchFlow，已保护" }
        else if path.isEmpty || started.isEmpty { blocked = "无法核实程序身份" }
        else { blocked = NSNull() }
        return ["name":app.localizedName ?? "Application","executable":path,"windows":rows.map{str($0,kCGWindowName as String).isEmpty ? "应用窗口" : str($0,kCGWindowName as String)},"blocked":blocked,"target":["pid":app.processIdentifier,"started":started,"executable":path]]
    }
}
func workspaceClose(_ request:Object) throws -> [Object] {
    let action=str(request,"action")
    guard ["status","graceful","force"].contains(action) else {throw Failure(code:"invalidRequest",message:"Invalid close action.")}
    return (request["targets"] as? [Object] ?? []).map { target -> Object in
        let pid=pid_t(num(target,"pid"))
        guard let app=NSRunningApplication(processIdentifier:pid), !app.isTerminated else {return ["pid":pid,"state":"closed","message":"应用已退出"]}
        let path=app.bundleURL?.path ?? app.executableURL?.path ?? ""
        let started=app.launchDate.map{String($0.timeIntervalSince1970)} ?? ""
        guard pid>1,pid != pid_t(num(request,"ownerPid")),app.activationPolicy == .regular,app.bundleIdentifier != "com.apple.finder",app.bundleIdentifier != "app.launchflow.desktop",!(app.localizedName ?? "").lowercased().hasPrefix("launchflow"),!path.isEmpty,!started.isEmpty,path==str(target,"executable"),started==str(target,"started") else {return ["pid":pid,"state":"stale","message":"进程身份已变化或受到保护，请重新捕获。"]}
        if action=="status" {return ["pid":pid,"state":"pending","message":"仍在运行；请处理保存提示，或稍后重新检查。"]}
        let accepted=action=="force" ? app.forceTerminate() : app.terminate()
        if accepted {RunLoop.current.run(until:Date().addingTimeInterval(0.05))}
        return ["pid":pid,"state":app.isTerminated ? "closed" : (accepted || action=="graceful") ? "pending" : "failed","message":app.isTerminated ? "应用已退出" : accepted ? "已请求退出；请处理保存提示。" : "应用拒绝退出或权限不足，请手动处理。"]
    }
}
func dispatch(_ request:Object) throws -> Any {
    let op=str(request,"op")
    if op == "clipboardCopyText" {
        guard let value=request["text"] as? String, !value.isEmpty, value.utf8.count<=131072, !value.contains("\0") else {
            throw Failure(code:"invalidRequest",message:"请输入需要复制的文本（最多 128 KiB，不能包含 NUL 字符）。")
        }
        let pasteboard=NSPasteboard.general
        pasteboard.clearContents()
        guard pasteboard.setString(value,forType:.string) else {
            throw Failure(code:"clipboardBusy",message:"无法写入系统剪贴板，请稍后重试。")
        }
        return ["copied":true]
    }
    if op == "applicationIcons" {return applicationIcons(request)}
    if op == "workspaceCloseCapture" {return workspaceCloseCapture(request)}
    if op == "workspaceClose" {return try workspaceClose(request)}
    if op == "vault" {return try vault(request)}
    if op == "displays" {return displayDescriptors()}
    if op == "workspaceCapture" {return try workspaceCapture()}
    if op == "workspaceRestore" {return try workspaceRestore(request)}
    if op == "permissions" {return ["accessibility":AXIsProcessTrusted() ? "granted":"denied","screenRecording":CGPreflightScreenCaptureAccess() ? "granted":"denied","inputMonitoring":CGPreflightListenEventAccess() ? "granted":"denied","automation":"notRequired"]}
    if op == "openSettings" {let key=["accessibility":"Privacy_Accessibility","screenRecording":"Privacy_ScreenCapture","inputMonitoring":"Privacy_ListenEvent","automation":"Privacy_Automation"][str(request,"permission")] ?? "Privacy_Accessibility";NSWorkspace.shared.open(URL(string:"x-apple.systempreferences:com.apple.preference.security?\(key)")!);return ["opened":true]}
    if op == "windows" {return try windows().map(\.json)}
    let w=try findWindow(obj(request["window"]))
    if op == "window" {return w.json}
    if op == "elements" {return elements(w.element).map{info($0.0,w,$0.1)}}
    if op == "capture" {return try capture(w,obj(request["region"]),str(request,"path"))}
    if op == "ocr" {return try ocr(w,request)}
    let locator=obj(request["locator"]);let match: (AXUIElement,[Int])? = try (locator.isEmpty ? nil : find(w,locator))
    if op == "find" {return info(match?.0 ?? w.element,w,match?.1 ?? [])}
    if op == "perform" {try perform(w,match?.0,obj(request["action"]),obj(request["point"]));return ["window":w.json]}
    if op == "highlight" {let r=request["bounds"] != nil ? rect(obj(request["bounds"])):bounds(match?.0 ?? w.element);let overlay=Overlay();overlay.draw(r);RunLoop.current.run(until:Date().addingTimeInterval(min(3,num(request,"durationMs",1200)/1000)));withExtendedLifetime(overlay){};return ["highlighted":true,"bounds":rectJSON(r)]}
    throw Failure(code:"unsupported",message:"Unknown native operation.")
}
let app=NSApplication.shared;app.setActivationPolicy(.accessory)
do {
    guard let line=readLine(),line.utf8.count<=2*1024*1024,let data=line.data(using:.utf8),let request=(try JSONSerialization.jsonObject(with:data)) as? Object else {throw Failure(code:"invalidRequest",message:"Invalid native request.")}
    if ["pick","record"].contains(str(request,"op")) {try Session(request).run()}else{emit(["ok":true,"result":try dispatch(request)])}
} catch let failure as Failure {emit(["ok":false,"error":failure.json])}
catch {emit(["ok":false,"error":Failure(code:"nativeFailure",message:"Native automation failed.").json])}
