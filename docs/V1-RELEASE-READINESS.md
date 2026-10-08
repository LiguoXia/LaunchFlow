# LaunchFlow V1 Release Readiness Report

日期：2026-10-02（Asia/Shanghai） · 版本：0.4.0 · 阶段：Phase 4 — Workspace & Productization

**结论：可交付 Windows 本地验收版，尚不能标记 V1 Release Candidate。** 工作区、迁移、凭据、权限和产品化代码已实现；Windows 自动化测试与真实开发流程的后半段已通过。完整真实流程被本机 Docker Desktop 故障阻断。签名、公证、真实更新、干净系统安装和跨平台/多屏实机验证仍未完成。

本文将代码实现、自动化测试、真实设备证据与未验证条件分开记录，不将“编译成功”视为生产就绪。

## Feature Matrix

| 能力                               | 实现与验证                                                                                                         | 边界                                                                       |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------- |
| Workspace Capture                  | 原生可见窗口、应用路径、启动时间、身份、状态、显示器、绝对与相对矩形；Windows 真窗口通过                           | 无权限读取的应用路径可能为空；需用户选择有效应用                           |
| Create Scene From Workspace        | 勾选窗口、按进程时间给出初始顺序、手动排序、可选布局；创建去重启动节点与恢复节点                                   | 启动应用不等于重新打开文档、项目或浏览器标签                               |
| Relative / Exact Restore           | 默认 Relative；Exact 支持固定矩形；原生窗口位置恢复通过                                                            | 操作系统与应用最小窗口尺寸可能限制实际大小                                 |
| Multi-monitor Fallback             | 稳定 ID → 相似分辨率/缩放/名称 → 主副角色 → 主屏；矩形限制在可达工作区                                             | 当前只有单屏；多屏描述符为核心测试输入，另有真实单屏上的缺屏回退           |
| Office / Home / Laptop             | 按显示器数量与名称选择最具体的匹配布局；真实单屏上对不匹配 Office / 匹配 Laptop 的切换通过                         | 同等条件不宜配置冲突布局；无条件匹配时使用第一个布局                       |
| Application / Path / Secret Rebind | Found / Missing、应用选择、路径前缀映射、凭据引用映射、重新检查、预览确认；真实 UI 通过                            | GUI 控件语义与图片不能自动跨 Windows/macOS 转换                            |
| YAML                               | 外层 schemaVersion 2，兼容迁移旧 Scene schemaVersion 1；严格类型与字段验证                                         | 不接受未来版本、自定义 YAML 标签、重复字段或无限制别名展开                 |
| `.launchflow` Package              | packageVersion 1；scene.yaml、manifest.json、SHA-256 PNG assets；完整导入导出                                      | 纯 YAML 不携带图片，需要本机已有相同资产                                   |
| 安全导入                           | 不执行；新 Scene/子流程 ID；关闭触发器、取消默认标记、Ask Every Time；预览后更改源文件不会替换待导入内容           | 只有映射完整并确认预览后才能提交；提交前复查本机资源                       |
| Secret Vault                       | Windows Credential Manager 真实 CRUD 通过；macOS Keychain 源码实现；UI 仅返回元数据                                | Mac 未编译/实测；凭据不随场景迁移；同账户恶意进程不在保护边界之外          |
| Permissions Center                 | Windows Administrator: On Demand；Mac AX/录屏/输入监听与系统设置入口                                               | 未使用 Apple Events，Automation 显示不需要；不绕过 UAC/TCC                 |
| Sensitive Action Policy            | Ask Every Time / Allow For This Scene / Block At Startup；根场景、子流程、Test Action、恢复共同检查                | 无人值守不能自动批准 Ask Every Time；旧启动命令开关不再单独授权            |
| Updater                            | 手动检查/确认；开发与未配置发行版禁用；HTTPS、限时限量、签名与签名版本验证；安装期间禁止新工作流与录制             | 没有发行端点和签名密钥，尚未进行真实升级                                   |
| Diagnostic Bundle                  | 版本、OS、架构、DB schema、权限、运行元数据、脱敏日志、错误分类栈；ZIP 导出通过                                    | 省略任意原始错误文本、stdout/stderr、路径、输入和截图，诊断细节有意受限    |
| Retention                          | 默认 30；7/30/90/Forever/自定义；启动与每 15 分钟清理；保留活动 Run                                                | 历史清理不自动删除图片资产和诊断截图                                       |
| UI Polish                          | 所有页面共用字体、间距、圆角、阴影与动效 token；权限/迁移布局已截图核对                                            | 图像基于 Windows 1920×1080 桌面；Mac 视觉仍需实机                          |
| 平台视觉                           | Windows 字体与 Mica、Mac 字体与 Sidebar Vibrancy 使用 Tauri 公共配置                                               | 系统不支持时降级；未启用 macOS 私有 API                                    |
| 通知                               | Run started/completed/failed、Permission needed、Update available；不逐节点通知                                    | 自动测试关闭通知避免干扰；实际 Toast、系统免打扰和签名后的权限仍需安装验收 |
| 后台体验                           | `--startup` 隐藏窗口、唯一默认 Scene、关闭隐藏而执行继续、二次打开复用进程，桌面测试通过；托盘 Quit 取消服务并退出 | 本轮未实际注销/登录；未在用户系统安装或改动开机启动设置                    |
| 异常恢复                           | Interrupted 检测，不自动重放；Safe Point / Restart / Discard；已成功节点复用；不确定敏感副作用拒绝安全恢复         | 已发生外部副作用无法回滚；明确重放仍需用户判断                             |

## Tests

| 检查                       | 结果 / 证据                                                                                            |
| -------------------------- | ------------------------------------------------------------------------------------------------------ |
| TypeScript + Vite 生产构建 | 通过                                                                                                   |
| 前端单元测试               | 9 项通过（编辑器、图数据）                                                                             |
| Rust 非交互测试            | 58 项通过；含 10 项 Phase 4 产品化测试                                                                 |
| Rust 原生交互集成          | 1 项显式运行通过，包含 GUI DAG、fallback、超时、取消与高亮                                             |
| Clippy                     | workspace / all-targets，`-D warnings` 通过                                                            |
| Phase 2 桌面回归           | 15 项通过：真实 IPC/SQLite、静默启动、关闭隐藏、队列、暂停、恢复、参数和快捷键                         |
| Phase 3 桌面回归           | 9 项通过：UIA、Picker/Recorder、Secret、调试器、原生权限等既有能力                                     |
| Phase 4 桌面验收           | 7 组通过：捕获/恢复、Vault、导入与 Rebind UI、敏感确认、诊断与保留、Interrupted 安全恢复               |
| 恶意输入回归               | 拒绝未来/未知 schema、重复 YAML 字段、标签、别名炸弹、ZIP traversal、篡改图片；凭据字面量拒绝/日志清洗 |
| 事务与引用                 | 重复导入 ID 导致整体回滚；布局仍引用应用时禁止删除该应用                                               |
| Windows release + NSIS     | 0.4.0 优化构建成功，安装包包含两个 native 助手                                                         |

复现命令：

```powershell
npm ci
npm test
npm run build
node scripts/cargo.mjs test -p launchflow-core
node scripts/cargo.mjs clippy --workspace --all-targets -- -D warnings
node scripts/tauri.mjs build --debug --no-bundle
node scripts/desktop-smoke.mjs --phase2
node scripts/phase3-smoke.mjs
node scripts/phase4-smoke.mjs
node scripts/cargo.mjs test -p launchflow-core --test automation_native -- --ignored
node scripts/phase4-host.mjs
node scripts/phase4-host.mjs --downstream
node scripts/phase4-host.mjs --idle
node scripts/tauri.mjs build --bundles nsis
node scripts/package-local.mjs
```

GUI 测试按顺序运行，不并发抢占桌面。`phase4-host` 会打开已安装的真实应用与测试 URL；后端是独立 Node HTTP 服务，脚本结束清理该服务。其他桌面测试使用独立 SQLite 与 WPF Test Harness，并删除创建的验收凭据。

原始证据位于 `test-results/`，本阶段副本位于 `artifacts/phase4/evidence/`。其中包含桌面测试 JSON、工作区/权限/Rebind/设置截图、诊断 ZIP、性能采样及真实流程结果。历史 Phase 3 工件保留，不覆盖。

## 真实开发流程

完整流程通过 `--startup` 登录入口启动且主窗口保持隐藏；这是登录等价入口测试，没有实际注销/登录 Windows。

1. Network Ready：`www.microsoft.com:443` 实际 TCP 成功。
2. Clash / Proxy：本机应用检查及 `127.0.0.1:7897` 成功。Clash 已在后台运行，重复启动策略按配置跳过。
3. Docker Desktop：已请求启动，但 `docker info --format {{.ServerVersion}}` 持续超时；配置 20 次重试后失败，下游没有被错误放行。
4. 本机 Docker 日志显示 Inference manager 初始化时无法访问 `dockerInference` 本地 socket 路径，并弹出 unexpected error。没有执行 Reset to factory defaults 或删除 Docker 数据。
5. 为隔离验证后续能力，另建独立下游验收场景：IDEA 与 Chrome → Join → IDEA GUI 动作搜索打开/关闭 → 启动独立本地服务 → 等待端口 → 打开开发 URL → 恢复布局，全部成功。
6. 浏览器真实请求了 `/dev`；IDEA 恢复为左侧约 66%（1267×1032），Chrome 为右侧约 34%（653×1032）。IDEA 没有运行用户项目构建，也没有修改项目文件。

DataGrip 按用户确认的“未安装”禁用；独立本地服务按用户明确选择使用，不声称它是用户项目后端。后半段成功不能替代完整链路通过。证据分别为 `real-workflow.json`（失败）和 `real-workflow-downstream.json`（独立后半段成功）。

## Supported Platforms

| 平台                             | 当前支持程度                                                           |
| -------------------------------- | ---------------------------------------------------------------------- |
| Windows 11 x64，本机 build 26200 | 已编译、真实 UIA/凭据库/工作区/桌面验收；单显示器 1920×1080、100% 缩放 |
| Windows 10 x64                   | 代码目标支持；需 WebView2/.NET Framework；未在独立 Windows 10 环境运行 |
| macOS 13+ Intel                  | Rust/Swift 源码与 CI 目标已提供；无本轮编译、运行、签名和公证证据      |
| macOS 13+ Apple Silicon          | 同上；不能由 Windows 单元测试推导 Mac 通过                             |
| 多显示器 / 混合 DPI / 热插拔     | 描述符与 fallback 核心测试通过；无真实多屏硬件验收                     |

## Security Review

| 检查面          | 已实现控制 / 结论                                                                                                                  |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Secret storage  | 使用系统凭据库，引用在配置中，执行时通过受限原生 stdin/stdout 通道解析；不放命令行、不提供 UI 读取明文接口；测试凭据已清理         |
| Log redaction   | 运行时已知 Secret 值清洗；诊断包额外采用白名单、哈希 ID、错误类别；任意编码/变换后的秘密无法通用识别，输出捕获默认关闭             |
| UAC / TCC       | 保持 OS 授权边界；失败返回解释，不自动提权、不操作安全桌面；Mac 签名后的权限归属待测                                               |
| Shell args      | 默认程序与独立参数数组；用户显式选择解释器时脚本语义属于该解释器，不宣称沙箱；命令超时取消有进程组/Job Object 生命周期保护         |
| Imported Scene  | 大小/深度/类型/版本/循环依赖校验；新 ID、关触发器、Ask Every Time；预览使用不可变源；资源复查与 DB 事务                            |
| File operations | ZIP 名称白名单，禁止绝对/父路径、重复项、symlink；验证总大小、单图片大小、像素数量、内容 hash；导出临时文件同步后替换              |
| GUI / Recorder  | 目标限定、歧义拒绝、语义优先；录制显式开始/停止；系统标记安全控件不读取值，截图遮盖已识别密码区域；布局与 GUI 写操作共用桌面协调锁 |
| Updater         | 发行配置不接受导入场景/UI 覆盖；HTTPS 含跳转、下载上限 256 MiB/5 分钟；签名和签名版本校验；明确安装确认；阻止安装期间新运行与录制  |
| 恢复            | 不确定敏感副作用不自动重放，成功结果复用；仅丢弃记录不会回滚外部操作                                                               |
| 依赖            | Vitest 升级至 4.1.11，npm audit 为 0 项漏洞；RustSec 的漏洞列表为 0，另有 2 项 Linux GTK 传递依赖信息性警告（见下）                |

依赖审计补充：`cargo-audit 0.22.2` 使用当日下载的 RustSec 官方 main ZIP 快照，共 1,280 条公告，检查 Cargo.lock 的 578 个依赖。直接 Git 拉取未完成，改用 `--no-fetch --db` 读取官方快照；数据库没有 Git commit 元数据，下载地址与 ZIP SHA-256 已保存在审计证据。结果为 0 项漏洞，另有 `proc-macro-error 1.0.4` unmaintained（[RUSTSEC-2024-0370](https://rustsec.org/advisories/RUSTSEC-2024-0370.html)）和 `glib 0.18.5` unsound（[RUSTSEC-2024-0429](https://rustsec.org/advisories/RUSTSEC-2024-0429.html)）。两者属于 Tauri 的 GTK/Linux 传递依赖；已用 `cargo tree --workspace` 核查 Windows x64、Mac Intel/Arm 三个目标依赖图，均未包含这两个包。当前不发布 Linux；增加 Linux 支持前必须重新处置这些公告。没有配置忽略清单，也不宣称依赖永远无漏洞。

边界：Secret 运行时短暂存在进程内存；同一用户权限下的恶意程序、第三方应用未标记的密码字段、GUI 动作与用户同时操作冲突不能靠本应用消除。自动截图仅保存在本机，不放入诊断包；图片资产和诊断截图当前没有自动垃圾回收。

## Performance

采样：Windows 调试构建，隐藏主窗口，WebView2 CDP 开启，每次 60 秒，20 个逻辑处理器。包括 LaunchFlow 与其 WebView2 子进程；不包括 Docker/IDEA/Chrome 等已启动应用。工作集包含共享页面，不能当作去重物理内存。

| 指标                                           | 空场景静默空闲 | 完整流程失败后静默空闲 |
| ---------------------------------------------- | -------------- | ---------------------- |
| CPU（单逻辑核为 100%）                         | 5.91%          | 6.04%                  |
| CPU（20 核总容量为 100%）                      | 0.296%         | 0.302%                 |
| 私有内存总量                                   | 172.1 MiB      | 240.8 MiB              |
| 工作集求和                                     | 421.1 MiB      | 497.6 MiB              |
| Run / Trigger / Resync / Error / Recorder 事件 | 全部 0         | 全部 0                 |
| SQLite / WAL / SHM 内容及修改时间              | 未变化         | 未变化                 |

触发观察间隔 5 秒，使用缓存场景目录；前端通过事件同步，不轮询数据库；历史清理 15 分钟，MissedTick 跳过堆积。空闲样本主 Rust 进程累计约 0.625 秒 CPU，主要额外 CPU 位于 WebView2。当前样本没有发现事件或 DB 写入风暴，但不能证明长期耗电、发行版空闲或大图负载已达标；签名发行版需无 CDP 的至少 30 分钟复测。

## Installer Status / Signing Status

- Windows 0.4.0 release 优化构建与 NSIS 安装包已生成；安装脚本确认携带 automation/harness 两个原生助手。
- 完整便携 ZIP 包含主程序、native 目录、说明与本报告；它仍使用当前用户的数据目录，不是数据隔离模式。文件大小与 SHA-256 位于 `artifacts/phase4/manifest.json`。
- 本地 EXE/NSIS **未签名**。未安装到用户系统，未执行升级/卸载。没有 Windows Authenticode 证书，没有 Apple Developer ID / notarization 凭据。
- Mac Intel/Arm 构建、签名、公证脚本已准备；CI 尚未在实际仓库触发。当前工作区没有远端仓库，不存在已上传的发行件。
- Updater 的开发禁用、缺配置拒绝与安装前置保护已实现。缺少公钥/私钥/HTTPS 端点时预检明确失败，没有生成“假签名”或发布更新。
- `.github/workflows/release.yml` 为手动签名工件流程，不自动发布 GitHub Release 或更新 manifest。详见 [发行流程](RELEASE.md)。

## Known Limitations

1. 工作区依赖可用的稳定窗口身份；多个相同标题窗口会拒绝歧义。应用启动不保证还原原来的文档集合。跨平台的控件 role/class、路径与截图通常需要重新绑定。
2. Mac 对最大化前 normal bounds 的恢复为近似实现，原生 AX、Keychain、Retina、辅助程序签名与 TCC 都需要 Mac 实机验证。
3. GUI 无法在锁屏、安全桌面或不支持可访问性的目标上保证成功。用户同时输入会影响物理键鼠动作；错误需要检查定位诊断。
4. 短时空闲采样未覆盖电池、休眠唤醒、长时间运行和极大工作流。Run 事件仍包含完整快照。
5. Run 保留策略不等于资产/截图生命周期策略；目前没有资产管理或孤立图片自动回收 UI。
6. 原生命令进程组/Job Object 用于生命周期管理，并非不可信代码沙箱；已启动的普通应用在取消后保留。
7. 安装版通知、实际系统登录、升级后权限持续性与数据保留尚需干净环境验证。

## Release Blockers

| 编号 | 阻塞项                                    | 关闭证据要求                                                                                     |
| ---- | ----------------------------------------- | ------------------------------------------------------------------------------------------------ |
| R1   | 缺 Windows/macOS 签名、公证及正式发行配置 | 可信身份签署主程序、native 助手与安装包；Mac 公证/票据验证；存档 hash 与签名验证结果             |
| R2   | 未验证真实签名更新                        | staging HTTPS 上有效升级、篡改/错 key/错版本、断网与活动任务拒绝安装测试；确认成功重启与数据保留 |
| R3   | Mac Intel/Apple Silicon 未编译或实机验收  | 各架构原生构建、AX/录屏/Keychain、Recorder、workspace、签名后权限与安装生命周期通过              |
| R4   | 缺多屏与混合 DPI/热插拔实机证据           | 单/多屏、拔屏、主副屏变化、Office/Home/Laptop 切换、窗口保持可达                                 |
| R5   | 完整真实开发链路被本机 Docker 故障阻断    | 先修复 Docker Desktop Inference 服务环境，再重跑完整场景至 Run Completed；保留当前失败证据       |
| R6   | 安装与后台发行验收缺口                    | 干净 Windows/Mac 上安装、升级、卸载、真实登录、托盘 Quit、通知、30 分钟无 CDP 空闲/耗电验证      |

上述条目未关闭前，工件标签保持 **Phase 4 本地验收版**，不使用 **V1 Release Candidate** 或 **Production Ready**。
