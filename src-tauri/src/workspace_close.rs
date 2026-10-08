use crate::*;
use launchflow_core::workspace_close::CloseCapture;

#[tauri::command]
pub async fn workspace_close_capture(state: State<'_, AppState>) -> ApiResult<CloseCapture> {
    api(state
        .workspace_closer
        .lock()
        .await
        .capture(
            state.engine.platform.automation().as_ref(),
            &state.engine.store,
        )
        .await)
}
#[tauri::command]
pub async fn workspace_close_select(
    token: String,
    id: String,
    selected: bool,
    state: State<'_, AppState>,
) -> ApiResult<()> {
    api(state
        .workspace_closer
        .lock()
        .await
        .select(&state.engine.store, &token, &id, selected))
}
#[tauri::command]
pub async fn workspace_close_execute(
    token: String,
    ids: Vec<String>,
    action: String,
    confirmed: bool,
    state: State<'_, AppState>,
) -> ApiResult<CloseCapture> {
    api(state
        .workspace_closer
        .lock()
        .await
        .execute(
            state.engine.platform.automation().as_ref(),
            &token,
            &ids,
            &action,
            confirmed,
        )
        .await)
}
#[derive(Serialize)]
pub struct CloseShortcut {
    shortcut: String,
    error: Option<String>,
}
#[tauri::command]
pub fn workspace_close_shortcut(state: State<'_, AppState>) -> ApiResult<CloseShortcut> {
    Ok(CloseShortcut {
        shortcut: api(state.engine.store.workspace_close_value("shortcut"))?.unwrap_or_default(),
        error: state
            .close_shortcut_error
            .lock()
            .map_err(|e| e.to_string())?
            .clone(),
    })
}
pub fn parse_shortcut(value: &str) -> ApiResult<Option<Shortcut>> {
    if value.is_empty() {
        return Ok(None);
    }
    if value.len() > 100
        || !value.split('+').any(|p| {
            [
                "ctrl",
                "control",
                "alt",
                "super",
                "cmd",
                "command",
                "commandorcontrol",
                "cmdorctrl",
            ]
            .contains(&p.trim().to_lowercase().as_str())
        })
    {
        return Err("快捷键必须包含 Ctrl、Alt 或 Command 等修饰键。".into());
    }
    value
        .parse::<Shortcut>()
        .map(Some)
        .map_err(|_| "快捷键格式无效，例如 Ctrl+Alt+Q。".into())
}
fn register(app: &tauri::AppHandle, shortcut: Shortcut) -> ApiResult<()> {
    app.global_shortcut()
        .on_shortcut(shortcut, |app, _, event| {
            if event.state == ShortcutState::Pressed {
                show_main(app);
                let _ = app.emit("launchflow://closeWorkspace", ());
            }
        })
        .map_err(|e| format!("快捷键注册失败，可能已被其他应用占用：{e}"))
}
pub fn apply_shortcut(app: &tauri::AppHandle, value: &str, persist: bool) -> ApiResult<()> {
    let state = app.state::<AppState>();
    let _gate = state.hotkey_sync.lock().map_err(|e| e.to_string())?;
    let next = parse_shortcut(value)?;
    let mut current = state.close_shortcut.lock().map_err(|e| e.to_string())?;
    if let Some(next) = next {
        for scene in api(state.engine.store.scenes())? {
            if scene.triggers.iter().any(|t| {
                t.enabled
                    && t.kind == "globalHotkey"
                    && t.config["shortcut"]
                        .as_str()
                        .and_then(|s| s.parse::<Shortcut>().ok())
                        .is_some_and(|s| s.id() == next.id())
            }) {
                return Err(format!("此快捷键已用于场景「{}」。", scene.name));
            }
        }
    }
    if current.as_ref().map(Shortcut::id) != next.as_ref().map(Shortcut::id) {
        if let Some(next) = next {
            register(app, next)?;
        }
        if persist {
            if let Err(e) = state
                .engine
                .store
                .set_workspace_close_value("shortcut", value)
            {
                if let Some(next) = next {
                    let _ = app.global_shortcut().unregister(next);
                }
                return Err(e.to_string());
            }
        }
        if let Some(old) = *current {
            let _ = app.global_shortcut().unregister(old);
        }
        *current = next;
    } else if persist {
        api(state
            .engine
            .store
            .set_workspace_close_value("shortcut", value))?;
    }
    *state
        .close_shortcut_error
        .lock()
        .map_err(|e| e.to_string())? = None;
    Ok(())
}
#[tauri::command]
pub async fn workspace_close_shortcut_save(
    shortcut: String,
    app: tauri::AppHandle,
) -> ApiResult<()> {
    tauri::async_runtime::spawn_blocking(move || apply_shortcut(&app, shortcut.trim(), true))
        .await
        .map_err(|e| e.to_string())?
}
