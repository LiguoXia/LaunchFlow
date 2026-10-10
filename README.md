# LaunchFlow

一个 Local-First 的 Windows / macOS 桌面工作环境编排器。Tauri 2 + Rust + React + TypeScript + SQLite。

当前版本 **0.4.16 · 凭据弹框与导入导出表单**：统一留白、输入框、下拉框与按钮布局，适配深色主题和窄窗口。详见 [本版说明](docs/releases/v0.4.16.md)。

包含 **0.4.15 · 场景名称同步与 Windows 全步骤体验模板**：编辑器修改名称后，返回“我的场景”立即同步，并保留未保存的步骤草稿；可载入、编辑、删除与重新载入 Windows 体验模板，42 个步骤覆盖全部 32 种步骤类型。操作与验证详情见 [场景名称同步与体验模板](docs/SCENE-SYNC-AND-TEMPLATE.md)。包含 0.4.14 的 [QQ Secret 与场景编辑](docs/QQ-SECRET-AND-SCENE-EDITOR.md) 修复。

已有功能包括 [应用内配置 Windows 自动登录](docs/IN-APP-AUTOLOGON.md)、[默认场景启动与中文输入录制](docs/STARTUP-TEXT-FIX.md)、[点击位置修复](docs/RECORDED-CLICK-FIX.md)、[窗口激活修复](docs/GUI-FOCUS-FIX.md)、[解锁前准备桌面应用](docs/DESKTOP-STARTUP.md)、[录制审阅修复](docs/RECORDING-REVIEW-FIX.md)、[关闭工作区应用](docs/WORKSPACE-CLOSE.md)、[应用图标](docs/APPLICATION-ICONS.md)、[预授权启动](docs/PREAUTHORIZED-LAUNCH.md) 和 [应用诊断日志](docs/APPLICATION-DIAGNOSTICS.md)。**从旧版本升级后，请在设置中允许默认场景自动执行，并重新录制此前漏掉的文本。**

Windows x64 下载：[安装包](https://github.com/LiguoXia/LaunchFlow/releases/download/v0.4.16/LaunchFlow_0.4.16_x64-setup.exe) · [便携 ZIP](https://github.com/LiguoXia/LaunchFlow/releases/download/v0.4.16/LaunchFlow_0.4.16_windows-x64-portable.zip) · [发布说明与校验文件](https://github.com/LiguoXia/LaunchFlow/releases/tag/v0.4.16)。这是未签名的预发布验收版；更新器未配置，升级请手动下载安装包。

本地制品位于 `artifacts/form-polish/windows/`，该目录不提交到源码仓库。macOS 已提供 AX / ScreenCaptureKit / Vision / Keychain 原生实现，尚未在 Mac 实机编译或运行；不能视为跨平台验收已完成。当前没有标记为 V1 Release Candidate。

- [V1 Release Readiness Report](docs/V1-RELEASE-READINESS.md)
- [签名与发行流程](docs/RELEASE.md)
- [Phase 3 历史完成报告](docs/PHASE3-COMPLETION-REPORT.md)
- [Phase 2 完成报告](docs/PHASE2-COMPLETION-REPORT.md)
- [Phase 1 自检记录](docs/PHASE1-SELF-CHECK.md)
- [技术架构](docs/ARCHITECTURE.md)

## 开发与构建

需要 Node 22、Rust stable；Windows 需 MSVC C++ Build Tools、Windows 10 SDK、.NET Framework 和 WebView2，macOS 需 Xcode Command Line Tools。

```sh
npm ci
npm run desktop
node scripts/tauri.mjs build --bundles nsis
```

`npm run dev` 只启动前端。没有桌面 Rust 引擎时明确提示无法执行，不提供浏览器假运行。
macOS 在 Mac 上分别执行：

```sh
rustup target add aarch64-apple-darwin x86_64-apple-darwin
node scripts/tauri.mjs build --target aarch64-apple-darwin --bundles app
node scripts/tauri.mjs build --target x86_64-apple-darwin --bundles app
```

分发签名、公证及更新产品化尚未完成。CI 配置包含 Windows x64、macOS Intel / Apple Silicon；本地 Windows 检查不等于 Mac 编译通过。

脚本通过 `rustup which cargo` 定位工具链。构建缓存可设置 `CARGO_TARGET_DIR`，或在已忽略的 `.local/build.json` 保存：

```json
{ "targetDir": "D:/CodexBuilds/LaunchFlow/target" }
```

## 创建和运行工作流

1. 在「应用库」绑定真实程序路径、进程名与 Ready 条件。应用 ID 与平台路径分离；Windows、macOS 可共用 Scene。
2. 在简单编排创建顺序流程，或切换高级画布连接节点。条件有 true / false 出口；选择 Failure Branch 后增加 failure 出口。
3. 在场景设置定义参数、最大并行度、Ignore / Queue / Restart 和触发器。
4. 节点支持 `${projectPath}`、`${run.id}`、`${run.startTime}`、`${node.NODE_ID.output.stdout}`。输出引用必须指向上游节点。完整变量保留 JSON 类型；命令参数的数字和布尔值转为单独字符串参数。
5. 「保存并运行」打开参数配置；运行历史实时显示状态、重试、输出及子流程。可以暂停、恢复、取消；失败后可续跑、跳过或重启。
6. 高级画布支持拖动、缩放、框选、分组、注释、禁用和自动布局；Ctrl/Cmd+C/V/D 为复制、粘贴、复制为新节点，Ctrl/Cmd+Z、Shift+Z / Y 撤销重做，Delete 删除。中键或右键拖动画布。

同一个 Workflow Model 用于两种编辑模式。分支图不会被简单模式重写成顺序链。Join 等待所有上游结束，至少有一个有效出口到达才继续；未选中的分支会传播 Skipped。

暂停只阻止新任务和重试调度，允许正在进行的操作完成。取消会停止等待及托管命令，已启动的用户应用保留。恢复创建新的 Run，复用已成功结果；重启会重新执行全部步骤。中断时未记录成功的外部副作用无法推断，继续前应检查。

## 节点与触发器

保留八种基础节点：启动应用、打开文件/目录/网页、延迟、运行命令、等待进程、等待端口。新增：

| 节点             | 行为                                                                                                          |
| ---------------- | ------------------------------------------------------------------------------------------------------------- |
| `flow.condition` | OS、进程、窗口标题、文件、目录、TCP、HTTP、环境变量、命令退出码、时段、星期、网络、显示器数量、电源，共 14 类 |
| `flow.join`      | 汇合有效分支                                                                                                  |
| `flow.subflow`   | 调用场景快照，传参、返回子 Run ID / 节点输出，禁止递归引用                                                    |

统一触发器：Manual、System Login、LaunchFlow Started、Schedule、Weekday、Global Hotkey、Network Available、Wi-Fi SSID、Monitor Changed、Power State。

只有唯一默认场景能由 System Login 执行。登录启动仍需在设置中主动开启；关闭窗口隐藏到托盘，通过托盘退出。普通打开仅在显式配置 LaunchFlow Started 时自动执行。

定时采用本地 HH:mm / 星期，应用需要保持运行；关闭期间不补跑。传感器每 5 秒观察一次，初次采样建立基线，状态变化时触发。网络以配置的 TCP 端点判断；显示器检测连接与布局变化；SSID 可能受系统定位权限限制。快捷键冲突会显示错误。

## 参数与命令

参数类型：String、Number、Boolean、Select、File、Directory、Secret Reference；支持默认值、必填、说明、长度/数值范围及正则。

Secret Reference 接受 `vault:ID` 或 `env:NAME`。权限与凭据页面可创建、更新、删除 Windows Credential Manager / macOS Keychain 凭据，只列出元数据。执行器在运行时读取明文，快照保留引用，已解析值从日志中遮蔽；传入子流程时继续传引用，子流程参数应同样声明为 Secret Reference。凭据不会随 YAML 或资产包导出。

命令使用程序 + 参数数组，不拼接 shell。执行脚本需显式选择 PowerShell、cmd、bash 等解释器。显式 shell 脚本自身仍有其解释语义。登录启动中的命令需要相应 Scene 授权。命令输出默认关闭，启用后 stdout / stderr 各最多保留 64 KiB。不要把凭据填入普通参数；常见凭据字面量会被拒绝，任意无标记或编码后的秘密无法可靠识别。

## 工作区与迁移

在「工作区」捕获可见窗口，勾选应用、调整启动顺序，选择 Relative（默认）或 Exact 布局后创建场景。也可向已有工作区场景添加 Office / Home / Laptop 布局，按显示器数量与名称匹配。显示器匹配按稳定 ID、相似规格、主副角色、主屏回退；矩形始终限制在当前工作区可达范围内。相同应用的多个窗口需要稳定标题才能区分，启动应用不会自动重建项目、标签页或文档。

「导入与导出」支持 Schema 2 YAML 和 `.launchflow` ZIP（manifest、YAML、内容寻址 PNG）。Schema 1 场景会迁移。导入先校验再展示应用、路径与凭据 Found / Missing，映射完整并核对预览后才写入。导入使用新场景 ID、关闭触发器、移除默认启动标记，敏感策略设为 Ask Every Time，始终不会立即执行。跨平台 GUI 的控件类型、标题和图片需要重新定位并 Test Action。

Scene 敏感策略统一为 Ask Every Time / Allow For This Scene / Block At Startup。旧场景升级默认 Block At Startup，旧版 `allowCommandsAtStartup` 不再单独授权；需要在编辑器重新检查并显式选择策略。Ask Every Time 不会在无人值守触发时自动批准。异常退出后可安全恢复、重启或丢弃；敏感步骤有不确定副作用时禁止安全恢复，其他重放需要确认。

设置中可选 7 / 30 / 90 / Forever / 自定义天数，每 15 分钟清理到期的非活动运行记录。诊断 ZIP 只包含白名单元数据与错误分类，省略原始命令输出、用户路径、输入和截图。诊断截图与图片资产保留在本地，当前不自动删除。

生产更新需要编译时 HTTPS 地址与公钥。开发版禁用，未配置的发行版也禁用；手动检查、明确确认后安装，并拒绝在运行工作流或录制期间安装。签名与真实升级验收步骤见发行文档。

## 使用 GUI Automation

1. 编辑器打开 Test Harness，或准备要自动化的目标应用。在 GUI Automation 分类添加节点。
2. 选择窗口，点击 Pick Element，悬停查看属性、单击选中、Esc 取消。Highlight 只显示边框。
3. Test Action 只运行当前节点；结果与截图在属性面板和运行历史可见。支持 Timeout、Retry、FailurePolicy 和 Cancel。
4. 为动作添加 Fallback。相对坐标使用 0–1；OCR / Image 可限定 region，图像可以导入或截取为模板。
5. Start Recording 明确开始录制；Recording 悬浮条可暂停/停止。审阅动作后点击确认插入，仍可在编辑器修改。密码只生成 unresolved Secret 引用，绑定 `env:NAME` 后运行。
6. “导出 Scene + Assets”生成 ZIP，包含 Scene JSON、资产清单和 PNG；不要单独复制 Scene 中的 assetId。

Windows 使用 UIA；macOS 使用 AX。权限中心展示 Accessibility / Screen Recording / Input Monitoring，Automation 明确标注本实现不需要 Apple Events 授权。完整平台限制见当前发行就绪报告。

## 验证

```sh
npm test
npm run build
node scripts/cargo.mjs test -p launchflow-core
node scripts/cargo.mjs fmt --all -- --check
node scripts/cargo.mjs clippy --workspace --all-targets -- -D warnings
node scripts/cargo.mjs build -p launchflow-core --bin launchflow-fixture
node scripts/tauri.mjs build --debug --no-bundle
npm run test:phase2
npm run test:gui
npm run test:recorder
node scripts/cargo.mjs test -p launchflow-core --test automation_native -- --ignored
```

桌面测试在 Windows 上启动真实 Tauri / WebView2、隔离 SQLite、命名测试进程和真实 TCP 服务，驱动 UI 与 IPC。证据位于 `test-results/`。不会安装第三方应用或改动已有工作场景。

可选 `LAUNCHFLOW_PHASE1_AUDIT=1` 增加原生文件/目录/URL 打开与隔离登录注册检查；`LAUNCHFLOW_REAL_APPS=1` 增加本机已绑定 Clash、Docker、IDEA、Chrome 的实际启动验收，路径在 `scripts/real-app-acceptance.mjs`。本机没有 DataGrip，真实应用流程禁用该节点；三路并行由独立测试进程验证。

数据库位于 Tauri 应用数据目录 `launchflow.db`。SQLite 升级到版本 2；Scene schema 仍为兼容的版本 1。保留场景版本、草稿和历史，异常退出的活动运行标为 Interrupted，不自动重放。详细限制及后续验收门槛见完成报告。
