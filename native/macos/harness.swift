import AppKit

final class Harness: NSObject, NSApplicationDelegate {
    var window:NSWindow!
    let input=NSTextField(string:"")
    let options=NSPopUpButton()
    let result=NSTextField(labelWithString:"Ready")
    let stack=NSStackView()
    var count=0
    func identify(_ view:NSView,_ id:String,_ label:String) {view.setAccessibilityIdentifier(id);view.setAccessibilityLabel(label)}
    func label(_ value:String)->NSTextField {let field=NSTextField(labelWithString:value);field.font = .systemFont(ofSize:15);return field}
    func button(_ title:String,_ id:String,_ action:Selector)->NSButton {let b=NSButton(title:title,target:self,action:action);identify(b,id,title);b.bezelStyle = .rounded;return b}
    func applicationDidFinishLaunching(_ notification:Notification) {
        window=NSWindow(contentRect:NSRect(x:140,y:100,width:800,height:760),styleMask:[.titled,.closable,.resizable,.miniaturizable],backing:.buffered,defer:false)
        window.title="LaunchFlow Automation Test Harness";window.setAccessibilityIdentifier("test-window")
        let menu=NSMenu();let appItem=NSMenuItem();menu.addItem(appItem);let appMenu=NSMenu();appItem.submenu=appMenu;appMenu.addItem(withTitle:"Quit Harness",action:#selector(NSApplication.terminate(_:)),keyEquivalent:"q")
        let fileItem=NSMenuItem(title:"File",action:nil,keyEquivalent:"");let file=NSMenu(title:"File");fileItem.submenu=file;menu.addItem(fileItem);let dialog=NSMenuItem(title:"Open Dialog",action:#selector(openDialog),keyEquivalent:"");dialog.target=self;file.addItem(dialog);NSApp.mainMenu=menu
        let scroll=NSScrollView(frame:window.contentView!.bounds);scroll.autoresizingMask=[.width,.height];scroll.hasVerticalScroller=true;identify(scroll,"scroll-area","Scroll Area")
        let document=FlippedDocument(frame:NSRect(x:0,y:0,width:760,height:1400));scroll.documentView=document
        stack.orientation = .vertical;stack.alignment = .leading;stack.spacing=16;stack.translatesAutoresizingMaskIntoConstraints=false;document.addSubview(stack)
        NSLayoutConstraint.activate([stack.topAnchor.constraint(equalTo:document.topAnchor,constant:24),stack.leadingAnchor.constraint(equalTo:document.leadingAnchor,constant:24),stack.widthAnchor.constraint(equalTo:document.widthAnchor,constant:-48)])
        stack.addArrangedSubview(label("LaunchFlow · Automation Test Harness"))
        stack.addArrangedSubview(label("Button, Input, Checkbox, Dropdown, Menu, Dialog, Dynamic, Password"))
        stack.addArrangedSubview(button("Start Task","start-button",#selector(startTask)))
        stack.addArrangedSubview(label("Project name"));identify(input,"project-input","Project name");input.widthAnchor.constraint(equalToConstant:600).isActive=true;stack.addArrangedSubview(input)
        let checkbox=NSButton(checkboxWithTitle:"Enable feature",target:self,action:#selector(toggle));identify(checkbox,"feature-checkbox","Enable feature");stack.addArrangedSubview(checkbox)
        options.addItems(withTitles:["Development","Staging","Production"]);identify(options,"environment-choice","Environment");stack.addArrangedSubview(options)
        stack.addArrangedSubview(button("Submit · Command / Control + Enter","submit-button",#selector(submit)))
        identify(result,"result-label","Ready");stack.addArrangedSubview(result)
        stack.addArrangedSubview(button("Show Dynamic Element","dynamic-button",#selector(dynamic)))
        stack.addArrangedSubview(label("Password (never recorded)"));let password=NSSecureTextField();identify(password,"password-input","Password");password.widthAnchor.constraint(equalToConstant:600).isActive=true;stack.addArrangedSubview(password)
        let vision=VisionSurface(frame:NSRect(x:0,y:0,width:560,height:65));vision.widthAnchor.constraint(equalToConstant:560).isActive=true;vision.heightAnchor.constraint(equalToConstant:65).isActive=true;stack.addArrangedSubview(vision)
        for i in 1...15 {stack.addArrangedSubview(label("Scroll row \(i)"))}
        window.contentView?.addSubview(scroll);window.makeKeyAndOrderFront(nil);NSApp.activate(ignoringOtherApps:true)
        NSEvent.addLocalMonitorForEvents(matching:.keyDown) { [weak self] event in if event.keyCode==36 && (!event.modifierFlags.intersection([.command,.control]).isEmpty) {self?.submit();return nil};return event }
    }
    func show(_ value:String){result.stringValue=value;result.setAccessibilityLabel(value)}
    @objc func startTask(){count+=1;show("Task started \(count)")}
    @objc func toggle(_ sender:NSButton){show(sender.state == .on ? "Feature enabled":"Feature disabled")}
    @objc func submit(){show("Result: \(input.stringValue) / \(options.titleOfSelectedItem ?? "")")}
    @objc func dynamic(){DispatchQueue.main.asyncAfter(deadline:.now()+0.65){let b=self.button("Dynamic Ready","dynamic-element",#selector(self.removeDynamic(_:)));self.stack.insertArrangedSubview(b,at:8)}}
    @objc func removeDynamic(_ sender:NSButton){sender.removeFromSuperview();show("Dynamic element removed")}
    @objc func openDialog(){let dialog=NSAlert();dialog.messageText="Harness Dialog";dialog.informativeText="Native modal dialog";dialog.addButton(withTitle:"Confirm");identify(dialog.buttons[0],"confirm-dialog","Confirm");dialog.beginSheetModal(for:window){_ in self.show("Dialog confirmed")}}
    func applicationShouldTerminateAfterLastWindowClosed(_ sender:NSApplication)->Bool{true}
}
final class FlippedDocument:NSView { override var isFlipped:Bool {true} }
final class VisionSurface:NSView {
    override func isAccessibilityElement()->Bool{false}
    override func draw(_ dirtyRect:NSRect){NSColor(calibratedRed:0.1,green:0.28,blue:0.4,alpha:1).setFill();bounds.fill();("VISION TARGET 472" as NSString).draw(at:NSPoint(x:24,y:20),withAttributes:[.font:NSFont.boldSystemFont(ofSize:24),.foregroundColor:NSColor.white])}
}
let app=NSApplication.shared
let harness=Harness();app.delegate=harness;app.setActivationPolicy(.regular);app.run()
