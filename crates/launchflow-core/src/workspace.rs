//! Portable workspace layouts use display characteristics, never a monitor index.
use crate::{
    automation::{AutomationProvider, Rect, WindowLocator},
    model::*,
    registry::{self, NodeContext, NodeDefinition, NodeOutput, NodeRunner},
    Error, Result,
};
use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DisplayDescriptor {
    pub id: String,
    pub name: String,
    pub bounds: Rect,
    pub work_area: Rect,
    pub scale: f64,
    pub primary: bool,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CapturedWindow {
    pub identity: WindowLocator,
    pub application: ApplicationProfile,
    pub started_at: Option<String>,
    pub display: DisplayDescriptor,
    pub bounds: Rect,
    pub relative: Rect,
    pub state: WindowState,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Capture {
    pub displays: Vec<DisplayDescriptor>,
    pub windows: Vec<CapturedWindow>,
}
#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum LayoutMode {
    #[default]
    Relative,
    Exact,
}
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum WindowState {
    Normal,
    Maximized,
    Minimized,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WindowLayout {
    pub application_id: String,
    pub identity: WindowLocator,
    pub display: DisplayDescriptor,
    pub bounds: Rect,
    pub relative: Rect,
    pub state: WindowState,
}
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MonitorCondition {
    pub count: Option<usize>,
    #[serde(default)]
    pub display_names: Vec<String>,
}
impl MonitorCondition {
    fn matches(&self, displays: &[DisplayDescriptor]) -> bool {
        self.count.is_none_or(|n| n == displays.len())
            && self
                .display_names
                .iter()
                .all(|name| displays.iter().any(|d| &d.name == name))
    }
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkspaceProfile {
    pub name: String,
    pub condition: MonitorCondition,
    pub windows: Vec<WindowLayout>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RestoreConfig {
    #[serde(default)]
    pub mode: LayoutMode,
    pub profiles: Vec<WorkspaceProfile>,
    #[serde(default)]
    pub skip_missing_windows: bool,
}

pub fn match_display<'a>(
    saved: &DisplayDescriptor,
    current: &'a [DisplayDescriptor],
) -> Option<(&'a DisplayDescriptor, &'static str)> {
    if let Some(d) = current
        .iter()
        .find(|d| !saved.id.is_empty() && d.id == saved.id)
    {
        return Some((d, "exact"));
    }
    // Similarity requires matching resolution, scale and name. Role is the next fallback.
    if let Some(d) = current
        .iter()
        .filter(|d| {
            (d.bounds.width - saved.bounds.width).abs() < 2.
                && (d.bounds.height - saved.bounds.height).abs() < 2.
                && (d.scale - saved.scale).abs() < 0.1
                && (saved.name.is_empty() || d.name == saved.name)
        })
        .min_by(|a, b| {
            let distance = |d: &DisplayDescriptor| {
                (d.bounds.x - saved.bounds.x).abs() + (d.bounds.y - saved.bounds.y).abs()
            };
            distance(a).total_cmp(&distance(b))
        })
    {
        return Some((d, "similar"));
    }
    if let Some(d) = current.iter().find(|d| d.primary == saved.primary) {
        return Some((d, "role"));
    }
    current
        .iter()
        .find(|d| d.primary)
        .or_else(|| current.first())
        .map(|d| (d, "primary"))
}
pub fn relative(bounds: &Rect, area: &Rect) -> Rect {
    Rect {
        x: (bounds.x - area.x) / area.width,
        y: (bounds.y - area.y) / area.height,
        width: bounds.width / area.width,
        height: bounds.height / area.height,
    }
}
pub fn placement(window: &WindowLayout, display: &DisplayDescriptor, mode: LayoutMode) -> Rect {
    let a = &display.work_area;
    let b = if mode == LayoutMode::Relative {
        Rect {
            x: a.x + window.relative.x * a.width,
            y: a.y + window.relative.y * a.height,
            width: window.relative.width * a.width,
            height: window.relative.height * a.height,
        }
    } else {
        window.bounds.clone()
    };
    // Even an exact layout must remain reachable after an unplug or resolution change.
    let width = b.width.clamp(100_f64.min(a.width), a.width);
    let height = b.height.clamp(80_f64.min(a.height), a.height);
    Rect {
        x: b.x.clamp(a.x, a.x + a.width - width),
        y: b.y.clamp(a.y, a.y + a.height - height),
        width,
        height,
    }
}
pub fn validate_config(c: &RestoreConfig) -> Result<()> {
    if c.profiles.is_empty() || c.profiles.len() > 20 {
        return Err(Error::Validation("Choose 1–20 workspace profiles".into()));
    }
    let mut names = std::collections::HashSet::new();
    for p in &c.profiles {
        if p.name.trim().is_empty()
            || !names.insert(&p.name)
            || p.windows.is_empty()
            || p.windows.len() > 100
            || p.condition.count.is_some_and(|n| n == 0 || n > 32)
        {
            return Err(Error::Validation(
                "Workspace profiles need unique names, windows and a valid monitor condition"
                    .into(),
            ));
        }
        for w in &p.windows {
            if w.identity.is_empty()
                || !w.bounds.valid()
                || !w.relative.valid()
                || !w.display.bounds.valid()
                || !w.display.work_area.valid()
                || !w.display.scale.is_finite()
                || w.display.scale <= 0.
                || w.relative.width > 10.
                || w.relative.height > 10.
            {
                return Err(Error::Validation(
                    "Invalid workspace window or display geometry".into(),
                ));
            }
        }
    }
    Ok(())
}
fn native_error(e: crate::automation::AutomationError) -> Error {
    Error::Runtime(format!("{}: {}", e.code, e.message))
}
pub async fn capture(
    provider: &dyn AutomationProvider,
    os: &str,
    known: &[ApplicationProfile],
) -> Result<Capture> {
    let raw = provider
        .request(json!({"op":"workspaceCapture"}))
        .await
        .map_err(native_error)?;
    let displays: Vec<DisplayDescriptor> = serde_json::from_value(raw["displays"].clone())?;
    if displays.is_empty() || displays.iter().any(|d| !d.work_area.valid()) {
        return Err(Error::Runtime("No usable displays are available".into()));
    }
    let mut windows = Vec::new();
    for w in raw["windows"].as_array().into_iter().flatten() {
        let bounds: Rect = serde_json::from_value(w["normalBounds"].clone())?;
        if !bounds.valid() {
            continue;
        }
        let app = w["application"].as_str().unwrap_or("");
        let path = w["executable"].as_str().unwrap_or("");
        let application = known
            .iter()
            .find(|p| {
                if os == "windows" {
                    !path.is_empty() && p.windows.executable.eq_ignore_ascii_case(path)
                } else {
                    !path.is_empty() && p.macos.app_path == path
                }
            })
            .cloned()
            .unwrap_or_else(|| ApplicationProfile {
                schema_version: 1,
                id: id(),
                display_name: app.trim_end_matches(".exe").to_string(),
                windows: if os == "windows" {
                    WindowsBinding {
                        use_preauthorized_task: false,
                        run_as_administrator: false,
                        executable: path.into(),
                        process_name: app.into(),
                    }
                } else {
                    WindowsBinding::default()
                },
                macos: if os == "macos" {
                    MacosBinding {
                        app_path: path.into(),
                        bundle_id: w["bundleId"].as_str().unwrap_or("").into(),
                        process_name: app.into(),
                    }
                } else {
                    MacosBinding::default()
                },
                launch_arguments: vec![],
                ready_detection: None,
            });
        let display = displays
            .iter()
            .find(|d| w["displayId"].as_str() == Some(&d.id))
            .unwrap_or(&displays[0])
            .clone();
        let class = w["className"].as_str().unwrap_or("");
        windows.push(CapturedWindow {
            identity: WindowLocator {
                application: app.into(),
                title: w["title"].as_str().unwrap_or("").into(),
                class_name: if class.starts_with("HwndWrapper") {
                    String::new()
                } else {
                    class.into()
                },
                ..Default::default()
            },
            application,
            started_at: w["startedAt"].as_str().map(str::to_string),
            relative: relative(&bounds, &display.work_area),
            bounds,
            display,
            state: serde_json::from_value(w["state"].clone())?,
        });
    }
    windows.sort_by(|a, b| {
        a.started_at
            .as_deref()
            .unwrap_or("~")
            .cmp(b.started_at.as_deref().unwrap_or("~"))
    });
    Ok(Capture { displays, windows })
}

pub struct RestoreRunner;
#[async_trait]
impl NodeRunner for RestoreRunner {
    fn definition(&self) -> NodeDefinition {
        let mut mode = registry::field(
            "mode",
            "布局模式",
            "select",
            true,
            "相对比例布局默认优先；Exact 仍会将窗口限制在可见区域",
        );
        mode.options = vec!["relative".into(), "exact".into()];
        registry::definition(
            "workspace.restore",
            "恢复工作区",
            "按显示器条件选择布局；缺失显示器自动回退",
            "workspace",
            vec![
                registry::field(
                    "profiles",
                    "工作区布局",
                    "json",
                    true,
                    "在工作区页面捕获 Office / Home / Laptop 布局",
                ),
                mode,
                registry::field(
                    "skipMissingWindows",
                    "跳过未找到的窗口",
                    "boolean",
                    false,
                    "显示器缺失始终回退；此项仅控制应用窗口未找到时的行为",
                ),
            ],
            json!({"mode":"relative","profiles":[],"skipMissingWindows":false}),
            true,
        )
    }
    fn validate(&self, config: &Value) -> Result<()> {
        validate_config(&serde_json::from_value(config.clone())?)
    }
    async fn run(&self, config: &Value, ctx: &NodeContext) -> Result<NodeOutput> {
        let c: RestoreConfig = serde_json::from_value(config.clone())?;
        validate_config(&c)?;
        // Layout writes must not move a target beneath another running GUI action.
        let _desktop = crate::automation::runner::desktop_lock()
            .acquire()
            .await
            .map_err(|_| Error::Runtime("Desktop action coordinator is unavailable".into()))?;
        let provider = ctx.platform.automation();
        let displays: Vec<DisplayDescriptor> = serde_json::from_value(
            provider
                .request(json!({"op":"displays"}))
                .await
                .map_err(native_error)?,
        )?;
        if displays.is_empty() {
            return Ok(NodeOutput {
                message: "No displays connected; layout skipped".into(),
                ..Default::default()
            });
        }
        if displays.iter().any(|d| !d.work_area.valid()) {
            return Err(Error::Runtime("Invalid display geometry".into()));
        }
        let profile = c
            .profiles
            .iter()
            .filter(|p| p.condition.matches(&displays))
            .max_by_key(|p| {
                usize::from(p.condition.count.is_some()) + p.condition.display_names.len()
            })
            .unwrap_or(&c.profiles[0]);
        let mut results = Vec::new();
        for w in &profile.windows {
            let (display, matched) =
                match_display(&w.display, &displays).expect("nonempty displays");
            let mut identity = w.identity.clone();
            identity.handle = None;
            identity.pid = None;
            if let Some(app) = ctx.profiles.iter().find(|p| p.id == w.application_id) {
                identity.application = if ctx.platform.os() == "windows" {
                    app.windows.process_name.clone()
                } else if !app.macos.bundle_id.is_empty() {
                    app.macos.bundle_id.clone()
                } else {
                    app.macos.process_name.clone()
                };
            }
            let request = json!({"op":"workspaceRestore","window":identity,"bounds":placement(w,display,c.mode),"state":w.state});
            let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(10);
            loop {
                match provider.request(request.clone()).await {
                    Ok(_) => {
                        results.push(json!({"applicationId":w.application_id,"displayMatch":matched,"status":"restored"}));
                        break;
                    }
                    Err(e) if e.code == "notFound" && tokio::time::Instant::now() < deadline => {
                        tokio::time::sleep(std::time::Duration::from_millis(500)).await
                    }
                    Err(e) if c.skip_missing_windows && e.code == "notFound" => {
                        results.push(json!({"applicationId":w.application_id,"status":"missing"}));
                        break;
                    }
                    Err(e) => return Err(native_error(e)),
                }
            }
        }
        Ok(NodeOutput {
            message: format!("Workspace {} restored", profile.name),
            output: json!({"profile":profile.name,"windows":results}),
            ..Default::default()
        })
    }
}

pub fn scene_from_capture(
    name: &str,
    windows: Vec<CapturedWindow>,
    capture_layout: bool,
    profile_name: &str,
    count: usize,
) -> Result<(Scene, Vec<ApplicationProfile>)> {
    if windows.is_empty() || windows.len() > 100 {
        return Err(Error::Validation("Select 1–100 windows".into()));
    }
    let mut scene = Scene::new(name);
    let mut apps: Vec<ApplicationProfile> = Vec::new();
    let mut layouts = Vec::new();
    for w in windows {
        let application_id = if let Some(app) = apps.iter().find(|a| {
            a.windows.executable == w.application.windows.executable
                && a.macos.app_path == w.application.macos.app_path
        }) {
            app.id.clone()
        } else {
            let app = w.application;
            let mut node = Node::new("application.launch", &app.display_name, json!({}));
            node.config = json!({"applicationId":app.id,"arguments":[],"alreadyRunning":"skip"});
            append_node(&mut scene, node);
            let id = app.id.clone();
            apps.push(app);
            id
        };
        layouts.push(WindowLayout {
            application_id,
            identity: w.identity,
            display: w.display,
            bounds: w.bounds,
            relative: w.relative,
            state: w.state,
        });
    }
    if capture_layout {
        let config = RestoreConfig {
            mode: LayoutMode::Relative,
            profiles: vec![WorkspaceProfile {
                name: profile_name.into(),
                condition: MonitorCondition {
                    count: Some(count),
                    display_names: vec![],
                },
                windows: layouts,
            }],
            skip_missing_windows: false,
        };
        validate_config(&config)?;
        let mut node = Node::new(
            "workspace.restore",
            "恢复工作区",
            serde_json::to_value(config)?,
        );
        node.timeout_ms = 120_000;
        append_node(&mut scene, node);
    }
    Ok((scene, apps))
}
fn append_node(scene: &mut Scene, mut node: Node) {
    node.position = Position {
        x: 80.,
        y: 80. + scene.workflow.nodes.len() as f64 * 140.,
    };
    if let Some(previous) = scene.workflow.nodes.last() {
        scene.workflow.edges.push(Edge {
            id: id(),
            from: previous.id.clone(),
            to: node.id.clone(),
            outlet: success_outlet(),
        });
    }
    scene.workflow.nodes.push(node);
}
