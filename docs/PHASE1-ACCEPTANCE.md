# Phase 1 — Core Foundation 验收记录

日期：2026-09-30 至 2026-10-01。实际测试环境：Windows 11 x64（10.0.26200）、Rust 1.98.1、Node 22.12.0、WebView2。

## 交付清单

- [x] Tauri 2 桌面应用与 React / TypeScript 界面
- [x] Rust 核心 crate 与桌面宿主解耦；Windows / macOS 平台适配模块
- [x] SQLite WAL、schema 迁移版本、原子持久化
- [x] Scene 新建、编辑/重命名、删除、复制、唯一默认场景
- [x] 场景版本与运行时不可变场景快照
- [x] ApplicationProfile 逻辑身份、平台路径/Bundle ID、参数、Ready 条件
- [x] 简单编辑器：添加、排序/拖动、复制、删除、禁用、撤销/重做
- [x] 草稿防抖保存、离开时提交、草稿恢复、版本冲突检查
- [x] 启动应用、打开文件/目录/网页、延迟、命令、等待进程、等待端口
- [x] 图结构保存；依赖解析与单链调度，不按数组位置假定执行顺序
- [x] 节点总超时、取消、失败阻断；重复运行 Ignore
- [x] 运行前阻止循环、未知节点、缺失绑定、平台不匹配和非法配置
- [x] 后端事件推送运行详情；忽略过期事件版本，丢事件时重新获取快照
- [x] Run History、逐节点结果、版本、时间、可选 stdout/stderr、删除、重新运行当前版本
- [x] 中断运行恢复为 Interrupted，不自动重放
- [x] 托盘/菜单栏、场景菜单、默认场景运行、停止、打开、退出
- [x] 关闭窗口后后台继续；单实例重新打开窗口
- [x] Autostart 插件接入，登录参数 `--startup`，默认关闭
- [x] 默认场景静默运行、启动延迟；托盘停止同时取消尚未开始的启动等待
- [x] 通知开关、历史保留期、浅/深/系统主题
- [x] 命令参数数组；不提升主程序权限；不采集命令输出为默认值
- [x] 可识别凭据字面量持久化拦截、常见敏感日志行过滤、拒绝尚不支持的 Secret 引用
- [x] Windows / macOS x64 / macOS arm64 的 CI 构建矩阵文件

## 已执行的验证

| 检查                                                    | 结果                                                           |
| ------------------------------------------------------- | -------------------------------------------------------------- |
| `npm test`                                              | 4 项前端单元测试通过                                           |
| `npm run build`                                         | TypeScript + Vite 生产构建通过                                 |
| `cargo test -p launchflow-core`                         | 10 项 Rust 单元测试 + 9 项真实集成测试通过                     |
| `cargo fmt --all -- --check`                            | 通过                                                           |
| `cargo clippy --workspace --all-targets -- -D warnings` | 通过                                                           |
| Tauri Windows debug 原生构建                            | 通过；包含实际前端资源                                         |
| Tauri Windows release + NSIS 安装包                     | 通过；生成 x64 当前用户安装包，未配置发行签名                  |
| `npm run test:desktop`                                  | 8 条真实桌面端到端流程通过；无页面 JavaScript 异常             |
| 页面渲染                                                | 检查了真实 WebView2 首页和编辑器截图；截图位于 `test-results/` |

集成测试运行实际测试程序，检测真实进程、连接真实本机 TCP listener、执行带特殊字符的参数数组，验证超时/停止/失败传播与输出过滤。没有用真正的 IDEA 作为测试依赖。

桌面端到端覆盖：

1. 空 SQLite 初始化；
2. 通过实际 UI 创建和编辑场景；
3. 真实 Rust 执行事件 → React 状态 → SQLite 历史；
4. 离开页面/返回后的草稿恢复，保存后撤销仍能保存新版本；
5. 默认场景唯一性与运行历史删除后的状态同步；
6. 取消长等待；
7. 原生窗口关闭后执行继续，第二次启动重新打开同一窗口；
8. 独立进程 `--startup` 不显示主窗口且只执行默认场景。

测试数据库使用临时目录，通过仅 debug build 支持的 `LAUNCHFLOW_TEST_DATA_DIR` 注入。测试还隔离单实例标识、WebView2 缓存与动态本机调试端口，避免与已安装或其他工作目录里的同名应用冲突。测试不会设置用户默认场景或启用日常登录启动。测试完成后关闭测试进程。

## 本机交付文件

- `artifacts/windows/LaunchFlow_0.1.0_x64-setup.exe`：Windows x64 当前用户安装包。
- `artifacts/windows/LaunchFlow.exe`：可直接运行的 release 可执行文件（需要 WebView2）。
- `artifacts/windows/SHA256SUMS.txt`：上述文件的 SHA-256 校验值。
- `artifacts/desktop-smoke.json`：最终桌面端到端测试记录。
- `artifacts/screenshots/`：真实 WebView2 页面截图。

安装包已构建，未替用户执行安装或开启开机启动。

## 验证边界与后续工作

- **没有实际注销/重启 Windows**。已验证 Autostart 的参数入口与静默启动行为；系统登录注册由 Tauri 官方 Autostart 插件实现，需用户在设置中开启。
- **macOS 未在本机运行或完成 CI 执行**。已编写适配和构建矩阵，不将 Windows 的测试结果等同于 macOS 验证。
- **Windows 10 未单独实机验收**。当前测试是在 Windows 11。
- **未配置发行签名/公证**。本地安装包不等同于已签名的正式发行版。
- **未自动绑定或启动用户的 Clash / IDEA / Chrome**。需要在应用库选择本机路径；可按 README 的四步工作流复现目标场景。
- 应用已经运行时 Phase 1 支持 Skip / New Instance；Focus / Restart 属于后续平台能力。
- Phase 1 的停止/超时会取消等待并结束直接启动的 command 子进程，但不保证杀死命令再派生的整个进程树；已启动的 GUI 应用会保留。
- 任意未标记的秘密文本无法可靠识别；Phase 1 禁止用作凭据存储，输出采集只用于明确不含敏感内容的命令。OS Secret Vault 在 Phase 4 实现。
- 并行、分支、子流程、参数展开、额外触发器、重试、暂停/继续与失败处继续留在 Phase 2；GUI 自动化留在 Phase 3；工作区恢复、YAML/Rebind、Vault、更新器留在 Phase 4。

本次停止于 Phase 1，没有铺开后续阶段或加入伪实现。
