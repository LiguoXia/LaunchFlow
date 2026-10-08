use crate::{api, refresh_tray, ApiResult, AppState};
use launchflow_core::{
    automation::assets::AssetStore,
    portable::{self, Document, ImportSource},
    rebind::{self, Analysis, Mappings},
};
use launchflow_core::{
    model::*,
    workspace::{self, Capture, CapturedWindow},
};
use serde_json::{json, Value};
use std::{
    collections::{BTreeMap, BTreeSet},
    path::{Path, PathBuf},
    time::Instant,
};
use tauri::State;
pub struct PendingImport {
    token: String,
    source: ImportSource,
    created: Instant,
}
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportPreview {
    token: String,
    migrated: bool,
    analysis: Analysis,
}
fn output_file(path: &str, extensions: &[&str]) -> ApiResult<PathBuf> {
    let p = PathBuf::from(path);
    if !p.is_absolute()
        || !p
            .extension()
            .and_then(|s| s.to_str())
            .is_some_and(|s| extensions.contains(&s.to_ascii_lowercase().as_str()))
    {
        return Err("Choose an absolute path with a supported file extension".into());
    }
    Ok(p)
}
#[tauri::command]
pub fn scene_export(
    scene_id: String,
    path: String,
    package: bool,
    state: State<'_, AppState>,
) -> ApiResult<()> {
    let store = &state.engine.store;
    let all = api(store.scenes())?;
    let scene = api(store.scene(&scene_id))?;
    let mut subflows = Vec::new();
    let mut queue = vec![scene.clone()];
    let mut visited = BTreeSet::from([scene_id]);
    while let Some(s) = queue.pop() {
        for n in s
            .workflow
            .nodes
            .iter()
            .filter(|n| n.node_type == "flow.subflow")
        {
            let id = n.config["sceneId"].as_str().unwrap_or("");
            if visited.insert(id.into()) {
                let child = all
                    .iter()
                    .find(|s| s.id == id)
                    .ok_or("Missing subflow dependency")?
                    .clone();
                queue.push(child.clone());
                subflows.push(child);
            }
        }
    }
    let mut doc = Document {
        schema_version: portable::FORMAT_VERSION,
        scene,
        subflows,
        applications: vec![],
    };
    let app_ids = portable::references(&doc, "applicationId");
    doc.applications = api(store.profiles())?
        .into_iter()
        .filter(|p| app_ids.contains(&p.id))
        .collect();
    let destination = output_file(
        &path,
        if package {
            &["launchflow"]
        } else {
            &["yaml", "yml"]
        },
    )?;
    let bytes = if package {
        let asset_store = AssetStore::new(state.engine.platform.automation().paths());
        let mut assets = BTreeMap::new();
        for id in portable::references(&doc, "assetId") {
            let path = asset_store.asset_path(&id).map_err(|e| e.message)?;
            assets.insert(id, api(portable::read_bounded(&path, 8 * 1024 * 1024))?);
        }
        api(portable::package(&doc, &assets))?
    } else {
        api(portable::yaml(&doc))?.into_bytes()
    };
    atomic_write(&destination, &bytes)
}
fn atomic_write(path: &Path, bytes: &[u8]) -> ApiResult<()> {
    use std::io::Write;
    let temp = path.with_file_name(format!(".launchflow-{}.tmp", id()));
    let result = (|| {
        let mut f = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temp)?;
        f.write_all(bytes)?;
        f.sync_all()?;
        drop(f);
        std::fs::rename(&temp, path)
    })()
    .map_err(|e: std::io::Error| e.to_string());
    if result.is_err() {
        let _ = std::fs::remove_file(&temp);
    }
    result
}
async fn import_analysis(
    source: &ImportSource,
    mappings: &Mappings,
    state: &AppState,
) -> ApiResult<Analysis> {
    let provider = state.engine.platform.automation();
    let secret_ids = provider
        .request(json!({"op":"vault","action":"list"}))
        .await
        .map(|v| {
            v.as_array()
                .into_iter()
                .flatten()
                .filter_map(|v| v["id"].as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default();
    let assets = AssetStore::new(provider.paths());
    let asset_ids = portable::references(&source.document, "assetId")
        .into_iter()
        .filter(|id| source.assets.contains_key(id) || assets.asset_path(id).is_ok())
        .collect();
    api(rebind::analyze(
        &source.document,
        mappings,
        &api(state.engine.store.profiles())?,
        &secret_ids,
        &asset_ids,
        state.engine.platform.os(),
    ))
}
#[tauri::command]
pub async fn scene_import_preview(
    path: String,
    state: State<'_, AppState>,
) -> ApiResult<ImportPreview> {
    let source = api(portable::read(Path::new(&path)))?;
    let analysis = import_analysis(&source, &Mappings::default(), &state).await?;
    let token = id();
    let migrated = source.migrated;
    *state
        .pending_import
        .lock()
        .map_err(|_| "Import state unavailable")? = Some(PendingImport {
        token: token.clone(),
        source,
        created: Instant::now(),
    });
    Ok(ImportPreview {
        token,
        migrated,
        analysis,
    })
}
fn pending(state: &AppState, token: &str) -> ApiResult<ImportSource> {
    state
        .pending_import
        .lock()
        .map_err(|_| "Import state unavailable")?
        .as_ref()
        .filter(|p| p.token == token && p.created.elapsed().as_secs() < 1200)
        .map(|p| p.source.clone())
        .ok_or("Import preview expired. Choose the file again.".into())
}
#[tauri::command]
pub async fn scene_import_rebind(
    token: String,
    mappings: Mappings,
    state: State<'_, AppState>,
) -> ApiResult<ImportPreview> {
    let source = pending(&state, &token)?;
    let analysis = import_analysis(&source, &mappings, &state).await?;
    Ok(ImportPreview {
        token,
        migrated: source.migrated,
        analysis,
    })
}
#[tauri::command]
pub async fn scene_import_commit(
    token: String,
    mappings: Mappings,
    state: State<'_, AppState>,
    app: tauri::AppHandle,
) -> ApiResult<Scene> {
    let source = pending(&state, &token)?;
    let analysis = import_analysis(&source, &mappings, &state).await?;
    if !analysis.ready {
        return Err(
            "Resolve missing application, path, secret and image bindings before importing".into(),
        );
    }
    let doc = api(rebind::prepare_import(analysis.document))?;
    let mut guard = state
        .pending_import
        .lock()
        .map_err(|_| "Import state unavailable")?;
    if !guard.as_ref().is_some_and(|p| p.token == token) {
        return Err("Import preview has changed".into());
    }
    let folder = state
        .engine
        .platform
        .automation()
        .paths()
        .data
        .join("assets");
    std::fs::create_dir_all(&folder).map_err(|e| e.to_string())?;
    for (id, bytes) in &source.assets {
        api(portable::validate_asset(id, bytes))?;
        let destination = folder.join(format!("{id}.png"));
        if destination.exists() {
            let existing = api(portable::read_bounded(&destination, 8 * 1024 * 1024))?;
            api(portable::validate_asset(id, &existing))?;
        } else {
            atomic_write(&destination, bytes)?;
        }
    }
    let mut scenes = vec![doc.scene];
    scenes.extend(doc.subflows);
    let scene = api(state
        .engine
        .store
        .create_scenes_with_profiles(scenes, &doc.applications))?
    .remove(0);
    *guard = None;
    drop(guard);
    crate::refresh_triggers(&app)?;
    refresh_tray(&app)?;
    Ok(scene)
}
#[tauri::command]
pub fn sensitive_actions(scene_id: String, state: State<'_, AppState>) -> ApiResult<Vec<String>> {
    api(state.engine.sensitive_actions(&scene_id))
}
#[tauri::command]
pub fn diagnostic_log(
    run_id: Option<String>,
    state: State<'_, AppState>,
    app: tauri::AppHandle,
) -> ApiResult<String> {
    let run = run_id
        .as_deref()
        .map(|id| state.engine.store.run(id))
        .transpose()
        .map_err(|e| e.to_string())?;
    api(launchflow_core::application_log::report(
        &app.package_info().version.to_string(),
        &state.engine.platform.automation().paths().data,
        run.as_ref(),
    ))
}
#[tauri::command]
pub async fn export_diagnostics(
    path: String,
    state: State<'_, AppState>,
    app: tauri::AppHandle,
) -> ApiResult<()> {
    let path = output_file(&path, &["zip"])?;
    let permissions = state
        .engine
        .platform
        .automation()
        .request(json!({"op":"permissions"}))
        .await
        .unwrap_or(Value::Null);
    let log = api(launchflow_core::application_log::read(
        &state.engine.platform.automation().paths().data,
    ))?;
    let bytes = api(launchflow_core::diagnostics::bundle_with_application_log(
        &app.package_info().version.to_string(),
        api(state.engine.store.schema_version())?,
        &permissions,
        &api(state.engine.store.runs())?,
        &log,
    ))?;
    atomic_write(&path, &bytes)
}

#[tauri::command]
pub async fn vault_metadata(state: State<'_, AppState>) -> ApiResult<Value> {
    state
        .engine
        .platform
        .automation()
        .request(json!({"op":"vault","action":"list"}))
        .await
        .map_err(|e| e.message)
}
#[tauri::command]
pub async fn vault_write(
    id: String,
    label: String,
    value: String,
    update: bool,
    state: State<'_, AppState>,
) -> ApiResult<()> {
    if !launchflow_core::vault::valid_id(&id)
        || label.chars().count() > 80
        || value.is_empty()
        || value.len() > 2560
    {
        return Err("Invalid secret ID, label or value length".into());
    }
    state.engine.platform.automation().request(json!({"op":"vault","action":if update {"update"}else{"create"},"id":id,"label":label,"value":value})).await.map_err(|e|e.message)?;
    Ok(())
}
#[tauri::command]
pub async fn vault_delete(id: String, state: State<'_, AppState>) -> ApiResult<()> {
    if !launchflow_core::vault::valid_id(&id) {
        return Err("Invalid secret ID".into());
    }
    state
        .engine
        .platform
        .automation()
        .request(json!({"op":"vault","action":"delete","id":id}))
        .await
        .map_err(|e| e.message)?;
    Ok(())
}

#[tauri::command]
pub async fn workspace_capture(state: State<'_, AppState>) -> ApiResult<Capture> {
    let profiles = api(state.engine.store.profiles())?;
    api(workspace::capture(
        state.engine.platform.automation().as_ref(),
        state.engine.platform.os(),
        &profiles,
    )
    .await)
}
#[tauri::command]
pub fn workspace_create_scene(
    name: String,
    windows: Vec<CapturedWindow>,
    capture_layout: bool,
    profile_name: String,
    monitor_count: usize,
    state: State<'_, AppState>,
    app: tauri::AppHandle,
) -> ApiResult<Scene> {
    let (scene, profiles) = api(workspace::scene_from_capture(
        &name,
        windows,
        capture_layout,
        &profile_name,
        monitor_count,
    ))?;
    let mut all = api(state.engine.store.profiles())?;
    for p in &profiles {
        api(launchflow_core::validation::validate_profile(p))?;
        if !all.iter().any(|a| a.id == p.id) {
            all.push(p.clone());
        }
    }
    let issues = launchflow_core::validation::validate_scene(
        &scene,
        &state.engine.registry,
        &all,
        state.engine.platform.os(),
        true,
    );
    if !issues.is_empty() {
        return Err(issues
            .iter()
            .map(|i| i.message.clone())
            .collect::<Vec<_>>()
            .join("\n"));
    }
    let scene = api(state
        .engine
        .store
        .create_scene_with_profiles(scene, &profiles))?;
    refresh_tray(&app)?;
    Ok(scene)
}
