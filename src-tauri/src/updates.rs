use crate::{ApiResult, AppState};
use serde::Serialize;
use std::{sync::Mutex, time::Duration};
use tauri::State;
use tauri_plugin_updater::UpdaterExt;
pub struct PendingUpdate(pub Mutex<Option<tauri_plugin_updater::Update>>);
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateStatus {
    enabled: bool,
    reason: String,
    version: Option<String>,
    notes: Option<String>,
}
fn config() -> ApiResult<(&'static str, &'static str)> {
    if cfg!(debug_assertions) {
        return Err("Development build: updater is disabled".into());
    }
    let endpoint = option_env!("LAUNCHFLOW_UPDATE_URL")
        .filter(|s| s.starts_with("https://"))
        .ok_or("Release update endpoint is not configured")?;
    let key = option_env!("LAUNCHFLOW_UPDATE_PUBLIC_KEY")
        .filter(|s| !s.trim().is_empty())
        .ok_or("Release update signing key is not configured")?;
    Ok((endpoint, key))
}
#[tauri::command]
pub fn update_status() -> UpdateStatus {
    match config() {
        Ok(_) => UpdateStatus {
            enabled: true,
            reason: "Checks run only when requested. Installation requires confirmation.".into(),
            version: None,
            notes: None,
        },
        Err(reason) => UpdateStatus {
            enabled: false,
            reason,
            version: None,
            notes: None,
        },
    }
}
#[tauri::command]
pub async fn update_check(
    app: tauri::AppHandle,
    pending: State<'_, PendingUpdate>,
) -> ApiResult<UpdateStatus> {
    let (endpoint, key) = config()?;
    let url = endpoint
        .parse::<tauri::Url>()
        .map_err(|_| "Invalid release endpoint")?;
    if url.host_str().is_none() || !url.username().is_empty() || url.password().is_some() {
        return Err("Invalid release endpoint".into());
    }
    let update = app
        .updater_builder()
        .endpoints(vec![url])
        .map_err(|_| "Invalid update configuration")?
        .pubkey(key)
        .timeout(Duration::from_secs(20))
        .configure_client(|client| client.https_only(true))
        .build()
        .map_err(|_| "Updater is unavailable")?
        .check()
        .await
        .map_err(|_| "Update check failed. The application remains available; try again later.")?;
    if let Some(update) = &update {
        if update.download_url.scheme() != "https" || update.signature.trim().is_empty() {
            return Err("Update metadata failed security validation".into());
        }
        crate::notify(&app, "LaunchFlow", "发现新版本，可在设置中查看并确认安装。");
    }
    let status = UpdateStatus {
        enabled: true,
        reason: if update.is_some() {
            "Update available"
        } else {
            "You are up to date"
        }
        .into(),
        version: update.as_ref().map(|u| u.version.clone()),
        notes: update.as_ref().and_then(|u| u.body.clone()),
    };
    *pending.0.lock().map_err(|_| "Update state unavailable")? = update;
    Ok(status)
}
struct Maintenance<'a>(&'a launchflow_core::engine::Engine);
impl Drop for Maintenance<'_> {
    fn drop(&mut self) {
        self.0.end_maintenance();
    }
}
#[tauri::command]
pub async fn update_install(
    version: String,
    confirmed: bool,
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    pending: State<'_, PendingUpdate>,
) -> ApiResult<()> {
    config()?;
    if !confirmed {
        return Err("Installation requires explicit confirmation".into());
    }
    let _guard = {
        let _admission = state
            .execution_admission
            .lock()
            .map_err(|_| "Session state unavailable")?;
        if !state.engine.begin_maintenance() {
            return Err("An update installation is already in progress".into());
        }
        let guard = Maintenance(&state.engine);
        if state.engine.has_active()
            || state.sessions.current().is_some_and(|s| {
                ["starting", "recording", "paused", "picking"].contains(&s.status.as_str())
            })
        {
            return Err(
                "Finish workflows and recording sessions before installing an update".into(),
            );
        }
        guard
    };
    let update = {
        let mut guard = pending.0.lock().map_err(|_| "Update state unavailable")?;
        if !guard.as_ref().is_some_and(|u| u.version == version) {
            return Err("Check for updates again before installing".into());
        }
        guard.take().expect("checked")
    };
    let limit = tokio::sync::Notify::new();
    let mut bytes = 0usize;
    let download = update.download(
        |count, total| {
            bytes = bytes.saturating_add(count);
            if bytes > 256 * 1024 * 1024 || total.is_some_and(|n| n > 256 * 1024 * 1024) {
                limit.notify_one();
            }
        },
        || {},
    );
    let content = tokio::select! {
        result=download=>result.map_err(|_|"Download or signature verification failed; no update was installed")?,
        _=limit.notified()=>return Err("Update download exceeds 256 MiB".into()),
        _=tokio::time::sleep(Duration::from_secs(300))=>return Err("Update download timed out; no update was installed".into()),
    };
    if content.len() > 256 * 1024 * 1024 {
        return Err("Update download exceeds 256 MiB".into());
    }
    update
        .install(content)
        .map_err(|_| "Update installation failed; retry after restarting LaunchFlow")?;
    app.restart();
}
