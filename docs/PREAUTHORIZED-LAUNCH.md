# Windows 指定应用预授权启动 · 0.4.4

## 使用方式

在「应用库 → 编辑应用配置」勾选「使用预授权启动（首次确认，后续免确认）」，核对程序路径与默认启动参数，点击「保存并授权免确认启动」，然后在 Windows UAC 窗口亲自确认一次。授权不会立即启动应用。

状态显示「已授权」后，工作流中的该应用会通过已授权计划任务启动，不再为每次启动弹 UAC。首次登记要求当前 Windows 账户具有管理员资格；不支持使用另一个管理员账户代为登记。

- 授权限定当前 Windows 用户、本机程序路径、EXE 文件摘要和固定启动参数。更换电脑/账户、程序升级或配置改变后，需要重新授权。
- 工作流启动节点的额外参数必须与批准配置匹配；本版请将固定参数放在应用库的「默认启动参数」，把节点额外参数留空。动态参数不会在已有授权下自动获准。
- 授权缺失、禁用或失效时，步骤报错并遵循失败策略，不自动重试、不回退到 UAC 启动。
- 如应用已经运行，仍遵循启动节点原有的「跳过/新实例」策略。Ready 条件在确认新进程已创建之后继续执行。
- 点击「刷新授权状态」重新检查；点击「撤销免确认授权」删除任务。撤销不结束已启动的用户程序。取消勾选仅切换启动方式，不等同于撤销；删除应用配置前必须先撤销授权。

## 实现和授权范围

首次授权通过标准 `runas` 启动短时登记进程。系统 Task Scheduler 中每个应用只有一个固定动作、没有时间/登录触发器，使用当前用户的 InteractiveToken 与 Highest 权限。没有存储密码，也不要求 LaunchFlow 主进程一直处于管理员权限。

计划任务位于 `\LaunchFlow-<当前用户 SID 摘要>\App-<应用 ID 摘要>`。程序配置和启动助手保存在 `%ProgramData%\LaunchFlow-<当前用户 SID 摘要>`，所有者为 Administrators；SYSTEM/Administrators 可修改，当前用户仅可读取/执行。任务额外允许当前用户删除，以便撤销无需再次 UAC；它不允许普通权限进程修改动作。

任务运行受保护的 GUI 子系统助手，参数只有固定授权键与本次随机回执编号。它不从用户可写位置读取命令、参数或可执行助手。助手重新验证任务定义、ACL、账户、授权记录与 EXE 摘要，持有 EXE 的只读共享句柄直到创建进程结束，再写受保护的启动回执。LaunchFlow 收到成功回执才确认启动请求完成。

同一 Windows 用户的其他进程也可调用这个已批准的固定任务；授权并不限定于 LaunchFlow 进程身份。目标应用加载的 DLL、插件、配置和脚本仍受该应用自身机制控制，EXE 摘要检查不等同于对应用所有依赖的沙箱验证。应只为可信应用开启管理员预授权。

撤销后受保护配置、助手和少量回执会保留为无触发能力的文件；每个应用仅保留最近 64 份启动回执。本版不在撤销时再发起 UAC 删除这些受保护文件。若准备卸载，先撤销应用授权；如需清理剩余存储，可由管理员删除该用户对应的上述 ProgramData 目录。安装目录与保护目录相互独立，已批准程序不依赖 LaunchFlow 安装路径。

取消登记或超时会停止普通权限请求助手；尚未登记的提升权限助手还会检查请求进程与有效期。若操作系统已经完成登记，请以刷新后的真实状态为准。已经启动的外部应用不做回滚。Windows 系统策略、任务计划服务或管理员保护设置仍可能限制此功能。

## 验证

自动化覆盖旧配置缺省、数据库保留选项、固定任务请求、无授权不降级、不重试、拒绝普通用户改写任务的 ACL 校验、无效输入与路径、桌面选项/状态/保存/重启、真实 Task Scheduler 未授权查询和撤销幂等操作。

命令：

```text
node scripts/build-native.mjs
node scripts/cargo.mjs test -p launchflow-core
node scripts/cargo.mjs clippy --workspace --all-targets -- -D warnings
npm test
node scripts/test-preauthorization.mjs
node scripts/tauri.mjs build --debug --no-bundle
node scripts/uac-smoke.mjs
```

需要人工在场的验收：`node scripts/test-preauthorization.mjs --approve`。它注册一个独立测试程序，要求手动点击一次 UAC，随后验证两次真实管理员启动、参数完整性、参数改变拒绝、EXE 变更拒绝（包括直接调用任务）、普通权限修改任务被拒绝与撤销。结束时撤销该测试任务。不会自动点击安全桌面。

0.4.3 修复了登记时的账户校验：本机 Task Scheduler 会将输入的 SID 转为当前账户名称，旧版直接比较两段文字而误判任务被修改。现在先将账户名称解析成 SID，再核对身份；未知账户和其他账户仍被拒绝。新增登记阶段、异常类型和 Windows HRESULT 诊断，通过仅供当前请求使用的命名管道返回，并校验报告进程 PID。

如果 0.4.2 登记失败后留下了旧版助手与任务，0.4.3 会提示重新授权，不会将旧助手视为可正常启动的授权。升级后请重新点击「保存并授权免确认启动」，确认一次 UAC，更新受保护的助手和配置。

0.4.4 修复了「已授权但启动失败：ArgumentException」：旧版把 `object[]` 传给 COM `RegisteredTask.Run`，产生 `SAFEARRAY(VARIANT)`，本机实际返回 `0x80070057 / Value does not fall within the expected range.`。现在传入单个字符串（BSTR），由 Windows 将其替换到固定任务动作的 `$(Arg0)`，对应本次回执编号。目标路径、固定启动参数和权限校验均保留。

**NoSleepHD 实机结果：** 使用用户桌面上已登记的 `NoSleepHDv2.0.exe` 授权，先复现「状态已授权、启动报 ArgumentException」，修复后连续两次预授权启动均成功，获得两份 `ok: true` 的受保护回执，并观察到新进程。无需重新登记授权，也未再次触发 UAC。保留原有任务与用户授权配置。

0.4.3 中有效的授权可继续使用，无需撤销后重建。0.4.2 的旧版助手仍需按前文重新授权。本轮通过 23 项原生校验、25 项 Rust 启动/日志/产品回归、9 项前端测试和 9 项真实桌面检查，Clippy 通过。0.4.4 证据见 `artifacts/task-launch-fix/evidence/`；历史验证记录保留在之前版本的 artifacts 目录。

0.4.4 新增持久化启动诊断日志：运行详情和设置页可点击「复制诊断日志」，诊断 ZIP 也包含启动日志。使用方法与记录范围见 [APPLICATION-DIAGNOSTICS.md](APPLICATION-DIAGNOSTICS.md)。

## 分发

本地安装包与便携版包含新增的 `native/launchflow-authorized.exe`，必须保留整个 native 目录。Windows 签名/签名验证脚本也已纳入此助手。此版本仍为未签名本地构建；macOS 不显示预授权设置，旧发行报告中的其他验收缺口不因此消除。

参考：[任务安全上下文](https://learn.microsoft.com/en-us/windows/win32/taskschd/security-contexts-for-running-tasks)、[任务 DACL 设置](https://learn.microsoft.com/en-us/windows/win32/taskschd/registeredtask-setsecuritydescriptor)、[Run 参数类型与 Arg0](https://learn.microsoft.com/en-us/windows/win32/taskschd/registeredtask-run)。
