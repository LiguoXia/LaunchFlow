use launchflow_core::{application_discovery::identity, model::*, storage::Store};
fn profile(name: &str, path: &str, args: &[&str]) -> ApplicationProfile {
    ApplicationProfile {
        schema_version: 1,
        id: id(),
        display_name: name.into(),
        windows: WindowsBinding {
            executable: path.into(),
            ..Default::default()
        },
        macos: MacosBinding::default(),
        launch_arguments: args.iter().map(|s| s.to_string()).collect(),
        ready_detection: None,
    }
}
#[test]
fn capture_add_is_atomic_case_insensitive_and_never_overwrites_existing_configuration() {
    let store = Store::memory().unwrap();
    let mut existing = profile("Custom name", "C:\\Tools\\App.exe", &[]);
    existing.windows.run_as_administrator = true;
    existing.ready_detection = Some(ReadyDetection::Port {
        host: "localhost".into(),
        port: 12345,
    });
    store.save_profile(&existing).unwrap();
    let same = profile("Detected name", "c:/tools/APP.EXE", &[]);
    let fresh = profile("Fresh", "C:\\Tools\\Fresh.exe", &[]);
    assert_eq!(
        store
            .add_discovered_profiles(&[same, fresh.clone(), fresh.clone()], "windows")
            .unwrap(),
        1
    );
    let profiles = store.profiles().unwrap();
    assert_eq!(profiles.len(), 2);
    let preserved = profiles.iter().find(|p| p.id == existing.id).unwrap();
    assert_eq!(preserved.display_name, "Custom name");
    assert!(preserved.windows.run_as_administrator);
    assert!(preserved.ready_detection.is_some());
    assert_eq!(
        store.add_discovered_profiles(&[fresh], "windows").unwrap(),
        0
    );
    let valid = profile("Not added on failure", "C:\\new.exe", &[]);
    let mut invalid = profile("Invalid", "C:\\invalid.exe", &[]);
    invalid.schema_version = 99;
    assert!(store
        .add_discovered_profiles(&[valid, invalid], "windows")
        .is_err());
    assert_eq!(store.profiles().unwrap().len(), 2);
}
#[test]
fn packaged_apps_are_distinct_and_builtin_aliases_match_the_existing_library() {
    let windows = std::env::var("WINDIR").unwrap_or_else(|_| "C:\\Windows".into());
    let explorer = format!("{windows}\\explorer.exe");
    let notepad = profile("Notepad", &format!("{windows}\\System32\\notepad.exe"), &[]);
    let packaged = profile(
        "Notepad Store",
        &explorer,
        &["shell:AppsFolder\\Microsoft.WindowsNotepad_8wekyb3d8bbwe!App"],
    );
    let calc = profile(
        "Calculator",
        &explorer,
        &["shell:AppsFolder\\Microsoft.WindowsCalculator_8wekyb3d8bbwe!App"],
    );
    assert_eq!(
        identity(&notepad, "windows"),
        identity(&packaged, "windows")
    );
    assert_ne!(identity(&packaged, "windows"), identity(&calc, "windows"));
    let store = Store::memory().unwrap();
    store.save_profile(&notepad).unwrap();
    assert_eq!(
        store
            .add_discovered_profiles(&[packaged, calc], "windows")
            .unwrap(),
        1
    );
}
