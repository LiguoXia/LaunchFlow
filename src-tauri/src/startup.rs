use crate::{ApiResult, AppState};
use serde_json::{json, Value};
use std::{fs, path::PathBuf, sync::atomic::Ordering, time::Duration};
use tauri::{Manager, State};
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
            if state.engine.platform.os() == "windows" {
                task(&app, &state, "quoteLogin").await?;
            }
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

fn reason(error: &str) -> (&'static str, &'static str) {
    if error.contains("startupPolicyBlocked") || error.contains("sensitiveApprovalRequired") {
        (
            "policyBlocked",
            "场景策略阻止自动执行。请允许默认场景及其子场景自动执行。",
        )
    } else if error.contains("startupTriggerDisabled") {
        (
            "triggerDisabled",
            "默认场景的登录触发器已禁用，请在场景设置中启用。",
        )
    } else {
        (
            "invalidScene",
            "默认场景未通过启动检查。请检查场景、应用路径和必填参数；详细原因见运行历史。",
        )
    }
}

fn readiness(state: &AppState) -> Value {
    let default = state
        .engine
        .store
        .scenes()
        .ok()
        .and_then(|scenes| scenes.into_iter().find(|s| s.is_default));
    let check = state.triggers.startup_scene().and_then(|plan| {
        if let Some((scene, values)) = plan {
            state.engine.check_startup(&scene, &values).map(|_| true)
        } else {
            Ok(false)
        }
    });
    let (ready, code, message) = match check {
        Ok(true) => (true, "ready", "默认场景已通过启动检查，自动启动时会执行。"),
        Ok(false) => (false, "noDefault", "尚未选择默认场景。"),
        Err(error) => {
            let (code, message) = reason(&error.to_string());
            (false, code, message)
        }
    };
    json!({"ready":ready,"code":code,"message":message,"sceneId":default.as_ref().map(|s|&s.id),
        "version":default.as_ref().map(|s|s.version),"canAuthorize":code == "policyBlocked" && default.as_ref().is_some_and(|s|s.sensitive_action_policy != launchflow_core::policy::SensitiveActionPolicy::AllowForThisScene)})
}

pub fn request(app: &tauri::AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        // A second process can arrive before the first process finishes setup.
        for _ in 0..100 {
            if app.try_state::<AppState>().is_some() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        let Some(state) = app.try_state::<AppState>() else {
            return;
        };
        if state.startup_requested.swap(true, Ordering::SeqCst) {
            return;
        }
        record(&state, "started");
        let delay = state
            .engine
            .store
            .settings()
            .map(|s| s.startup_delay_seconds)
            .unwrap_or(5);
        tokio::select! {
            _ = state.startup_cancel.cancelled() => return,
            _ = tokio::time::sleep(Duration::from_secs(delay)) => {}
        }
        record(&state, "dispatch");
        let result = state.triggers.startup();
        let (status, code, message) = match result {
            Ok(Some(_)) => (
                "dispatched",
                "ready",
                "默认场景已提交执行，结果见运行历史。",
            ),
            Ok(None) => ("skipped", "noDefault", "尚未选择默认场景。"),
            Err(error) => {
                let (code, message) = reason(&error.to_string());
                ("blocked", code, message)
            }
        };
        let file = observation_file(&state);
        let mut value: Value = fs::read(&file)
            .ok()
            .and_then(|v| serde_json::from_slice(&v).ok())
            .unwrap_or(json!({}));
        value["result"] = json!({"at":launchflow_core::model::now(),"status":status,"code":code,"message":message});
        if let Ok(bytes) = serde_json::to_vec(&value) {
            let _ = fs::write(file, bytes);
        }
        if status == "blocked" {
            crate::notify(&app, "LaunchFlow · 默认场景未启动", message);
        }
    });
}

#[tauri::command]
pub fn authorize_default_startup(
    scene_id: String,
    version: u32,
    state: State<'_, AppState>,
) -> ApiResult<()> {
    let mut scene = state
        .engine
        .store
        .scene(&scene_id)
        .map_err(|e| e.to_string())?;
    if !scene.is_default || scene.version != version {
        return Err("默认场景已改变，请刷新后重试。".into());
    }
    scene.sensitive_action_policy =
        launchflow_core::policy::SensitiveActionPolicy::AllowForThisScene;
    state
        .engine
        .store
        .save_scene(scene)
        .map_err(|e| e.to_string())?;
    state.triggers.refresh().map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn startup_status(app: tauri::AppHandle, state: State<'_, AppState>) -> ApiResult<Value> {
    let login = task(&app, &state, "loginStatus")
        .await
        .unwrap_or(Value::Null);
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
        "task":task,"login":login,"conditions":conditions,"observation":observation,"readiness":readiness(&state),
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
        .open_target("ms-settings:signinoptions")
        .await
        .map_err(|_| "Windows 登录选项未能打开，请从系统设置进入账户 → 登录选项。".to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn open_autologon_settings(state: State<'_, AppState>) -> ApiResult<()> {
    if state.engine.platform.os() != "windows" {
        return Err("此入口仅适用于 Windows。".into());
    }
    state
        .engine
        .platform
        .open_target("https://learn.microsoft.com/en-us/sysinternals/downloads/autologon")
        .await
        .map_err(|_| "默认浏览器未能打开，请使用页面上的复制地址按钮。".to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn configure_autologon(state: State<'_, AppState>) -> ApiResult<Value> {
    if state.engine.platform.os() != "windows" {
        return Err("自动登录配置仅适用于 Windows。".into());
    }
    if cfg!(debug_assertions) && std::env::var_os("LAUNCHFLOW_TEST_DATA_DIR").is_some() {
        return Err("隔离测试模式不会请求管理员授权或修改 Windows 自动登录。".into());
    }
    let _guard = state.startup_settings.lock().await;
    state
        .engine
        .platform
        .automation()
        .request(json!({"op":"configureAutologon"}))
        .await
        .map_err(|e| e.message)
}
