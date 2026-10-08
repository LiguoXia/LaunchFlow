# 0.4.10 · 录制回放窗口激活修复

用户在普通权限微信上录制打开窗口、点击后，回放立即报 `focusDenied: The target window is not foreground; input was not sent.`。附件运行在 678 ms 内失败，但旧版复制日志没有保留 GUI 错误码与激活阶段。

## 修复

- Windows 跨线程 `SetForegroundWindow` 返回时，目标线程可能尚未处理激活消息。旧版立即读取前台句柄，误把尚未完成的切换判为失败。现在等待实际前台窗口匹配，最多 2 秒；窗口退出时及时终止。
- LaunchFlow 将自己的前台激活权限交给本次执行的原生助手 PID，再发送动作。Windows 仍决定是否允许切换；没有模拟 Alt、连接输入线程、改变系统焦点限制或授权任何任意进程。
- 仅对最小化窗口异步恢复，保留已最大化窗口的布局；恢复也受等待上限约束。
- 每次发送键盘/鼠标输入前再次核验准确的目标前台窗口。失焦后停止输入，避免把内容输入其他窗口。
- “复制日志”与诊断包增加 GUI 错误码、定位尝试结果、激活阶段、等待耗时、Windows 激活请求与权限交接结果；不包含窗口标题、微信内容、输入文字或截图。
- 修正失败消息重复出现两次 `GUI automation failed`。

已有录制步骤可以直接重试，不需要为本次修复重新录制。

## 验证范围

2026-10-08：9 项原生焦点状态测试通过，覆盖延迟激活、拒绝与等待上限、窗口退出、异步恢复、保留窗口状态及输入前失焦拦截；83 项核心测试、11 项前端测试和 Clippy 通过。新增诊断白名单测试覆盖复制与 ZIP 导出。原生错误类型的兼容性由 6 项管理员关闭路由测试验证，无 UAC 操作。

真实 WebView2 + Tauri + 原生助手、隔离数据目录中，4 项录制审阅流程和 1 项锁屏拒绝输入/诊断传递流程通过。录制中实际保存了窗口激活、文本输入、按钮点击三个步骤。失败日志包含 `foregroundTimeout`、约 2 秒耗时与 `foregroundMatched: false`，且只保留一次错误前缀。

本机当前被 Windows `LockApp` 锁屏界面遮挡，因此尚未完成解锁后的五轮真实前台切换/最小化恢复/最大化回放验收。对此没有标记通过，也没有尝试解锁。解锁后运行 `node scripts/recording-review-smoke.mjs` 可继续；锁屏诊断路径使用 `--locked`。测试仅操作自己的独立窗口，没有对用户微信聊天执行点击或输入。

测试证据保存在 `artifacts/gui-focus/evidence/`。微信实际业务流程仍需用户升级后复验。

Windows 官方说明：[SetForegroundWindow 的异步行为](https://devblogs.microsoft.com/oldnewthing/20161118-00/?p=94745)、[AllowSetForegroundWindow](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-allowsetforegroundwindow)。
