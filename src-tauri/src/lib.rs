mod automation;
mod product;
mod startup;
mod updates;
mod workspace_close;
use automation::*;
use launchflow_core::automation::{sessions::SessionManager, AutomationPaths};
use launchflow_core::{
    engine::Engine,
    model::*,
    parameters::Values,
    platform::{native_platform_with_automation, ApplicationAuthorizationAction},
    registry::{NodeDefinition, NodeRegistry},
    storage::Store,
    triggers::{TriggerDefinition, TriggerEngine, TriggerEvent},
    validation::validate_profile,
};
use product::*;
use serde::Serialize;
use startup::*;
use std::{
    sync::{Arc, Mutex},
    time::Duration,
};
use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem, Submenu},
    tray::{TrayIconBuilder, TrayIconEvent},
    Emitter, Manager, State,
};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};
use tauri_plugin_notification::NotificationExt;
use tokio_util::sync::CancellationToken;
use updates::*;
use workspace_close::*;

type ApiResult<T> = Result<T, String>;
struct AppState {
    execution_admission: Mutex<()>,
    pending_import: Mutex<Option<product::PendingImport>>,
    sessions: Arc<SessionManager>,
    engine: Arc<Engine>,
    startup_cancel: CancellationToken,
    startup_requested: std::sync::atomic::AtomicBool,
    service_cancel: CancellationToken,
    triggers: Arc<TriggerEngine>,
    hotkey_sync: Arc<Mutex<()>>,
    workspace_closer: tokio::sync::Mutex<launchflow_core::workspace_close::WorkspaceCloser>,
    scene_shortcuts: Mutex<Vec<Shortcut>>,
    close_shortcut: Mutex<Option<Shortcut>>,
    close_shortcut_error: Mutex<Option<String>>,
    icon_requests: tokio::sync::Mutex<()>,
    startup_settings: tokio::sync::Mutex<()>,
}
fn api<T>(result: launchflow_core::Result<T>) -> ApiResult<T> {
    result.map_err(|e| e.to_string())
}

#[tauri::command]
async fn application_icons(
    sources: Vec<launchflow_core::application_icons::IconSource>,
    state: State<'_, AppState>,
) -> ApiResult<Vec<Option<String>>> {
    if sources.len() > 24 {
        return Err("Too many application icons requested".into());
    }
    let _guard = state.icon_requests.lock().await;
    Ok(launchflow_core::application_icons::load(
        state.engine.platform.automation().as_ref(),
        sources,
    )
    .await)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Bootstrap {
    scenes: Vec<Scene>,
    profiles: Vec<ApplicationProfile>,
    runs: Vec<Run>,
    settings: Settings,
    definitions: Vec<NodeDefinition>,
    os: String,
    autostart: bool,
    version: String,
    trigger_definitions: Vec<TriggerDefinition>,
    trigger_statuses: Vec<TriggerEvent>,
}

#[tauri::command]
async fn bootstrap(app: tauri::AppHandle, state: State<'_, AppState>) -> ApiResult<Bootstrap> {
    let e = &state.engine;
    Ok(Bootstrap {
        scenes: api(e.store.scenes())?,
        profiles: api(e.store.profiles())?,
        runs: api(e.store.runs())?,
        settings: api(e.store.settings())?,
        definitions: e.registry.definitions(),
        os: e.platform.os().into(),
        autostart: startup::enabled(&app, &state).await,
        version: app.package_info().version.to_string(),
        trigger_definitions: state.triggers.registry.definitions(),
        trigger_statuses: state.triggers.statuses(),
    })
}
#[tauri::command]
fn create_scene(
    name: String,
    state: State<'_, AppState>,
    app: tauri::AppHandle,
) -> ApiResult<Scene> {
    let scene = api(state.engine.store.save_scene(Scene::new(&name)))?;
    refresh_tray(&app)?;
    Ok(scene)
}
#[tauri::command]
fn save_scene(scene: Scene, state: State<'_, AppState>, app: tauri::AppHandle) -> ApiResult<Scene> {
    for trigger in scene.triggers.iter().filter(|t| t.kind == "globalHotkey") {
        let shortcut = trigger.config["shortcut"]
            .as_str()
            .unwrap_or("")
            .parse::<Shortcut>()
            .map_err(|e| e.to_string())?;
        if trigger.enabled
            && api(state.engine.store.workspace_close_value("shortcut"))?
                .and_then(|s| s.parse::<Shortcut>().ok())
                .is_some_and(|s| s.id() == shortcut.id())
        {
            return Err("此快捷键已用于关闭工作区，请选择其他组合。".into());
        }
    }
    let issues = api(state.engine.validate(&scene, false))?;
    if !issues.is_empty() {
        return Err(issues
            .iter()
            .map(|i| i.message.clone())
            .collect::<Vec<_>>()
            .join("\n"));
    }
    let scene = api(state.engine.store.save_scene(scene))?;
    refresh_tray(&app)?;
    Ok(scene)
}
#[tauri::command]
fn duplicate_scene(
    scene_id: String,
    state: State<'_, AppState>,
    app: tauri::AppHandle,
) -> ApiResult<Scene> {
    let mut scene = api(state.engine.store.scene(&scene_id))?;
    scene.id = id();
    scene.name = format!("{} 副本", scene.name);
    scene.version = 0;
    scene.is_default = false;
    let saved = api(state.engine.store.save_scene(scene))?;
    refresh_tray(&app)?;
    Ok(saved)
}
#[tauri::command]
fn delete_scene(
    scene_id: String,
    state: State<'_, AppState>,
    app: tauri::AppHandle,
) -> ApiResult<()> {
    if state.engine.scene_active(&scene_id) {
        return Err("Stop the active run before deleting this scene".into());
    }
    api(state.engine.store.delete_scene(&scene_id))?;
    refresh_tray(&app)
}
#[tauri::command]
fn set_default_scene(
    scene_id: Option<String>,
    state: State<'_, AppState>,
) -> ApiResult<Option<String>> {
    api(state.engine.store.set_default(scene_id.as_deref()))?;
    // Tray actions read the current default from the store. Its menu items and
    // hotkeys did not change, so don't rebuild them to acknowledge this save.
    api(state.triggers.refresh())?;
    Ok(scene_id)
}
#[tauri::command]
fn save_draft(scene: Scene, state: State<'_, AppState>) -> ApiResult<()> {
    if scene.schema_version != 1
        || serde_json::to_vec(&scene).map_err(|e| e.to_string())?.len() > 1_048_576
    {
        return Err("Invalid or oversized draft".into());
    }
    api(state.engine.store.save_draft(&scene))
}
#[tauri::command]
fn get_draft(scene_id: String, state: State<'_, AppState>) -> ApiResult<Option<Scene>> {
    api(state.engine.store.draft(&scene_id))
}
#[tauri::command]
fn delete_draft(scene_id: String, state: State<'_, AppState>) -> ApiResult<()> {
    api(state.engine.store.delete_draft(&scene_id))
}
#[tauri::command]
fn validate_scene(scene: Scene, state: State<'_, AppState>) -> ApiResult<Vec<ValidationIssue>> {
    api(state.engine.validate(&scene, true))
}
#[tauri::command]
fn save_profile(profile: ApplicationProfile, state: State<'_, AppState>) -> ApiResult<()> {
    api(validate_profile(&profile))?;
    api(state.engine.store.save_profile(&profile))
}
#[tauri::command]
async fn delete_profile(profile_id: String, state: State<'_, AppState>) -> ApiResult<()> {
    if state.engine.platform.os() == "windows" {
        if let Some(profile) = api(state.engine.store.profiles())?
            .into_iter()
            .find(|p| p.id == profile_id)
        {
            let status = api(state
                .engine
                .platform
                .application_authorization(&profile, ApplicationAuthorizationAction::Status)
                .await)?;
            if status["state"] != "notAuthorized" {
                return Err(
                    "请先在应用配置中撤销免确认授权，再删除此应用；当前无法确认授权已撤销。".into(),
                );
            }
        }
    }
    api(state.engine.store.delete_profile(&profile_id))
}
#[tauri::command]
async fn application_authorization_status(
    profile: ApplicationProfile,
    state: State<'_, AppState>,
) -> ApiResult<serde_json::Value> {
    api(state
        .engine
        .platform
        .application_authorization(&profile, ApplicationAuthorizationAction::Status)
        .await)
}
#[tauri::command]
async fn application_authorization_change(
    profile_id: String,
    grant: bool,
    state: State<'_, AppState>,
) -> ApiResult<serde_json::Value> {
    let profile = api(state.engine.store.profiles())?
        .into_iter()
        .find(|p| p.id == profile_id)
        .ok_or("应用配置不存在")?;
    api(validate_profile(&profile))?;
    api(state
        .engine
        .platform
        .application_authorization(
            &profile,
            if grant {
                ApplicationAuthorizationAction::Grant
            } else {
                ApplicationAuthorizationAction::Revoke
            },
        )
        .await)
}
#[tauri::command]
async fn run_scene(
    scene_id: String,
    parameters: Option<Values>,
    approved: Option<bool>,
    state: State<'_, AppState>,
) -> ApiResult<Run> {
    api(state.triggers.manual_authorized(
        &scene_id,
        parameters.unwrap_or_default(),
        "manual",
        approved.unwrap_or(false),
    ))
}
#[tauri::command]
fn pause_run(run_id: String, state: State<'_, AppState>) -> ApiResult<()> {
    api(state.engine.pause(&run_id))
}
#[tauri::command]
fn resume_run(run_id: String, state: State<'_, AppState>) -> ApiResult<()> {
    api(state.engine.resume(&run_id))
}
#[tauri::command]
fn decide_node(
    run_id: String,
    node_id: String,
    action: String,
    state: State<'_, AppState>,
) -> ApiResult<()> {
    api(state.engine.decide(&run_id, &node_id, &action))
}
#[tauri::command]
async fn recover_run(
    run_id: String,
    action: String,
    node_id: Option<String>,
    approved: Option<bool>,
    state: State<'_, AppState>,
) -> ApiResult<Run> {
    api(state.engine.recover_authorized(
        &run_id,
        &action,
        node_id.as_deref(),
        approved.unwrap_or(false),
    ))
}
#[tauri::command]
fn stop_run(run_id: String, state: State<'_, AppState>) -> ApiResult<()> {
    api(state.engine.cancel(&run_id))
}
#[tauri::command]
fn delete_run(run_id: String, state: State<'_, AppState>) -> ApiResult<()> {
    api(state.engine.store.delete_run(&run_id))
}
#[tauri::command]
fn save_settings(settings: Settings, state: State<'_, AppState>) -> ApiResult<()> {
    api(state.engine.store.save_settings(&settings))?;
    api(state.engine.store.cleanup())?;
    Ok(())
}
#[tauri::command]
async fn set_autostart(
    enabled: bool,
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> ApiResult<bool> {
    let mode = if enabled { "login" } else { "disabled" };
    set_startup_mode(mode.into(), app.clone(), state.clone()).await?;
    Ok(startup::enabled(&app, &state).await)
}
fn show_main(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}
fn notify(app: &tauri::AppHandle, title: &str, body: &str) {
    if app
        .state::<AppState>()
        .engine
        .store
        .settings()
        .map(|s| s.notifications)
        .unwrap_or(false)
    {
        let _ = app.notification().builder().title(title).body(body).show();
    }
}
fn tray_menu(app: &tauri::AppHandle) -> ApiResult<Menu<tauri::Wry>> {
    let menu = Menu::new(app).map_err(|e| e.to_string())?;
    for (id, label) in [
        ("open", "打开 LaunchFlow"),
        ("run-default", "运行默认场景"),
        ("stop", "停止所有运行"),
    ] {
        menu.append(
            &MenuItem::with_id(app, id, label, true, None::<&str>).map_err(|e| e.to_string())?,
        )
        .map_err(|e| e.to_string())?;
    }
    let scenes = Submenu::new(app, "场景", true).map_err(|e| e.to_string())?;
    for scene in api(app.state::<AppState>().engine.store.scenes())? {
        scenes
            .append(
                &MenuItem::with_id(
                    app,
                    format!("scene:{}", scene.id),
                    &scene.name,
                    true,
                    None::<&str>,
                )
                .map_err(|e| e.to_string())?,
            )
            .map_err(|e| e.to_string())?;
    }
    menu.append(&scenes).map_err(|e| e.to_string())?;
    menu.append(&PredefinedMenuItem::separator(app).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    menu.append(
        &MenuItem::with_id(app, "quit", "退出 LaunchFlow", true, None::<&str>)
            .map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;
    Ok(menu)
}
fn refresh_tray(app: &tauri::AppHandle) -> ApiResult<()> {
    refresh_triggers(app)?;
    if let Some(tray) = app.tray_by_id("launchflow") {
        tray.set_menu(Some(tray_menu(app)?))
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}
fn refresh_triggers(app: &tauri::AppHandle) -> ApiResult<()> {
    api(app.state::<AppState>().triggers.refresh())?;
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let gate = app.state::<AppState>().hotkey_sync.clone();
        let Ok(_guard) = gate.lock() else {
            return;
        };
        let triggers = app.state::<AppState>().triggers.clone();
        let state = app.state::<AppState>();
        let Ok(mut registered) = state.scene_shortcuts.lock() else {
            return;
        };
        for shortcut in registered.drain(..) {
            if let Err(e) = app.global_shortcut().unregister(shortcut) {
                triggers.report("", "hotkeys", "error", &e.to_string());
            }
        }
        let Ok(scenes) = app.state::<AppState>().engine.store.scenes() else {
            return;
        };
        let mut shortcuts: std::collections::BTreeMap<u32, (Shortcut, Vec<(String, String)>)> =
            std::collections::BTreeMap::new();
        for scene in scenes {
            for t in scene
                .triggers
                .iter()
                .filter(|t| t.enabled && t.kind == "globalHotkey")
            {
                match t.config["shortcut"]
                    .as_str()
                    .unwrap_or("")
                    .parse::<Shortcut>()
                {
                    Ok(shortcut) => {
                        if state
                            .engine
                            .store
                            .workspace_close_value("shortcut")
                            .ok()
                            .flatten()
                            .and_then(|s| s.parse::<Shortcut>().ok())
                            .is_some_and(|s| s.id() == shortcut.id())
                        {
                            triggers.report(&scene.id, &t.id, "error", "快捷键已用于关闭工作区");
                            continue;
                        }
                        shortcuts
                            .entry(shortcut.id())
                            .or_insert_with(|| (shortcut, vec![]))
                            .1
                            .push((scene.id.clone(), t.id.clone()));
                    }
                    Err(e) => triggers.report(&scene.id, &t.id, "error", &e.to_string()),
                }
            }
        }
        for (_, (shortcut, targets)) in shortcuts {
            let dispatch = targets.clone();
            let result = app
                .global_shortcut()
                .on_shortcut(shortcut, move |app, _, event| {
                    if event.state != ShortcutState::Pressed {
                        return;
                    }
                    let app = app.clone();
                    let targets = dispatch.clone();
                    tauri::async_runtime::spawn(async move {
                        for (scene, id) in targets {
                            let _ = app.state::<AppState>().triggers.fire(&scene, &id);
                        }
                    });
                });
            if result.is_ok() {
                registered.push(shortcut);
            }
            for (scene, id) in targets {
                match &result {
                    Ok(()) => triggers.report(&scene, &id, "ready", "Global shortcut registered"),
                    Err(e) => triggers.report(&scene, &id, "error", &e.to_string()),
                }
            }
        }
    });
    Ok(())
}
fn dispatch_scene(app: &tauri::AppHandle, scene_id: String, source: &'static str) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        if let Err(error) =
            app.state::<AppState>()
                .triggers
                .manual(&scene_id, Values::new(), source)
        {
            if error.to_string().starts_with("Missing required parameter") {
                if let Ok(scene) = app.state::<AppState>().engine.store.scene(&scene_id) {
                    show_main(&app);
                    let _ = app.emit("launchflow://configureScene", scene);
                    return;
                }
            }
            notify(&app, "LaunchFlow · 无法启动场景", &error.to_string());
            let _ = app.emit("launchflow://error", error.to_string());
        }
    });
}
pub fn run() {
    let context = tauri::generate_context!();
    #[cfg(debug_assertions)]
    let context = {
        let mut context = context;
        if let Some(directory) = std::env::var_os("LAUNCHFLOW_TEST_DATA_DIR") {
            use std::hash::{Hash, Hasher};
            let mut hasher = std::collections::hash_map::DefaultHasher::new();
            directory.hash(&mut hasher);
            // Tests must not share a single-instance mutex or webview cache with
            // a user's installed app or another checkout of this project.
            context.config_mut().identifier = format!("app.launchflow.test{:x}", hasher.finish());
            for window in &mut context.config_mut().app.windows {
                window.data_directory = Some(std::path::PathBuf::from(&directory).join("webview"));
            }
        }
        context
    };
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, args, _| {
            if args.iter().any(|a| a == "--startup") {
                startup::request(app);
            } else {
                show_main(app);
            }
        }))
        .plugin(
            tauri_plugin_autostart::Builder::new()
                // Keep the OS login entry isolated as well as SQLite/WebView in desktop tests.
                .app_name(
                    if cfg!(debug_assertions)
                        && std::env::var_os("LAUNCHFLOW_TEST_DATA_DIR").is_some()
                    {
                        context.config().identifier.clone()
                    } else {
                        "launchflow".into()
                    },
                )
                .args({
                    let mut args = vec!["--startup".to_string()];
                    if cfg!(debug_assertions) {
                        if let Some(directory) = std::env::var_os("LAUNCHFLOW_TEST_DATA_DIR") {
                            args.extend(["--test-data-dir".into(), directory.to_string_lossy().into()]);
                        }
                    }
                    args
                })
                .build(),
        )
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(PendingUpdate(Mutex::new(None)))
        .invoke_handler(tauri::generate_handler![
            startup_status,
            set_startup_mode,
            open_signin_settings,
            open_autologon_settings,
            configure_autologon,
            authorize_default_startup,
            application_icons,
            workspace_close_capture,
            workspace_close_select,
            workspace_close_execute,
            workspace_close_shortcut,
            workspace_close_shortcut_save,
            workspace_capture,
            workspace_create_scene,
            vault_metadata,
            vault_write,
            vault_delete,
            sensitive_actions,
            scene_export,
            scene_import_preview,
            scene_import_rebind,
            scene_import_commit,
            export_diagnostics,
            diagnostic_log,
            update_status,
            update_check,
            update_install,
            automation_permissions,
            automation_settings,
            automation_windows,
            automation_elements,
            automation_highlight,
            automation_test_action,
            automation_session_start,
            automation_session_control,
            automation_session_current,
            automation_recording_acknowledge,
            automation_import_asset,
            automation_capture_asset,
            automation_image,
            automation_export,
            automation_launch_harness,
            bootstrap,
            create_scene,
            save_scene,
            duplicate_scene,
            delete_scene,
            set_default_scene,
            save_draft,
            get_draft,
            delete_draft,
            validate_scene,
            save_profile,
            delete_profile,
            application_authorization_status,
            application_authorization_change,
            run_scene,
            stop_run,
            pause_run,
            resume_run,
            decide_node,
            recover_run,
            delete_run,
            save_settings,
            set_autostart
        ])
        .setup(|app| {
            let data_dir = app.path().app_data_dir()?;
            #[cfg(debug_assertions)]
            let data_dir = std::env::var_os("LAUNCHFLOW_TEST_DATA_DIR")
                .map(std::path::PathBuf::from)
                .unwrap_or(data_dir);
            std::fs::create_dir_all(&data_dir)?;
            let store = Arc::new(Store::open(data_dir.join("launchflow.db"))?);
            store.recover_interrupted()?;
            store.cleanup()?;
            let mut paths = AutomationPaths {
                data: data_dir.join("automation"),
                ..Default::default()
            };
            if !cfg!(debug_assertions) {
                let folder = app.path().resource_dir()?.join("native");
                let suffix = if cfg!(windows) { ".exe" } else { "" };
                paths.worker = folder.join(format!("launchflow-automation{suffix}"));
                paths.harness = folder.join(format!("launchflow-harness{suffix}"));
            }
            let sessions = SessionManager::new(paths.clone());
            let mut session_events = sessions.subscribe();
            let session_app = app.handle().clone();
            let session_state = sessions.clone();
            tauri::async_runtime::spawn(async move {
                loop {
                    match session_events.recv().await {
                        Ok(event) => {
                            let _ = session_app.emit("launchflow://automationSession", event);
                        }
                        Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {
                            if let Some(event) = session_state.current() {
                                let _ = session_app.emit("launchflow://automationSession", event);
                            }
                        }
                        Err(_) => break,
                    }
                }
            });
            let engine = Engine::new(
                store,
                Arc::new(NodeRegistry::builtins()),
                native_platform_with_automation(paths),
            );
            let mut receiver = engine.subscribe();
            let startup_cancel = CancellationToken::new();
            let service_cancel = CancellationToken::new();
            let triggers = TriggerEngine::new(engine.clone());
            triggers.refresh()?;
            let mut trigger_events = triggers.subscribe();
            app.manage(AppState {
                execution_admission: Mutex::new(()),
                pending_import:Mutex::new(None),
                sessions,
                engine: engine.clone(),
                startup_cancel: startup_cancel.clone(),
                startup_requested: std::sync::atomic::AtomicBool::new(false),
                service_cancel: service_cancel.clone(),
                triggers: triggers.clone(),
                hotkey_sync: Arc::new(Mutex::new(())),
                workspace_closer: tokio::sync::Mutex::new(Default::default()),
                scene_shortcuts: Mutex::new(vec![]),
                close_shortcut: Mutex::new(None),
                close_shortcut_error: Mutex::new(None),
                icon_requests: tokio::sync::Mutex::new(()),
                startup_settings: tokio::sync::Mutex::new(()),
            });
            refresh_triggers(app.handle())?;
            let close_app=app.handle().clone();
            tauri::async_runtime::spawn_blocking(move|| {
                let saved=close_app.state::<AppState>().engine.store.workspace_close_value("shortcut").ok().flatten().unwrap_or_default();
                if let Err(error)=workspace_close::apply_shortcut(&close_app,&saved,false) {
                    if let Ok(mut status)=close_app.state::<AppState>().close_shortcut_error.lock() {*status=Some(error.clone());}
                    let _=close_app.emit("launchflow://error",error);
                }
            });
            let cleanup_engine=engine.clone();let cleanup_cancel=service_cancel.clone();
            tauri::async_runtime::spawn(async move {
                let mut timer=tokio::time::interval(Duration::from_secs(900));timer.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);timer.tick().await;
                loop {tokio::select!{_=cleanup_cancel.cancelled()=>break,_=timer.tick()=>{let _=cleanup_engine.store.cleanup();}}}
            });
            let trigger_app = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                triggers.start(service_cancel);
                let _ = triggers.lifecycle("appStarted");
                loop {
                    match trigger_events.recv().await {
                        Ok(event) => {
                            let _ = trigger_app.emit("launchflow://trigger", &event);
                            if event.kind=="error" && (event.message.contains("sensitiveApprovalRequired") || event.message.contains("permissionDenied")) {notify(&trigger_app,"LaunchFlow · 需要授权","场景需要敏感操作确认或系统权限。请在应用中检查后手动运行。");}
                        }
                        Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {
                            let _ = trigger_app.emit("launchflow://resync", ());
                        }
                        Err(_) => break,
                    }
                }
            });
            let tray = TrayIconBuilder::with_id("launchflow")
                .tooltip("LaunchFlow · 工作环境编排")
                .menu(&tray_menu(app.handle())?)
                .on_menu_event(|app, event| match event.id().as_ref() {
                    "open" => show_main(app),
                    "run-default" => {
                        if let Ok(scenes) = app.state::<AppState>().engine.store.scenes() {
                            if let Some(scene) = scenes.into_iter().find(|s| s.is_default) {
                                dispatch_scene(app, scene.id, "tray");
                            } else {
                                notify(app, "LaunchFlow", "请先选择默认启动场景");
                                show_main(app);
                            }
                        }
                    }
                    "stop" => {
                        app.state::<AppState>().startup_cancel.cancel();
                        app.state::<AppState>().engine.cancel_all();
                    }
                    "quit" => {
                        let _ = app.state::<AppState>().sessions.control("stop");
                        let app = app.clone();
                        app.state::<AppState>().service_cancel.cancel();
                        app.state::<AppState>().startup_cancel.cancel();
                        app.state::<AppState>().engine.cancel_all();
                        tauri::async_runtime::spawn(async move {
                            for _ in 0..40 {
                                if !app.state::<AppState>().engine.has_active() {
                                    break;
                                }
                                tokio::time::sleep(Duration::from_millis(50)).await;
                            }
                            app.exit(0);
                        });
                    }
                    id if id.starts_with("scene:") => {
                        dispatch_scene(app, id[6..].to_string(), "tray")
                    }
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if matches!(event, TrayIconEvent::DoubleClick { .. }) {
                        show_main(tray.app_handle());
                    }
                });
            let icon = app
                .default_window_icon()
                .ok_or("Application icon missing")?
                .clone();
            tray.icon(icon).build(app)?;
            let app_handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                loop {
                    match receiver.recv().await {
                        Ok(event) => {
                            let _ = app_handle.emit("launchflow://run", &event);
                            if event.kind == "RunStarted" {
                                notify(&app_handle, &event.run.scene_name, "正在准备工作环境…");
                            }
                            if event.kind == "RunCompleted" {
                                notify(
                                    &app_handle,
                                    &event.run.scene_name,
                                    "所有任务已完成，工作环境已就绪",
                                );
                            }
                            if event.kind == "RunFailed" {
                                notify(
                                    &app_handle,
                                    &event.run.scene_name,
                                    "运行失败，请打开运行历史查看详情。",
                                );
                                if event.run.node_runs.iter().any(|n|n.error.as_deref().is_some_and(|e|e.contains("permissionDenied"))) {notify(&app_handle,"LaunchFlow · 需要权限","打开权限与凭据中心检查系统授权。");}
                            }
                        }
                        Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {
                            let _ = app_handle.emit("launchflow://resync", ());
                        }
                        Err(_) => break,
                    }
                }
            });
            if std::env::args().any(|a| a == "--startup") {
                startup::request(app.handle());
            } else {
                show_main(app.handle());
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .run(context)
        .expect("LaunchFlow could not start");
}
