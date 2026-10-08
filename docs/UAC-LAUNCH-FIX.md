# Windows 管理员应用启动修复 · 0.4.1

用户反馈：部分应用双击会出现“允许来自未知发布者的此应用对设备进行更改”提示，从 LaunchFlow 启动流程却无法启动。

## 原因与修复

原启动器直接创建进程。Windows 遇到 `requireAdministrator` 清单或兼容性管理员设置时返回 `ERROR_ELEVATION_REQUIRED`（740）；创建进程接口本身不会完成 Shell 的 UAC 授权流程。

- 普通应用保留原启动方式，只有错误 740 才自动回退到 `ShellExecuteExW` 的 `runas` 动词。文件不存在等其他错误不会触发提权。
- 应用库新增 Windows 专属「以管理员身份启动」，适合需要主动指定管理员权限的程序。旧配置缺省为 `false`，无需迁移数据库。
- 仅目标应用请求提权；LaunchFlow 与启动助手保持原权限。UAC 由 Windows 显示和处理，用户须亲自确认；不会绕过授权、关闭 UAC 或移除“未知发布者”提示。
- 拒绝/取消授权显示明确错误，不自动重试授权。授权或应用就绪等待超时也不自动重复启动，避免可能已启动的程序被重复打开。普通启动错误保留原重试策略，失败后的停止、跳过、失败分支或询问仍遵循节点配置。
- 只有 Shell 确认启动请求完成后才开始 Ready 检测，启动被拒绝不会进入成功后续步骤。
- 参数经过 Windows argv 引号与反斜杠编码；不拼接到 CMD 或 PowerShell。管理员启动只接受本机有效的 `.exe` 文件。
- 专用助手在 STA 线程调用 Shell，在取消/超时/父进程退出后结束等待。它不使用会连带终止用户应用的 Job；操作系统已经接受启动的应用会保留，取消与外部启动不具备原子回滚保证。

## 使用

1. 更新至 0.4.1。原先双击需要授权的 `.exe` 通常不必修改配置，重新运行工作流即可看到 Windows 授权提示。
2. 如需主动要求管理员权限，进入「应用库 → 编辑应用配置」，勾选「以管理员身份启动」并保存。
3. 授权框中确认“是”。等待授权计入启动节点超时，必要时在编辑器延长该节点的超时时间。
4. 取消授权后检查运行记录；准备好后手动重试。已运行应用仍遵循「已运行时跳过」策略；改变其权限应先退出再启动。

管理员启动解决应用启动权限，不改变 Windows 对跨权限 GUI 操作的限制。后续控件操作若目标处于更高权限，仍可能被 Windows 阻止。

## 验证

- 新增 9 项 Rust 测试：旧配置与数据库往返、拒绝授权阻止自动重试/Ready/后续成功节点、启动超时防重试、普通错误保留重试、主动管理员请求参数合并、无效/过大响应、取消时终止助手、真实管理员清单 740 回退、真实 Shell 启动的参数完整性。
- 740 测试在本机普通权限进程下构建无副作用的 `requireAdministrator` 测试程序，实际取得错误 740 后交给假助手验证回退。已提升权限的 CI 主机无法产生该错误，因此该分支会明确跳过。
- 原生 Shell 参数测试实际启动独立测试程序，验证空参数、空格、中文路径/参数、引号、尾部反斜杠与 shell 元字符；该测试不提升权限。
- 桌面验证脚本：`node scripts/uac-smoke.mjs`，使用真实 Tauri/WebView2/SQLite/原生助手，验证兼容读取、界面配置保存、重启后保留、无效管理员应用路径的运行记录与零自动重试。
- 本机结果：67 项 Rust 测试通过（包含上述 9 项），1 项既有交互式 GUI 测试在默认套件中忽略；9 项前端测试通过；Clippy `--workspace --all-targets -- -D warnings`、Rustfmt 与改动 TS/JS 文件的 Prettier 检查通过；桌面专项 4 项通过，截图已检查，前端生产构建与桌面 Debug 构建通过。Windows x64 Release / NSIS 安装包构建通过，便携包包含相同原生助手；验证证据见 `artifacts/uac-fix/evidence/`。

**验证边界：** 自动化没有点击 Windows 安全桌面的 UAC “是/否”。授权成功/拒绝的系统交互仍需人工实机验收；错误处理与防重试分别通过真实 740、真实非提权 Shell 启动和受控助手响应验证，不能将它们等同于已完成真实 UAC 点击验收。

## 交付

安装包和便携 ZIP 存放于 `artifacts/uac-fix/windows/`，哈希见上级 `manifest.json`。原 0.4.0 Phase 4 交付与证据保留。本修复版仍为未签名的本地构建，不代表此前 V1 发行、macOS 或其他实机验收缺口已解决。

实现依据：[Microsoft ShellExecuteExW](https://learn.microsoft.com/en-us/windows/win32/api/shellapi/nf-shellapi-shellexecuteexw)、[SHELLEXECUTEINFOW 的 runas、NOASYNC 与 FLAG_NO_UI 语义](https://learn.microsoft.com/en-us/windows/win32/api/shellapi/ns-shellapi-shellexecuteinfow)、[Windows C 命令行参数规则](https://learn.microsoft.com/en-us/cpp/c-language/parsing-c-command-line-arguments)。
