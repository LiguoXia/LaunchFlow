# 应用图标 · v0.4.8

添加应用时，填写或选择本机应用路径即可预览真实图标。已有应用无需重新添加。

显示位置：应用库、添加/编辑应用预览、捕获工作区列表、关闭工作区应用列表、工作流简单编排卡片、步骤配置及应用选择框旁、高级画布、运行历史中的应用步骤、导入映射中的本机应用选择框旁。系统原生下拉菜单的选项仍使用文本。

图标按本机应用路径读取，不启动目标程序，不请求 UAC；无法读取路径或图标时显示通用图标。浏览器演示环境没有本机 IPC 时同样回退。旧应用配置和场景格式保持兼容，图标不写进应用配置、场景快照或导出包。

## 缓存与平台

- 前端去重并合并请求，每批最多 24 个应用；路径输入延迟 150 ms，切换路径立即移除旧图标，丢弃迟到的旧请求。
- 本机应用数据目录下 `automation/application-icons-v1` 保存可重建的 PNG 缓存，最多 256 个；按文件大小和修改时间失效，每条最长 24 小时。前端成功结果缓存 60 秒、失败缓存 5 秒，重新挂载时检查。macOS Bundle ID 可解析应用路径。
- PNG 结果限制在 128 × 128 内，仅通过内嵌 PNG 显示，不加载远程图片。Windows UNC、设备路径和网络驱动器回退为通用图标。
- Windows 使用 [SHGetFileInfoW](https://learn.microsoft.com/zh-cn/windows/win32/api/shellapi/nf-shellapi-shgetfileinfow) 获取图标，并释放图标句柄。
- macOS 使用 [NSWorkspace](https://developer.apple.com/documentation/appkit/nsworkspace) 获取应用图标；本次在 Windows 构建与验收，macOS 实机验收仍待完成。

## 验证（2026-10-05）

- `node scripts/application-icons-smoke.mjs`：6 项真实 Tauri/WebView2 验收通过。覆盖桌面 NoSleepHDv2.0.exe 与记事本图标读取、独立测试窗口捕获、添加预览与路径变更、工作流两种编辑器和运行历史、关闭应用确认列表、重启后复用磁盘缓存。NoSleepHD 仅提取图标，未启动或修改授权。
- `node scripts/cargo.mjs test -p launchflow-core --test application_icons`：2 项通过，覆盖文件变更、缓存损坏恢复和无效路径回退。
- `npm test`：11 项通过，其中新增 2 项验证图标请求去重、批量上限、失败重试和远程图片拒绝。
- `node scripts/cargo.mjs clippy --workspace --all-targets -- -D warnings`：通过。
- `node scripts/desktop-smoke.mjs`：8 项现有桌面集成回归通过，包括编辑保存、执行与历史、草稿、默认场景、取消与后台启动。

截图和桌面报告位于 `test-results/application-icons/`。测试使用独立 SQLite 数据目录和专用窗口，仅保留测试窗口进入截图与流程，不更改用户的场景或关闭用户应用。
