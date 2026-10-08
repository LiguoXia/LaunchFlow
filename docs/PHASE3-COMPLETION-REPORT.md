# Phase 3 Completion Report

版本：LaunchFlow 0.3.0。交付日期：2026-10-02（主体测试于 2026-10-01 完成）。

Windows 的 GUI Automation 实现和桌面验收已完成。macOS 已提供同一协议下的原生实现、权限处理和构建配置；**本机只有 Windows，macOS 尚未编译或实机验收，不能视为已通过跨平台发布验收**。未开始 Phase 4。

## 已完成

### 架构与执行

- PlatformAdapter 提供 AutomationProvider / WindowProvider。核心调度器不引用 COM、UIA、AX 或 AppKit。
- 20 个 `gui.*` NodeRunner 复用现有 DAG、Timeout、Retry、FailurePolicy、Cancel、运行快照与恢复。单步 Test Action 创建仅包含当前节点的运行快照，不执行其他节点；运行结果仍进入历史。孤立测试中的 failureBranch 转为停止，因为不存在下游分支。
- 物理输入经全局锁串行执行。等待节点默认 400 ms 轮询，配置范围 250–5000 ms。原生请求最多 15 秒；节点超时或取消会结束工作进程。不会在动作已经执行失败后继续点击另一个 Fallback。
- 原生程序固定随包分发，以 stdin JSON 通信。Secret 不进入命令行参数。Windows 工作进程受 Job Object 管理；启动的 Test Harness 和用户应用可独立存在。

### Locator 与调试

- Accessibility（多属性 + ancestorPath）、Accessible Text、OCR Text、Image、RelativeCoordinate、AbsoluteCoordinate 和 Window。
- 默认顺序：带稳定 ID 的 Accessibility、其他 Accessibility、可访问文字、OCR、模板图片、窗口相对坐标、绝对坐标。同类保持用户列表顺序，最多 8 个。
- 每次记录 Locator index、类型、耗时、是否成功和错误。匹配到多个可访问元素会报 ambiguous，用户可添加属性或提供后备定位器。
- Picker：实时属性、绿色边框、选择点击拦截、Esc 取消。WPF 按钮的文字子元素优先提升为可操作父控件；生成的窗口定位器不保存 WPF 每次启动变化的窗口类名。
- Highlight 只显示边框。Test Action 显示状态、耗时和诊断；Run Detail 显示应用、窗口、尝试过程、匹配元素、截图和结构化错误。

### 原生动作

Windows 通过 Microsoft UI Automation 读取窗口、控件、角色、名称、AutomationId、Class、Framework、父层级和 bounds。优先使用 Invoke / Value / Toggle / Selection / Scroll / ExpandCollapse；必要时才使用 SendInput。

GUI 节点：Activate Window、Wait Window、Click、Double Click、Right Click、Input Text、Input Secret、Press Key、Shortcut、Select Menu、Select Option、Scroll、Drag、Wait Element、Wait Element Disappear、Move Window、Resize Window、Maximize、Minimize、Screenshot。Provider 另提供 Focus。

macOS Swift 实现使用 AX 查询属性、设置值/焦点、执行 Press/菜单/窗口动作；CoreGraphics 发送输入；ScreenCaptureKit 获取目标窗口截图；Vision 识别文字；事件 tap 和显式会话实现 Picker / 基础录制。AX 与截图权限不足返回含 permission / platform / code 的错误，设置页提供 Open System Settings。

### Recorder 与密码

- 仅点击 Start Recording 才创建录制会话，必须选择目标窗口。应用顶部和原生悬浮条显示 Recording，提供 Pause / Resume / Stop。
- 合并连续输入，记录语义 Click、Input Text、Press Key、Shortcut、Activate Window；不保存原始鼠标移动或逐键流。
- 停止后可在审阅对话框编辑、删除、调整动作顺序。确认后才插入 Workflow；顺序模式追加到末尾，分支模式插入独立分支并由用户连接依赖。
- Secure / Password 字段不查询真实值，生成 `Input Secret / secretRef=unresolved`。执行需绑定 `env:NAME`，普通 Input Text 禁止写入安全字段，Input Secret 禁止存储 inline text。
- 原生截图在落盘前遮盖可访问树中标记为安全字段的矩形；OCR 和模板截取复用此路径。识别临时图像在正常完成和取消时清理。

### OCR 与资产

- 默认只截取目标窗口，可限定窗口内 region；不做整屏高频 OCR。
- Windows 使用系统 Windows.Media.Ocr，返回词边界。**Windows API 不提供识别置信度，因此 confidence 明确返回 null，并附 confidenceSource；没有伪造分数。** macOS Vision 返回其识别置信度。
- 图像匹配支持 0.5–1 阈值、region 和 1–5 个缩放系数（0.5–2）。稀疏扫描后对最终候选做全像素验证。
- 模板 PNG 以 SHA-256 ID 独立存放在 `automation/assets/`。导出 `.launchflow.zip` 包含 `scene.json`、`assets.json` 和 PNG 文件；Scene 不内嵌 Base64 图片。

## 实际测试

全部 GUI 测试操作 LaunchFlow 自有 WPF Test Harness，不依赖 IDEA、Chrome 或 DataGrip。测试数据目录与用户工作空间隔离。

| 检查 | Windows 实际结果 |
|---|---|
| Rust core | 48 passed；另有 1 个交互桌面集成测试单独运行并通过 |
| React / TypeScript | 9 tests passed；生产构建通过 |
| rustfmt / Clippy | format check 和 `-D warnings` 检查通过 |
| Phase 2 桌面回归 | 15 个真实 Tauri / WebView2 / TCP / 进程流程通过 |
| Phase 3 桌面验收 | 9 组通过：九步主流程、Fallback、移动/缩放、单步执行、Timeout、Cancel、截图、OCR、图像资产、Picker、录制审阅与诊断通过 |
| 原生 Recorder | 连续 h→he→hel→hello 合并、暂停、密码占位、选择点击不执行、Esc 取消通过 |
| macOS | 源码与构建入口已实现；未在本机编译或运行，不标为通过 |

九步主流程：Launch Test App → Wait Window → Wait Button → Click Button → Wait Input → Input Text → Select Option → Shortcut → Wait Result。

补充验收覆盖 Checkbox、菜单/独立 Dialog、动态元素出现与消失、滚动、真实拖动、双击/右键动作和最大化/最小化。环境 Secret 注入的运行快照未包含测试秘密；窗口移动后相对坐标点击和显式绝对坐标也通过。详情、截图、运行快照和资产包在 `artifacts/phase3/evidence/`。

复现命令：

```sh
npm ci
npm run native:build
node scripts/cargo.mjs test -p launchflow-core
npm test
node scripts/cargo.mjs fmt --all -- --check
node scripts/cargo.mjs clippy --workspace --all-targets -- -D warnings
node scripts/tauri.mjs build --debug --no-bundle
npm run test:phase2
npm run test:gui
npm run test:recorder
node scripts/cargo.mjs test -p launchflow-core --test automation_native -- --ignored
node scripts/tauri.mjs build --bundles nsis
```

## 权限和运行环境

Windows 10/11 x64、WebView2、系统 .NET Framework。编译原生 OCR 需要 Windows 10 SDK 的 Windows.winmd 和 .NET Framework 引用程序集。目标应用与 LaunchFlow 应在同一权限级别；不能自动跨越 UAC 安全桌面或操作受保护界面。

macOS 13+：AX 操作需要 Accessibility；截图/OCR 需要 Screen Recording；录制/Picker 事件监听需要 Input Monitoring。实现不使用 Apple Events，Automation 权限显示 notRequired。系统设置中授权后可能需要重启应用。Mac 代码、架构构建、签名后 TCC 归属、Retina 和多屏仍需 Mac 实机验证。

## Known Issues / 验收边界

1. **macOS 未实机编译/验收**。配置了 Intel / Apple Silicon CI 构建，但没有本轮 CI 执行结果或 Mac 二进制。不能将 Windows 测试视作跨平台通过。
2. Windows OCR 无原生 confidence；语言识别依赖系统已安装语言资源。OCR 文字匹配要求唯一、完整词序列，当前未实现模糊语言匹配。
3. 可访问树最多扫描 2048 个元素、24 层；复杂/虚拟化控件可能需要滚动、缩小范围或后备图片。GPU/受保护窗口可能无法通过 PrintWindow 得到有效画面。
4. 基础图像匹配对主题、抗锯齿和 DPI 变化敏感；多个相同图标时应限定 region。不是通用视觉识别系统。
5. 基础录制不保证恢复每个复杂手势、应用私有事件、输入法组合或自绘下拉框；生成动作必须审阅。仅系统声明为 Secure 的控件能被可靠识别并遮盖；应用把密码放在普通控件中无法自动判定。
6. Secret 目前只支持环境引用，没有 OS Secret Vault。录制动作中的 unresolved 必须绑定后才能运行。
7. ZIP 导出带资产；本阶段未提供 ZIP 导入 UI。图片资产和诊断截图保存在本地，尚无图形化资产管理/垃圾回收界面。
8. 安装包未签名，未做公证/自动更新；原生助手必须与主程序一起分发，不能只复制 LaunchFlow.exe。物理输入依赖交互桌面，锁屏或用户同时操作可能干扰动作。
9. 已发生的外部 GUI 副作用无法回滚。Retry / 从失败处继续沿用 Phase 2 语义，执行恢复前应查看诊断。

## 交付文件

- `artifacts/phase3/windows/LaunchFlow_0.3.0_x64-setup.exe`：Windows x64 NSIS 安装包，5,352,084 bytes。
- `artifacts/phase3/windows/LaunchFlow_0.3.0_windows-x64-portable.zip`：完整便携目录，含主程序、两个原生助手和使用说明。
- `artifacts/phase3/manifest.json`：文件大小与 SHA-256。
- `artifacts/phase3/evidence/verification-summary.json`：本轮验证汇总。

已核对 NSIS 脚本包含两个原生助手；便携 ZIP 文件清单通过检查，发布目录中的原生助手权限查询成功。未在用户系统中执行安装/卸载操作。

## API 依据

- [Microsoft UI Automation](https://learn.microsoft.com/en-us/dotnet/api/system.windows.automation?view=netframework-4.8.1)
- [Windows OCR](https://learn.microsoft.com/en-us/uwp/api/windows.media.ocr.ocrengine.recognizeasync?view=winrt-20348)
- [Apple AX permissions](https://developer.apple.com/documentation/applicationservices/1459186-axisprocesstrustedwithoptions)
- [ScreenCaptureKit](https://developer.apple.com/documentation/screencapturekit/scshareablecontent)
- [Vision recognized text](https://developer.apple.com/documentation/vision/vnrecognizedtext)

Phase 4 保持未开始。
