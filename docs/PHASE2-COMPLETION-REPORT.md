# Phase 2 Completion Report — Workflow Engine

日期：2026-10-01（Asia/Shanghai）

版本：0.2.0

环境：Windows 11 x64、Node 22、Rust stable 1.98、WebView2。

Phase 2 实现与 Windows 验收完成；macOS 保留明确的未验证项。本次停止于 Phase 2，没有开始 Phase 3 GUI Automation。

## 已完成能力

| 能力 | 最终行为 |
| --- | --- |
| DAG Validation | 启动前检查循环、缺失节点、重复/非法边、出口、未知节点配置、上游输出引用；检查子流程缺失与递归 |
| 依赖调度 | 按 Edge 决定执行顺序，节点数组可逆序；Tokio 异步任务真正并行，默认并行度 8，可配置 1–32 |
| 多上游 / Join | 所有上游结束且至少一个有效分支到达后继续；未选中的分支传播 Skipped，不阻塞汇合 |
| Condition | 14 类条件，true / false 出口；同一 Scene 可包含 Windows / macOS 两条分支，未选中的平台节点不执行 |
| Subflow | 固定 Scene 引用、启动时捕获子场景版本、传参、返回 Run ID 和节点输出；父子历史关联、取消传播、循环检测、失败恢复 |
| 参数 | String / Number / Boolean / Select / File / Directory / Secret Reference；默认值、必填、描述、选项、范围和正则校验 |
| Run Context | `${param}`、`${run.id}`、`${run.startTime}`、`${node.ID.output.field}`；运行时解析，无 eval |
| 运行配置 | 手动运行显示参数弹窗，必填值在执行前收集；手动触发器预设参数可覆盖默认值，用户输入优先 |
| Trigger Engine | 全部十种触发器经 TriggerProvider / TriggerRegistry 接入；后端服务运行，不把调度放在 React |
| 并发策略 | Ignore 返回已有活动 Run；Queue 顺序排队；Restart 取消前序后执行；取消队列中间项不会使后续项提前执行 |
| Retry / Timeout | 每次尝试单独计时，失败、重试与再次启动均发事件；取消可中断等待和托管命令 |
| Failure Policy | Stop Workflow、Skip And Continue、Ask User、Failure Branch 四种策略 |
| Pause / Resume / Cancel | 暂停阻止新调度，当前操作可完成；子流程共享暂停状态；取消停止后续任务，保留已经启动的用户 GUI 应用 |
| Continue From Failure | 重试、继续、跳过、重启；续跑创建新 Run，复用成功结果；子流程成功步骤同样复用 |
| 快照 / 事件 | 保存 Scene ID / version / workflow / parameters，以及子流程与应用绑定快照；先持久化再发递增 revision 事件 |
| Advanced Editor | 连线、拖动、平移、缩放、框选、多选、复制粘贴、复制为新节点、删除、撤销重做、分组、注释、禁用、自动布局 |
| 单一 Workflow Model | 简单和高级模式共用 nodes / edges / annotations；简单模式按连线推导顺序，不把分支图自动改写成链 |

输出引用只允许上游节点；完整引用保留 JSON 类型。命令使用参数数组，数字 / 布尔参数单独字符串化，不拼接 shell。复制节点会重写被复制集合内的输出引用，外部引用保持原样。

禁用或跳过普通节点会继续其非 failure 后续；禁用条件节点不会同时启动两条分支。Ask User 必须先选择重试 / 跳过，父流程不能绕过子流程待决状态直接恢复。

## Phase 1 自检

正式修改引擎前完成自检，记录见 [PHASE1-SELF-CHECK.md](PHASE1-SELF-CHECK.md)。

- 原 Rust 19 项、前端 4 项通过；真实桌面基础 8 条流程通过。
- 扩展审计后共 9 条桌面流程通过：增加 ApplicationProfile 保存/读取/删除、隔离登录注册启用/读取/关闭、原生文件/目录/URL 打开。URL 由本机 HTTP 服务确认收到请求。
- 原生窗口关闭后后台运行、第二次启动恢复窗口、静默登录入口、唯一默认场景均有真实进程验证。
- 必要修复仅隔离 debug 验收的登录注册名称；生产沿用原名。没有为 Phase 2 重写已经稳定的托盘、基础页面或应用库。
- 没有执行整机注销/登录；文件/目录关联仅验证系统派发成功，未检查外部应用界面。macOS 菜单栏等不能在 Windows 上实测。

## 实际测试结果

| 检查 | 结果 |
| --- | --- |
| Rust 核心测试 | **44 / 44 通过**：基础单元 6、原执行集成 9、DAG 21、条件 1、迁移 1、触发器 6 |
| 前端测试 | **9 / 9 通过**：编辑器/事件 4、图操作 5 |
| TypeScript + Vite | 生产构建通过；高级画布拆为独立加载块 |
| Rustfmt | 通过 |
| Clippy | `--workspace --all-targets -- -D warnings` 通过 |
| Windows debug 原生构建 | 通过，真实 WebView2 内嵌生产前端 |
| 桌面集成 | **15 / 15 通过**，页面 JavaScript 异常为 0 |
| 已安装应用验收 | Clash / Docker / IDEA / Chrome 流程成功；DataGrip 按用户确认禁用 |
| Windows release / NSIS | **通过**；x64 release 可执行文件与 0.2.0 当前用户安装包已生成，安装包约 4.50 MiB |
| macOS 构建配置 | 两个 target 的 Cargo metadata、目标依赖、Tauri 配置和 CI 矩阵检查完成；没有 Mac 原生编译结果 |

Rust 测试覆盖拓扑顺序、实际并行、Join、双分支、重试、超时、四类失败策略、暂停/取消、参数校验、缺少必填值、运行快照、子流程成功/失败/取消/递归、三种并发策略和中间队列取消。使用真实子进程、TCP listener、HTTP 204 服务验证系统边界。

专门的副作用测试向文件追加内容，确认续跑不会重复成功步骤；命令超时测试检查子孙进程已结束；Secret Reference 测试检查父子 Run JSON 中均不含解析值。

十五条桌面流程：

1. 隔离 SQLite 启动；
2. 实际 UI 创建/编辑 Scene；
3. 运行事件实时显示并保存历史；
4. 草稿恢复与撤销版本；
5. 默认 Scene 唯一性和历史删除；
6. 取消长任务；
7. 关窗仍执行、再次启动恢复窗口；
8. 隐藏启动入口仅运行默认 Scene；
9. 完整 DAG、真实进程 / TCP、三路并行、Join、OS、Retry、Ignore；
10. 画布复制/粘贴、分组、禁用、注释、撤销/重做、保存；
11. UI 暂停/恢复/停止，确认暂停时后续节点未调度；
12. IPC Queue / Restart；
13. UI 从失败处继续，不重复已成功副作用；
14. UI 必填参数弹窗，特殊字符按字面值执行；
15. 操作系统注册快捷键并通过实际按键触发成功。

### 最终验收工作流

```text
Manual → Check Network → Clash → Wait Port → Docker → Docker Ready
                                                        ↓
                                               IDEA / DataGrip / Chrome
                                                        ↓
                                                       Join
                                                        ↓
                                                OS → Windows / macOS
                                                        ↓
                                                     Command
```

**独立测试程序验收**：五个不同名称的原生进程替代第三方应用，每个确实启动、监听 TCP 并写入 PID。Docker Ready 故意延迟以触发 Retry。IDEA / DataGrip / Chrome 三个任务时间区间重叠；Join 在三者结束后开始。节点数组逆序保存，仍按 Edge 成功运行。Run `fdff2067-c9f4-41a0-b8f7-0e64ce604b66` 成功，耗时 3964 ms。7897 被本机 Clash 占用时测试进程使用临时空闲端口。

**已安装应用验收**：Run `27e0557f-e370-4cf0-a229-4e17bc0d1943` 成功，耗时 18553 ms。实际连接 `127.0.0.1:7897`；Docker Ready 使用 `docker info --format {{.ServerVersion}}`，重试 3 次后返回版本 `29.1.3`；IDEA 与 Chrome 的执行区间重叠；Join 完成后 PowerShell 输出验收文本。应用已运行时遵循配置的重复启动策略，不承诺每次新开实例。

本机 **没有 DataGrip**，该真实应用节点禁用，不能宣称已验证 DataGrip 本体。测试程序中的三路并行验证不等于安装或运行了 DataGrip。网络检查在此次验收中表示本机代理端口可达，没有声称互联网全局连通。

## 数据库 Migration

SQLite `PRAGMA user_version`：**1 → 2**。在事务中增加 `trigger_firings`（trigger_key 主键、occurrence），用于定时触发去重，不删除或重建已有业务数据。

Scene / ApplicationProfile 的 `schemaVersion` 仍为 1，采用增量字段和 serde 默认值：

- Scene：parameters、triggers、concurrentRunPolicy=Ignore、maxParallel=8。
- Workflow：annotations 默认空；Edge.outlet 默认 success。
- Run：parameterSnapshot、subflowSnapshots、profilesSnapshot、parentRunId / parentNodeId、resumedFrom。
- NodeRun：output、outlet、reusedFrom。

迁移测试使用临时 SQLite v1 文档，验证默认场景、草稿、历史仍存在，新默认字段可读取、重复打开幂等、触发去重可持久化。旧 Run 不会重放。旧 Phase 1 Run 未保存应用绑定快照，恢复时使用当前绑定。

升级后不支持用 Phase 1 二进制直接降级打开 v2 数据库；若需回退，应使用升级前备份。

## 新增 Node Types

| Node type | 内容 |
| --- | --- |
| `flow.condition` | OS、Process Running、Window Exists、File、Directory、TCP、HTTP、Environment、Command Result、Current Time、Weekday、Network、Monitor Count、Power State |
| `flow.join` | 等待有效依赖汇合 |
| `flow.subflow` | 引用固定 Scene，传参并返回子 Run 结果 |

总计 11 种节点。原 8 种类型保持。Condition 当前为 true / false；多出口 Switch 是后续扩展，未实现。

## Trigger Types

统一注册十种：`manual`、`systemLogin`、`appStarted`、`schedule`、`weekday`、`globalHotkey`、`networkAvailable`、`wifiSsid`、`monitorChanged`、`powerState`。

- System Login 只允许唯一默认场景执行；其他 Scene 即使配置登录触发器也不会在登录时执行。
- Schedule / Weekday 使用本地 HH:mm 和星期，SQLite 记录已触发的分钟，关闭期间不补跑。
- 传感器在后端每 5 秒观察一次，首次建立基线，变化且匹配时触发；React 不轮询数据库。
- Network 为配置的 TCP 端点恢复；Monitor Changed 比较显示器身份与布局；Wi-Fi 匹配 SSID；Power 匹配 ac / battery。
- Global Hotkey 由操作系统注册，注册失败/冲突通过触发器状态显示。
- 同 Scene 可配置多种触发器，均受该 Scene 的重复运行策略控制。

## Known Issues / 验证边界

1. **macOS 未原生编译或实机运行**；Windows 10 也未单独实测。macOS 窗口标题可能需要 Screen Recording 权限，SSID 可能受定位隐私限制。没有把配置检查当作跨平台验收。
2. **硬件变化未做实物验收**：Windows 的显示器/电源基础查询已测试；传感器状态变化使用可控适配器测试，网络恢复使用真实 TCP。没有拔插显示器、电源或切换用户 Wi-Fi。SSID 平台代码不代表已验证所有系统权限组合。
3. Windows 托盘构建、隐藏/恢复与后台服务已验证；未自动点击托盘菜单，也未执行真实注销/登录。安装包未在本机执行安装向导。
4. Secret Reference 仅支持环境变量引用，没有完整 Vault。转交子流程保持引用，接收方应声明同类型；编码/变形后的秘密文本不能保证全部识别，敏感命令应关闭输出采集。
5. 命令退出/取消/超时会关闭 Windows Job / macOS 进程组；Windows 当前在 spawn 后立即加入 Job，仍有很短的加入前派生窗口，不能视为对主动逃逸进程的安全隔离。
6. 继续执行可复用已记录成功的步骤，但不能实现外部副作用的 exactly-once。异常中断时可能发生“外部操作完成但成功记录尚未持久化”；用户应检查该步骤再决定继续/跳过。
7. 暂停不冻结已启动的操作，其超时仍按实际时间计算。队列和暂停在程序异常退出后标为 Interrupted，不自动恢复执行。
8. 定时精度为分钟，没有 cron 表达式、漏跑补偿或独立时区；夏令时重复的同一本地分钟按一个 occurrence 去重。
9. 所有节点做结构校验；实际路径和当前平台约束在节点被选中执行时检查，避免未选中的另一系统分支误报。因此已失效的磁盘路径可能在前序任务完成后才导致失败。
10. Windows 交付未签名；macOS 签名、公证尚未执行。DataGrip 本体验收缺失由本机未安装造成。

## Technical Debt

- 事件与 SQLite 目前传输/存储完整 Run 快照；大图和长输出需做内存、磁盘、IPC 压力测试，再决定增量事件或分离日志。
- 现有并行限制是每 Run，尚无跨 Scene / 多层子流程的全局资源配额。上限：256 节点、4096 边、16 层子流程、32 项同场景活动队列。
- 子流程参数、部分复杂条件和触发参数仍使用有校验的 JSON 编辑框；无变量自动补全。
- 画布自动布局采用拓扑层级；长链适配全图时文字较小，可缩放编辑。更多连线路由与布局优化尚未进行。
- 传感器定时观察尚未统一改为原生事件通知；历史状态缓存需在大规模反复编辑场景时进一步评估。
- 缺少跨平台发行流水线的实际运行证据以及升级/降级用户流程测试。

## Phase 3 前必须解决 / 确认

1. 在 macOS Intel 与 Apple Silicon 上完成原生编译和运行验收，修复可能的目标平台编译或权限问题；验证菜单栏、登录、快捷键、取消进程组。
2. 实测 Wi-Fi、显示器、电源变化和 Windows 登录周期；明确权限拒绝/无传感器时的产品提示。
3. 为进程树管理消除或明确接受 Windows spawn → Job 的短窗口；继续保持应用启动与托管命令生命周期分离。
4. 以较大 DAG / 多子流程并发进行容量测试，确定全局限制与快照事件成本。
5. 新增 GUI Automation 前单独设计授权、隐私、可取消性及不可重复副作用边界；本阶段不提前实现相关自动化。

签名、公证属于对外分发门槛，应在正式发行前完成，不作为已经通过的 Phase 2 测试。

## 交付与复现

- [Windows 安装包](../artifacts/phase2/windows/LaunchFlow_0.2.0_x64-setup.exe)
- [便携可执行文件](../artifacts/phase2/windows/LaunchFlow.exe)
- [SHA-256](../artifacts/phase2/windows/SHA256SUMS.txt)
- [15 条桌面验收结果](../artifacts/phase2/evidence/desktop-smoke.json)
- [真实应用完整记录](../artifacts/phase2/evidence/phase2-real-apps.json)
- [测试程序 Scene 与绑定](../artifacts/phase2/evidence/phase2-acceptance-scene.json)
- [测试程序 Run](../artifacts/phase2/evidence/phase2-acceptance-run.json)
- [画布截图](../artifacts/phase2/evidence/phase2-canvas.png)
- [运行截图](../artifacts/phase2/evidence/phase2-run.png)

```sh
npm test
npm run build
node scripts/cargo.mjs test -p launchflow-core
node scripts/cargo.mjs fmt --all -- --check
node scripts/cargo.mjs clippy --workspace --all-targets -- -D warnings
node scripts/cargo.mjs build -p launchflow-core --bin launchflow-fixture
node scripts/tauri.mjs build --debug --no-bundle
npm run test:phase2
node scripts/tauri.mjs build --bundles nsis
```

实际第三方应用验收通过 `LAUNCHFLOW_REAL_APPS=1` 加到桌面验收脚本，路径位于 `scripts/real-app-acceptance.mjs`。数据目录独立，测试不会替用户改动日常默认场景或登录设置。原 Phase 1 制品保留在 `artifacts/windows/`。
