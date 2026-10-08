# LaunchFlow Technical Architecture

Status: 0.3.0 / Phase 3. Windows GUI acceptance passed; macOS source is implemented but unverified on hardware. Phase 4 remains a separate gate.

## Ownership

Tauri owns lifetime, tray, login registration and native shortcuts. React edits one Scene document and subscribes to events. Rust core owns validation, scheduling, triggers, snapshots and SQLite; it has no Tauri dependency. PlatformAdapter contains Windows / macOS services.

```text
src/domain/                  wire types, sequence / graph operations
src/components/              advanced canvas, parameter and trigger forms
src/pages/                   overview, scenes, editor, runs, profiles, settings
src/lib/                     typed IPC and workspace events
crates/launchflow-core/src/
  model.rs                   versioned Scene / Run / Node / Parameter / Trigger
  validation.rs              Kahn DAG validation, outlets, ancestor references
  parameters.rs              strict template parser, binding, secret references
  registry.rs                node validators, definitions, base runners
  workflow_nodes.rs          condition, join, subflow
  engine.rs                  bounded JoinSet scheduler, recovery, family controls
  triggers.rs                TriggerProvider / Registry / Engine
  platform/                  native launch, command scopes, basic system sensors
  automation/                providers, locators, GUI runners, diagnostics, assets, sessions
  storage.rs                 SQLite migrations and durable repositories
native/windows/              C# UI Automation / Win32 / system OCR + WPF harness
native/macos/                Swift AX / ScreenCaptureKit / Vision + AppKit harness
src-tauri/src/lib.rs          host commands, event bridge, tray and lifecycle
```

## Data and migration

SQLite WAL, foreign keys and busy timeout are enabled. Tables: scenes, scene_versions, drafts, application_profiles, runs, settings, and v2 trigger_firings. A partial unique index enforces one default scene. Saving a Scene creates an immutable revision; drafts remain separate and use optimistic version checks.

Migration 1 → 2 is transactional and adds trigger_firings keyed by trigger identity, recording the last claimed schedule occurrence. Scene / profile schemaVersion stays 1; new fields use serde defaults, so legacy history and drafts remain readable. No destructive rewrite is required. Downgrading to a Phase 1 binary is unsupported after migration.

Run captures scene/version, workflow, parameter references, reachable subflow Scene versions, and profiles. A later edit cannot change it. Child runs include parentRunId / parentNodeId; recovery includes resumedFrom / reusedFrom. Legacy Phase 1 runs did not capture profiles, so recovery uses current bindings in that case.

Active queued/running/paused runs become Interrupted on restart. No automatic replay or queue reconstruction occurs. Retention cleanup applies to completed records.

## DAG scheduling

Validation rejects missing endpoints, duplicate IDs/edges, unknown outlets/configs, DAG cycles and subflow cycles. Current bounds are 256 nodes, 4096 edges, depth 16, 32 queued runs per scene, and per-run parallelism 1–32 (default 8).

A central task owns each Run snapshot. Tokio JoinSet executes eligible nodes concurrently. Eligibility comes from edges, never node-array position. All upstream nodes must be terminal; at least one incoming outlet must be active. A condition chooses true or false; inactive descendants become Skipped. Join uses the same dependency rule. An ordinary disabled/skipped node bypasses success dependencies; a disabled condition activates neither branch.

NodeQueued precedes NodeStarted / NodeWaiting. Each attempt has its own timeout. NodeFailed → NodeRetrying → NodeStarted repeats up to the configured retry count, with a scheduler deadline between attempts. Failure policy then stops the graph, skips, pauses for a user decision, or activates failure edges.

Pause uses a shared watch channel across a subflow family: existing operations can complete, but new nodes/retries stop. A user decision in any child blocks generic resume until resolved. Cancel propagates cancellation tokens, drains node tasks and waits for child cancellation to persist. Root concurrency policies return the existing Run (Ignore), wait for every predecessor (Queue), or cancel predecessors then start (Restart). Child runs belong to their parent and do not independently apply root Scene concurrency policies.

Recovery creates a new Run from the original snapshot. Successful and handled node outputs are reused; remaining nodes resume through dependencies. A failed child run can likewise reuse its successful steps. Explicit Restart discards reuse. Execution is not transactional with external programs: a crash between an external side effect and its success record cannot guarantee exactly-once behavior.

## Parameters and outputs

An explicit parser accepts Scene identifiers, run.id / run.startTime, and ancestor node output paths. There is no eval or recursive string evaluation. Exact references preserve JSON types; interpolation accepts scalars, and argument-array numeric/boolean values become individual strings.

Parameter definitions support defaults, required, descriptions, select options, ranges and regex. Trigger parameters bind through the same validator; manual values override manual-trigger presets and Scene defaults. Required manual input is collected by Run Configuration. Automatic triggers must provide their required inputs.

Secret Reference supports vault:ID (Windows Credential Manager / macOS Keychain) and env:NAME. Only references are persisted and forwarded to child runs; a child declares a Secret Reference parameter to resolve it. The UI has metadata/create/update/delete commands but no read-secret command. Runtime values and captured output are scrubbed before publication. This cannot detect all transformed, encoded or otherwise unmarked sensitive output; output capture remains opt-in.

Subflows resolve against captured Scene snapshots and return runId plus node outputs. Fixed Scene IDs are required, making recursion and missing-reference validation possible before execution.

## Events and UI

Persistence precedes event broadcast. Every event carries a whole Run with a monotonic revision; the Tauri bridge emits launchflow://run. React subscribes before bootstrapping and ignores stale revisions. Lag causes a resynchronization snapshot; the UI does not poll SQLite.

TriggerProvider owns validation/observation; TriggerRegistry registers all ten built-ins. A backend 5-second timer observes the cached Scene catalog. Mutations refresh the catalog; lifecycle events and native shortcuts use the same service. Local schedule occurrences claim SQLite deduplication before firing. No catch-up occurs while the app is closed; sensor triggers use edge transitions after a baseline observation. Trigger status is delivered by launchflow://trigger.

React Flow provides transient selection/viewport state; Scene.workflow stores nodes, edges and annotations. Drag completion, connections and graph mutations create undo history and draft saves. Simple mode derives order from edges and is unavailable for branching graphs. Copy/paste remaps IDs, internal edges, output references and group membership. The canvas loads as a separate frontend chunk.

## Platform boundary

Windows: native process launch / associations, process inspection, EnumWindows title matching, TCP/HTTP, WLAN SSID, monitor identity/layout, power status, system hotkeys. Commands enter a Job Object with KILL_ON_JOB_CLOSE. Assignment happens immediately after spawn; there is a small creation-to-assignment window, so deliberate early process escape is not a sandbox guarantee.

macOS: open with argument arrays, process groups for command cancellation, CoreGraphics window titles and display layout, pmset power, networksetup SSID, native Tauri shortcuts/menu bar/autostart. Privacy restrictions can withhold window titles or SSID. Windows source/configuration inspection cannot establish macOS native compilation or runtime behavior.

GUI applications started by application.launch are intentionally outside command scopes and survive workflow cancellation. GUI automation is accessed through AutomationProvider / WindowProvider and 20 registered NodeRunners. Native workers speak bounded stdin/stdout JSON and do not enter the scheduler. Windows uses UIA patterns before SendInput; macOS uses AX before CoreGraphics input. Phase 4 adds workspace.restore using the same executor and native provider boundary.

## Remaining engineering work

The event bus and SQLite store full snapshots; larger graphs need storage/IPC benchmarks and possible event deltas. Per-run limits do not form a global resource budget across unrelated Scenes or nested workflows. External side effects require user judgement during recovery. Hardware transitions and both Mac architectures need real-device acceptance before expanding platform automation.

## GUI automation and assets

Each GUI attempt accumulates LocatorAttempt diagnostics. Locators follow semantic-first priority, then scoped OCR/image and coordinates. Once an action is dispatched, action failure does not move to another target. Input actions share a desktop semaphore; bounded waits release it. The existing executor owns retries, timeouts and cancellation. NodeRunner's optional failure_diagnostics hook adds structured output without a second scheduler. Test Action creates a one-node snapshot, preserving the same executor.

Workers are bundled native resources. Windows Job Objects and kill-on-drop bound worker lifetime; the Mac worker exits on session stdin EOF. Standard operations have a 15-second bridge timeout and an 8 MiB response cap. Picker and recorder have explicit session controls, event broadcasts and at most 256 recorded actions. Recorded secure fields generate references without querying values; masked captures are the only images written by automatic OCR/capture paths.

Content-addressed PNGs live outside SQLite in automation/assets; UUID diagnostic screenshots live in automation/diagnostics. Phase 4 exports contain Schema 2 YAML, versioned manifest and verified PNG assets. OCR/image transient captures use a drop guard. macOS Retina captures report scale, which the platform-neutral matcher converts to logical screen coordinates. Windows OCR exposes no confidence value, which remains explicitly null.

## Workspace and productization

Workspace capture removes transient handles/PIDs, binds windows to ApplicationProfiles, and derives relative rectangles from work areas. Display descriptors include stable native ID, name, resolution, scale, position and primary role. The runner selects the most specific matching monitor condition, falls back across displays, clamps rectangles, and restores normal/maximized/minimized state. Capturing a scene orders unique launch nodes by process start time before layout restoration.

Portable document schema (2), Scene schema (1), package schema (1), and SQLite schema (2) are independent. Bounded YAML parsing rejects duplicate fields, unknown versions/tags and expansion bombs; ZIP validation checks entry names, sizes, PNG decoding and SHA-256 references before preview. The pending import owns an immutable parsed source and expires after 20 minutes. Rebind resolves applications, absolute paths and secret references. Commit revalidates resources, assigns fresh scene/subflow IDs and writes scenes/profiles in one transaction. Imported triggers are disabled and sensitive policy resets to AskEveryTime.

Scene policy is checked for root and reachable subflow snapshots before enqueue. Legacy startup-command authorization is no longer an independent gate. Recovery never automatically replays sensitive nodes with uncertain side effects; explicit confirmation is required for replay, and safeResume rejects uncertainty. Updater maintenance prevents new engine runs and picker/recorder sessions while a confirmed update downloads and installs.

The UI requests updates through host-owned commands only. Release configuration is compiled in; debug and unconfigured release builds disable updates. HTTPS, size/time limits, artifact signature and signed-version verification precede installation. Signing/notarization and real staging-update tests are release gates, not claims established by local compilation.

Retention runs at startup and every 15 minutes, preserves active runs and treats zero days as Forever. Diagnostic bundles use an allowlist of metadata and classified errors with hashed identifiers; arbitrary strings, paths, inputs, outputs and screenshots are omitted. Asset and diagnostic-image garbage collection is not implemented. Product spacing, typography, radii and motion are centralized in src/tokens.css; platform fonts and public Tauri window effects provide native adaptation.
