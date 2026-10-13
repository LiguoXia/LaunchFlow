use crate::AppState;
use launchflow_core::{
    automation::{assets::AssetStore, model::*, runner, sessions::SessionState},
    model::{Run, Scene},
    parameters::Values,
};
use serde_json::{json, Value};
use std::{path::PathBuf, sync::Mutex, time::Duration};
use tauri::State;
type Result<T> = std::result::Result<T, AutomationError>;

#[tauri::command]
pub async fn automation_permissions(state: State<'_, AppState>) -> Result<Value> {
    state
        .engine
        .platform
        .automation()
        .request(json!({"op":"permissions"}))
        .await
}
#[tauri::command]
pub async fn automation_settings(permission: String, state: State<'_, AppState>) -> Result<Value> {
    if ![
        "accessibility",
        "screenRecording",
        "automation",
        "inputMonitoring",
    ]
    .contains(&permission.as_str())
    {
        return Err(AutomationError::new("invalidRequest", "Unknown permission"));
    }
    state
        .engine
        .platform
        .automation()
        .request(json!({"op":"openSettings","permission":permission}))
        .await
}
#[tauri::command]
pub async fn automation_windows(
    include_hidden: Option<bool>,
    state: State<'_, AppState>,
) -> Result<Value> {
    state
        .engine
        .platform
        .automation()
        .request(json!({"op":"windows","includeHidden":include_hidden.unwrap_or(false)}))
        .await
}
#[tauri::command]
pub async fn automation_elements(
    window: WindowLocator,
    state: State<'_, AppState>,
) -> Result<Value> {
    state
        .engine
        .platform
        .automation()
        .request(json!({"op":"elements","window":window}))
        .await
}
#[tauri::command]
pub async fn automation_highlight(
    config: ActionConfig,
    state: State<'_, AppState>,
) -> Result<Diagnostic> {
    runner::validate_config("highlight", &config)
        .map_err(|e| AutomationError::new("invalidLocator", e.to_string()))?;
    let provider = state.engine.platform.automation();
    let diagnostics = Mutex::new(Diagnostic::default());
    let target = tokio::time::timeout(
        Duration::from_secs(15),
        runner::resolve(provider.as_ref(), &config.locators, &diagnostics),
    )
    .await
    .map_err(|_| AutomationError::new("timeout", "Highlight lookup timed out"))??;
    provider.request(json!({"op":"highlight","window":target.window,"locator":target.native_locator,"bounds":target.element["bounds"],"durationMs":1200})).await?;
    Ok(diagnostics.into_inner().unwrap())
}
#[tauri::command]
pub async fn automation_test_action(
    scene: Scene,
    node_id: String,
    parameters: Option<Values>,
    approved: Option<bool>,
    state: State<'_, AppState>,
) -> std::result::Result<Run, String> {
    crate::api(state.engine.test_action_authorized(
        scene,
        &node_id,
        parameters.unwrap_or_default(),
        approved.unwrap_or(false),
    ))
}
#[tauri::command]
pub async fn automation_session_start(
    mode: String,
    window: WindowLocator,
    state: State<'_, AppState>,
) -> Result<SessionState> {
    let _admission = state
        .execution_admission
        .lock()
        .map_err(|_| AutomationError::new("unavailable", "Session state unavailable"))?;
    if state.engine.is_maintenance() {
        return Err(AutomationError::new(
            "updating",
            "Finish installing the update before starting a picker or recorder",
        ));
    }
    state.sessions.start(&mode, window)
}
#[tauri::command]
pub fn automation_session_control(operation: String, state: State<'_, AppState>) -> Result<()> {
    state.sessions.control(&operation)
}
#[tauri::command]
pub fn automation_session_current(state: State<'_, AppState>) -> Option<SessionState> {
    state.sessions.current()
}
#[tauri::command]
pub fn automation_recording_acknowledge(id: String, state: State<'_, AppState>) -> Result<()> {
    state.sessions.acknowledge_recording(&id)
}
#[tauri::command]
pub async fn automation_import_asset(path: PathBuf, state: State<'_, AppState>) -> Result<Asset> {
    let store = AssetStore::new(state.engine.platform.automation().paths());
    tokio::task::spawn_blocking(move || store.import(&path))
        .await
        .map_err(|_| AutomationError::new("assetStorage", "Image import failed"))?
}
#[tauri::command]
pub async fn automation_capture_asset(
    window: WindowLocator,
    region: Rect,
    state: State<'_, AppState>,
) -> Result<Asset> {
    if !region.valid() || region.x < 0.0 || region.y < 0.0 {
        return Err(AutomationError::new(
            "invalidRegion",
            "Choose a valid window-relative region",
        ));
    }
    let provider = state.engine.platform.automation();
    let store = AssetStore::new(provider.paths());
    let (_, path) = store.diagnostic_path()?;
    let _cleanup = launchflow_core::automation::assets::TemporaryImage(path.clone());
    provider
        .request(json!({"op":"capture","window":window,"region":region,"path":path}))
        .await?;
    store.import(&path)
}
#[tauri::command]
pub async fn automation_image(
    id: String,
    asset: bool,
    state: State<'_, AppState>,
) -> Result<String> {
    AssetStore::new(state.engine.platform.automation().paths()).image_data(&id, asset)
}
#[tauri::command]
pub async fn automation_export(
    scene: Scene,
    path: PathBuf,
    state: State<'_, AppState>,
) -> Result<()> {
    let store = AssetStore::new(state.engine.platform.automation().paths());
    tokio::task::spawn_blocking(move || store.export(&scene, &path))
        .await
        .map_err(|_| AutomationError::new("exportFailed", "Export failed"))?
}
#[tauri::command]
pub async fn automation_launch_harness(state: State<'_, AppState>) -> Result<Value> {
    let provider = state.engine.platform.automation();
    let mut command = std::process::Command::new(&provider.paths().harness);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    let mut child = command
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .map_err(|_| {
            AutomationError::new("workerUnavailable", "Bundled Test Harness could not start")
        })?;
    let pid = child.id();
    std::thread::spawn(move || {
        let _ = child.wait();
    });
    Ok(json!({"pid":pid,"path":provider.paths().harness}))
}
