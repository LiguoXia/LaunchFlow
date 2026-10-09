# 解锁前准备桌面应用 · 0.4.9

0.4.13 可以直接在 LaunchFlow 内配置 Windows 自动登录，使用账户密码，保留原有 PIN；见 [内置自动登录](IN-APP-AUTOLOGON.md)。

0.4.12 增加了默认场景启动检查、失败运行历史、策略修复按钮和 Microsoft Autologon 官方配置入口；升级后的操作见 [启动与中文录制修复](STARTUP-TEXT-FIX.md)。下文保留 ARSO 模式的说明；想开机直接进入桌面时，使用系统自动登录配合“普通登录启动”。

目标是在 Windows 已建立并锁定的用户会话里提前打开应用，输入密码或 Windows Hello 解锁后使用。Windows 必须先建立该用户的桌面会话；普通 Windows 服务的 Session 0 无法替用户准备可交互桌面。

## 设置

1. 退出托盘里的旧版 LaunchFlow，安装或运行 0.4.9 完整目录。便携版请放在稳定路径。
2. 设置 → 启动与后台 → 自动启动方式选择 **解锁前准备桌面应用**，在下方选择默认启动场景和启动延迟。模式立即生效；修改延迟后点击保存设置。
3. 点击 **打开 Windows 登录选项**，开启类似“使用我的登录信息自动完成设置”的选项（名称随 Windows 版本变化），返回 LaunchFlow 刷新检测。
4. 保持用户登录，不要先注销，再正常重启或关机开机。等待应用准备后输入密码解锁。查看设置里的上次自动启动观察和运行历史。

LaunchFlow 只检测 Windows 条件，不修改登录策略，也不收集密码。Windows 管理自动登录并锁定所需凭据信息；此功能涉及系统凭据处理，适合在自己信任并妥善保管的设备上使用。

## Windows 条件与限制

使用 Windows **Automatic Restart Sign-On (ARSO)**。未加入组织的设备可支持用户发起的重启或关机开机；域或 Microsoft Entra 加入设备通常仅支持 Windows 更新引起的重启。还取决于 Windows 安全条件、账户状态、设备策略和关机方式，不能保证每次冷启动都提前打开应用。

注册表值不存在或无法读取显示“需确认”，不能据此声称已经开启。策略禁用、用户退出此功能会单独显示。若本机不满足 ARSO 条件，计划任务会等到实际登录时启动；不会绕过密码或锁屏。

参考：[Microsoft ARSO 文档](https://learn.microsoft.com/en-us/windows-server/identity/ad-ds/manage/component-updates/winlogon-automatic-restart-sign-on--arso-)；[Windows 交互服务与 Session 0](https://learn.microsoft.com/en-us/windows/desktop/Services/interactive-services)。

## 执行行为

- “普通登录启动”保留原有用户 Run 注册。“解锁前准备”使用当前用户、InteractiveToken、普通权限、登录触发的计划任务，主窗口隐藏。切换模式会清理另一个入口；登记本身不会运行场景。
- 默认场景仍由 `systemLogin` 启动；同一应用实例收到重复 `--startup` 不会重复执行。手动打开不会当成开机启动。
- 普通应用启动、进程/端口等待可提前执行。GUI 动作、工作区窗口恢复及会请求 UAC 的应用启动等到桌面可交互；等待时不消耗节点超时、重试次数或并行名额，可暂停/取消。已配置的敏感操作策略继续生效。
- 流程依赖顺序保持不变。如果 GUI 步骤在前，依赖它的应用也会等到解锁。希望多个应用先准备时，请把启动节点放到前面，或使用已有并行分支。
- 已预授权的固定应用继续走原授权通道；需要临时 UAC 的应用必须等用户解锁并亲自确认。
- 上次启动观察记录启动和分发时桌面是否可交互；不可交互也可能是会话未激活，不单独作为开机成功证明。执行结果以运行历史为准。
- 移动便携目录后，在设置中点击“重新登记当前版本”。删除便携目录或卸载前先切换“不自动启动”，移除当前账户的启动任务。

## 排查与验证

设置 → 启动诊断 → **复制启动诊断**。包含版本、注册状态、策略检测及启动时间，不包含 Windows 密码或场景内容。任务错误带异常类型和 Windows HRESULT。

2026-10-08 自动验证：

- `npm run test:desktop-startup`：7 项真实 Tauri/Task Scheduler 检查，覆盖任务登记、用户/SID/权限/参数验证、模式切换、路径失效修复、检测提示、实际计划任务启动默认场景一次、禁用清理。使用临时 SQLite 和专用任务，不修改用户配置或 Windows ARSO 策略。
- 核心 `desktop_startup`：3 项，覆盖锁屏模拟下普通应用先启动、GUI 延后、暂停/取消、等待不消耗超时和重试。
- 实际重启/冷启动、ARSO 自动登录锁定及锁屏后的真实 GUI 恢复需在用户机器重启验收，本轮没有自动锁屏、重启或改变登录策略。

证据位于 `test-results/desktop-startup`；交付副本位于 `artifacts/desktop-startup/evidence`。
