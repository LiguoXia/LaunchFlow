use crate::{ApiResult, AppState};
use serde_json::{json, Value};
use std::{fs, path::PathBuf};
use tauri::State;
use tauri_plugin_autostart::ManagerExt;

pub async fn task(app: &tauri::AppHandle, state: &AppState, action: &str) -> ApiResult<Value> {
    if state.engine.platform.os() != "windows" {
        return Ok(json!({"registered":false,"enabled":false,"matches":false,"error":""}));
    }
    let mut request = json!({"op":"desktopStartup","action":action,
        "namespace":app.config().identifier,"launcher":std::env::current_exe().map_err(|e| e.to_string())?});
    if cfg!(debug_assertions) {
        if let Some(path) = std::env::var_os("LAUNCHFLOW_TEST_DATA_DIR") {
            request["testData"] = json!(path.to_string_lossy());
        }
    }
    state
        .engine
        .platform
        .automation()
        .request(request)
        .await
        .map_err(|e| e.message)
}

pub async fn enabled(app: &tauri::AppHandle, state: &AppState) -> bool {
    app.autolaunch().is_enabled().unwrap_or(false)
        || task(app, state, "status")
            .await
            .is_ok_and(|t| t["enabled"] == true)
}

#[tauri::command]
pub async fn set_startup_mode(
    mode: String,
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> ApiResult<()> {
    let _guard = state.startup_settings.lock().await;
    match mode.as_str() {
        "beforeUnlock" if state.engine.platform.os() == "windows" => {
            task(&app, &state, "enable").await?;
            app.autolaunch().disable().map_err(|e| e.to_string())?;
        }
        "login" => {
            // Establish the replacement first. A failed transition remains visible in status.
            app.autolaunch().enable().map_err(|e| e.to_string())?;
            task(&app, &state, "disable").await?;
        }
        "disabled" => {
            // Query/remove owned tasks before changing the legacy registration.
            task(&app, &state, "disable").await?;
            app.autolaunch().disable().map_err(|e| e.to_string())?;
        }
        _ => return Err("不支持此启动模式。".into()),
    }
    Ok(())
}

fn observation_file(state: &AppState) -> PathBuf {
    state
        .engine
        .platform
        .automation()
        .paths()
        .data
        .join("startup-observation.json")
}

pub fn record(state: &AppState, phase: &str) {
    let file = observation_file(state);
    let mut value = if phase == "started" {
        json!({})
    } else {
        fs::read(&file)
            .ok()
            .and_then(|v| serde_json::from_slice(&v).ok())
            .unwrap_or(json!({}))
    };
    value[phase] = json!({"at":launchflow_core::model::now(),"desktopReady":state.engine.platform.desktop_ready()});
    let _ = fs::create_dir_all(file.parent().expect("data directory"));
    if let Ok(bytes) = serde_json::to_vec(&value) {
        let _ = fs::write(file, bytes);
    }
}

#[tauri::command]
pub async fn startup_status(app: tauri::AppHandle, state: State<'_, AppState>) -> ApiResult<Value> {
    let task = task(&app, &state, "status")
        .await
        .unwrap_or_else(|e| json!({"error":e}));
    let conditions = if state.engine.platform.os() == "windows" {
        state
            .engine
            .platform
            .automation()
            .request(json!({"op":"desktopStartupConditions"}))
            .await
            .unwrap_or(json!({}))
    } else {
        json!({})
    };
    let file = observation_file(&state);
    let observation: Value = fs::metadata(&file)
        .ok()
        .filter(|m| m.len() < 16384)
        .and_then(|_| fs::read(file).ok())
        .and_then(|v| serde_json::from_slice(&v).ok())
        .unwrap_or(Value::Null);
    Ok(
        json!({"registrationId":app.config().identifier,"legacyEnabled":app.autolaunch().is_enabled().map_err(|e|e.to_string())?,
        "task":task,"conditions":conditions,"observation":observation,
        "desktopReady":state.engine.platform.desktop_ready()}),
    )
}

#[tauri::command]
pub async fn open_signin_settings(state: State<'_, AppState>) -> ApiResult<()> {
    if state.engine.platform.os() != "windows" {
        return Err("此入口仅适用于 Windows。".into());
    }
    state
        .engine
        .platform
        .automation()
        .request(json!({"op":"openSigninSettings"}))
        .await
        .map_err(|e| e.message)?;
    Ok(())
}
