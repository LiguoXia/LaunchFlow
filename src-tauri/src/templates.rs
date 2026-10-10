use crate::{api, refresh_tray, ApiResult, AppState};
use launchflow_core::{
    model::{id, Scene},
    templates::windows_demo,
};
use serde_json::json;
use tauri::State;

#[tauri::command]
pub async fn load_windows_demo(
    state: State<'_, AppState>,
    app: tauri::AppHandle,
) -> ApiResult<Vec<Scene>> {
    let engine = &state.engine;
    if engine.platform.os() != "windows" {
        return Err("此模板使用 Windows 默认应用，请在 Windows 上载入。".into());
    }
    let provider = engine.platform.automation();
    let paths = provider.paths();
    let windows = std::path::PathBuf::from(
        std::env::var_os("WINDIR").unwrap_or_else(|| "C:\\Windows".into()),
    );
    let notepad = windows.join("System32/notepad.exe");
    let powershell = windows.join("System32/WindowsPowerShell/v1.0/powershell.exe");
    if !paths.harness.is_file() || !notepad.is_file() || !powershell.is_file() {
        return Err(
            "缺少模板所需的练习程序、Windows 记事本或 PowerShell，请修复安装后重试。".into(),
        );
    }
    // Keep the reservation until the template transaction commits. Each installation is independent.
    let reservation = std::net::TcpListener::bind(("127.0.0.1", 0)).map_err(|e| e.to_string())?;
    let port = reservation.local_addr().map_err(|e| e.to_string())?.port();
    let folder = paths.data.join("templates").join(id());
    std::fs::create_dir_all(&folder).map_err(|e| e.to_string())?;
    let file = folder.join("LaunchFlow-体验说明.txt");
    std::fs::write(&file, "\u{feff}LaunchFlow · Windows 全步骤体验\r\n\r\n此模板包含全部 32 种步骤，主场景 42 步，另有配套子场景。\r\n启动后请观察练习窗口，并在运行详情中查看每一步的结果。\r\n使用记事本、资源管理器、默认浏览器及随包提供的练习窗口。\r\n本地网页只监听 127.0.0.1，关闭练习窗口即停止服务。\r\nSecret 步骤使用专用演示凭据，不需要真实密码。\r\n\r\n每个步骤都有中文说明，可在编辑器选择步骤查看参数。\r\n完成后请自行关闭体验窗口。主场景、子场景可在我的场景分别删除；应用配置及演示凭据可在应用库、权限与凭据中删除。\r\n").map_err(|e| e.to_string())?;
    let demo = windows_demo(
        &paths.harness.to_string_lossy(),
        &notepad.to_string_lossy(),
        &powershell.to_string_lossy(),
        &folder.to_string_lossy(),
        &file.to_string_lossy(),
        port,
    );
    provider.request(json!({"op":"vault","action":"create","id":demo.secret_id,"label":"模板演示 · 可删除（非真实密码）","value":"LaunchFlow-Demo-Only"})).await.map_err(|e| e.to_string())?;
    let saved = match api(engine
        .store
        .create_scenes_with_profiles(demo.scenes, &demo.profiles))
    {
        Ok(scenes) => scenes,
        Err(error) => {
            let _ = provider
                .request(json!({"op":"vault","action":"delete","id":demo.secret_id}))
                .await;
            return Err(error);
        }
    };
    refresh_tray(&app)?;
    Ok(saved)
}
