# 0.4.13 · LaunchFlow 内置 Windows 自动登录

设置 → 启动与后台 → **在 LaunchFlow 中配置自动登录**。无需另外下载或操作 Microsoft Autologon。

1. 在 Windows 管理员授权窗口确认一次。使用当前账户授权；不支持使用另一个管理员账户替当前用户保存配置。
2. 内置窗口自动填入本地/域账户。Microsoft 账户请选择对应类型，填写登录邮箱和账户密码。这里需要 **账户密码，不是 Windows Hello PIN**。
3. 点击 **验证密码并启用自动登录**。每次点击只验证一次密码；验证得到的用户必须是当前 LaunchFlow 用户。失败会显示原因，不自动重试密码。
4. 保存成功后，LaunchFlow 自动登记“普通登录启动”。确认默认场景启动检查通过；必要时点击“允许默认场景自动执行”。下次开机由 Windows 自动登录，再运行默认场景。
5. 再次打开同一窗口可更新密码，或点击 **关闭自动登录并清除已存密码**。取消不会改动配置。

PIN 登录方式保留，普通锁屏不会自动解锁。开机自动登录意味着能接触设备的人可直接进入账户。密码由内置的本机管理员窗口写入 Windows LSA 凭据存储，不经过网页、命令行、工作流、应用数据库、日志或导出；Windows 管理员仍可能读取 LSA 中的凭据。

若检测到其他工具配置的自动登录，需要在内置窗口明确勾选“替换现有自动登录配置”后保存。关闭功能只处理仍与 LaunchFlow 登记记录匹配的配置，避免清除外部修改。保存前备份当前值到进程内存；中途写入或校验失败会回滚；启用标记最后写入。不改变 Windows Hello、组织策略或登录提示策略，也不自动重启。

## 链接无响应修复

0.4.12 的链接由原生自动化 worker 打开；worker 受清理子进程的 Job 管理，新启动的浏览器可能随着 worker 退出被终止。0.4.13 改为主应用的系统关联打开通道，浏览器不再处于该 worker 的清理范围。Windows 登录选项入口同时修复。界面增加打开结果提示和复制说明地址按钮。

## 验证边界

- 内存存储验证密码失败无写入、接管确认、LSA 路由、删除旧明文值、逐个写入点故障回滚、读回校验和撤销。
- 使用真实 WinForms 配置窗口与模拟存储，验证密码遮挡、提交后清空、错误可见、Microsoft 账户模式、保存、取消、重新打开和撤销。
- Tauri 隔离模式禁止真实自动登录配置；前端结果处理使用响应夹具。原有 Run 登记、已有实例、计划任务和默认场景执行继续使用独立数据实测。
- 没有使用真实账户密码、确认 UAC、写入本机 Winlogon/LSA、注销、锁屏或重启。实际凭据验证和开机自动登录仍需用户安装后验收。组织策略、登录横幅及账户限制可能阻止自动登录，登记成功不等于已通过真实重启验收。

微软文档：[Windows 自动登录](https://learn.microsoft.com/en-us/troubleshoot/windows-server/user-profiles-and-logon/turn-on-automatic-logon)、[自动登录密码保护](https://learn.microsoft.com/en-us/windows/win32/secauthn/protecting-the-automatic-logon-password)、[LogonUser](https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-logonuserw)。
