use launchflow_core::{
    automation::{Rect, WindowLocator},
    model::*,
    policy::{self, SensitiveActionPolicy},
    portable::{self, Document},
    rebind::{self, Mappings},
    storage::Store,
    workspace::*,
};
use serde_json::json;
use std::{
    collections::{BTreeMap, BTreeSet},
    io::{Cursor, Read, Write},
};
fn document() -> Document {
    let mut s = Scene::new("Portable example");
    s.workflow
        .nodes
        .push(Node::new("system.delay", "Ready", json!({"durationMs":1})));
    Document {
        schema_version: 2,
        scene: s,
        subflows: vec![],
        applications: vec![],
    }
}
fn display(id: &str, primary: bool, x: f64, width: f64) -> DisplayDescriptor {
    DisplayDescriptor {
        id: id.into(),
        name: "Panel".into(),
        bounds: Rect {
            x,
            y: 0.,
            width,
            height: 1080.,
        },
        work_area: Rect {
            x,
            y: 0.,
            width,
            height: 1040.,
        },
        scale: 1.,
        primary,
    }
}
fn layout(d: DisplayDescriptor) -> WindowLayout {
    WindowLayout {
        application_id: "app".into(),
        identity: WindowLocator {
            application: "fixture.exe".into(),
            ..Default::default()
        },
        bounds: Rect {
            x: -1800.,
            y: 40.,
            width: 1300.,
            height: 960.,
        },
        relative: Rect {
            x: 0.,
            y: 0.,
            width: 0.7,
            height: 1.,
        },
        display: d,
        state: WindowState::Normal,
    }
}
#[test]
fn display_fallback_and_reachable_relative_exact_layouts() {
    let saved = display("office", false, -1920., 1920.);
    let primary = display("laptop", true, 0., 1366.);
    let similar = display("new-cable", false, 1366., 1920.);
    assert_eq!(
        match_display(&saved, std::slice::from_ref(&saved))
            .unwrap()
            .1,
        "exact"
    );
    assert_eq!(
        match_display(&saved, &[primary.clone(), similar.clone()])
            .unwrap()
            .1,
        "similar"
    );
    let mut different = similar;
    different.bounds.width = 2560.;
    assert_eq!(
        match_display(&saved, &[primary.clone(), different])
            .unwrap()
            .1,
        "role"
    );
    assert_eq!(
        match_display(&saved, std::slice::from_ref(&primary))
            .unwrap()
            .1,
        "primary"
    );
    assert!(match_display(&saved, &[]).is_none());
    let w = layout(saved);
    let relative = placement(&w, &primary, LayoutMode::Relative);
    assert_eq!(relative.x, 0.);
    assert!((relative.width - 956.2).abs() < 0.1);
    let exact = placement(&w, &primary, LayoutMode::Exact);
    assert_eq!(exact.x, 0.);
    assert!(exact.x + exact.width <= primary.work_area.width);
    assert!(exact.y + exact.height <= primary.work_area.height);
}
#[test]
fn yaml_roundtrip_migration_and_import_do_not_arm_triggers() {
    let mut doc = document();
    doc.scene.is_default = true;
    doc.scene.allow_commands_at_startup = true;
    doc.scene.sensitive_action_policy = SensitiveActionPolicy::AllowForThisScene;
    doc.scene.triggers.push(Trigger {
        id: id(),
        kind: "manual".into(),
        enabled: true,
        config: json!({}),
        parameters: BTreeMap::new(),
    });
    let source = portable::parse(&portable::yaml(&doc).unwrap()).unwrap();
    assert!(!source.migrated);
    let legacy = portable::parse(&serde_json::to_string(&doc.scene).unwrap()).unwrap();
    assert!(legacy.migrated);
    let imported = rebind::prepare_import(source.document).unwrap();
    assert_ne!(imported.scene.id, doc.scene.id);
    assert_eq!(imported.scene.version, 0);
    assert!(!imported.scene.is_default);
    assert!(!imported.scene.allow_commands_at_startup);
    assert!(imported.scene.triggers.iter().all(|t| !t.enabled));
    assert_eq!(
        imported.scene.sensitive_action_policy,
        SensitiveActionPolicy::AskEveryTime
    );
}
#[test]
fn yaml_rejects_future_unknown_duplicate_credential_and_recursive_input() {
    let doc = document();
    let yaml = portable::yaml(&doc).unwrap();
    assert!(portable::parse(&yaml.replacen("schemaVersion: 2", "schemaVersion: 999", 1)).is_err());
    assert!(portable::parse(&(yaml.clone() + "unknownField: value\n")).is_err());
    assert!(portable::parse(&(yaml + "schemaVersion: 2\n")).is_err());
    assert!(portable::parse("x: &x [*x]\nschemaVersion: 2").is_err());
    assert!(portable::parse("schemaVersion: 2\nscene: !unsafe anything").is_err());
    let mut bad = doc;
    bad.scene.description = "password=do-not-export".into();
    assert!(portable::yaml(&bad).is_err());
    let bomb = format!(
        "x: &x '{}'\ny: [{}]\nschemaVersion: 2",
        "a".repeat(120_000),
        vec!["*x"; 100].join(",")
    );
    assert!(portable::parse(&bomb).is_err());
}
#[test]
fn package_asset_integrity_and_zip_traversal_are_checked() {
    let dir = tempfile::tempdir().unwrap();
    let mut doc = document();
    let mut png = Cursor::new(Vec::new());
    image::DynamicImage::new_rgba8(16, 16)
        .write_to(&mut png, image::ImageFormat::Png)
        .unwrap();
    let bytes = png.into_inner();
    let id = portable::digest(&bytes);
    doc.scene.workflow.nodes = vec![Node::new(
        "gui.click",
        "Click",
        json!({"locators":[{"kind":"image","window":{"application":"fixture.exe"},"assetId":id}]}),
    )];
    let assets = BTreeMap::from([(id.clone(), bytes)]);
    let packed = portable::package(&doc, &assets).unwrap();
    let path = dir.path().join("scene.launchflow");
    std::fs::write(&path, &packed).unwrap();
    let restored = portable::read(&path).unwrap();
    assert_eq!(restored.assets, assets);
    let mut archive = zip::ZipArchive::new(Cursor::new(&packed)).unwrap();
    let mut writer = zip::ZipWriter::new(Cursor::new(Vec::new()));
    for i in 0..archive.len() {
        let mut file = archive.by_index(i).unwrap();
        let mut content = Vec::new();
        file.read_to_end(&mut content).unwrap();
        if file.name() == "scene.yaml" {
            content.push(b' ');
        }
        writer
            .start_file(file.name(), zip::write::SimpleFileOptions::default())
            .unwrap();
        writer.write_all(&content).unwrap();
    }
    std::fs::write(&path, writer.finish().unwrap().into_inner()).unwrap();
    assert!(portable::read(&path).is_err());
    let mut writer = zip::ZipWriter::new(Cursor::new(Vec::new()));
    writer
        .start_file("../outside", zip::write::SimpleFileOptions::default())
        .unwrap();
    writer.write_all(b"bad").unwrap();
    std::fs::write(&path, writer.finish().unwrap().into_inner()).unwrap();
    assert!(portable::read(&path).is_err());
    assert!(!dir.path().join("outside").exists());
}
#[test]
fn rebind_reports_missing_and_maps_app_path_and_secret() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("fixture.exe");
    std::fs::write(&path, []).unwrap();
    let mut doc = document();
    let foreign = ApplicationProfile {
        schema_version: 1,
        id: "foreign".into(),
        display_name: "IDE".into(),
        windows: WindowsBinding {
            use_preauthorized_task: false,
            run_as_administrator: false,
            executable: "Z:/missing/ide.exe".into(),
            process_name: "ide.exe".into(),
        },
        macos: MacosBinding::default(),
        launch_arguments: vec![],
        ready_detection: None,
    };
    doc.applications.push(foreign.clone());
    doc.scene.workflow.nodes = vec![Node::new(
        "application.launch",
        "IDE",
        json!({"applicationId":"foreign","arguments":["Z:/project"],"alreadyRunning":"skip"}),
    )];
    doc.scene.parameters = vec![Parameter {
        name: "credential".into(),
        kind: "secretReference".into(),
        description: String::new(),
        required: true,
        default_value: json!("vault:remote"),
        options: vec![],
        validation: ParameterValidation::default(),
    }];
    let missing = rebind::analyze(
        &doc,
        &Mappings::default(),
        &[],
        &BTreeSet::new(),
        &BTreeSet::new(),
        "windows",
    )
    .unwrap();
    assert!(!missing.ready);
    assert!(missing
        .bindings
        .iter()
        .any(|b| b.kind == "application" && !b.found));
    assert!(missing
        .bindings
        .iter()
        .any(|b| b.kind == "secret" && !b.found));
    let mut local = foreign;
    local.id = "local".into();
    local.windows.executable = path.to_string_lossy().into();
    let mappings = Mappings {
        applications: BTreeMap::from([("foreign".into(), "local".into())]),
        paths: BTreeMap::from([("Z:/project".into(), dir.path().to_string_lossy().into())]),
        secrets: BTreeMap::from([("vault:remote".into(), "vault:local".into())]),
    };
    let mapped = rebind::analyze(
        &doc,
        &mappings,
        &[local],
        &BTreeSet::from(["local".into()]),
        &BTreeSet::new(),
        "windows",
    )
    .unwrap();
    assert!(mapped.ready, "{:?}", mapped.bindings);
    assert_eq!(
        mapped.document.scene.workflow.nodes[0].config["applicationId"],
        "local"
    );
    assert_eq!(
        mapped.document.scene.parameters[0].default_value,
        "vault:local"
    );
    assert!(mapped
        .bindings
        .iter()
        .any(|b| b.source == "vault:remote" && b.target == "vault:local"));
}
#[test]
fn diagnostics_never_include_raw_user_content() {
    let secret = "SYNTHETIC_DO_NOT_SHARE_987";
    let mut s = document().scene;
    s.name = secret.into();
    s.workflow.nodes[0].name = secret.into();
    s.workflow.nodes[0].id = secret.into();
    let mut run = Run::new(s, "manual");
    run.id = secret.into();
    run.error = Some(secret.into());
    run.parameter_snapshot.insert("input".into(), json!(secret));
    run.node_runs[0].stdout = secret.into();
    run.node_runs[0].error = Some(format!("permissionDenied {secret}"));
    let bundle = launchflow_core::diagnostics::bundle(
        "0.4.0",
        2,
        &json!({"accessibility":"granted","secret":secret}),
        &[run],
    )
    .unwrap();
    let mut zip = zip::ZipArchive::new(Cursor::new(bundle)).unwrap();
    assert_eq!(zip.len(), 5);
    for i in 0..zip.len() {
        let mut text = String::new();
        zip.by_index(i).unwrap().read_to_string(&mut text).unwrap();
        assert!(!text.contains(secret));
    }
    let mut trace = String::new();
    zip.by_name("error-traces.json")
        .unwrap()
        .read_to_string(&mut trace)
        .unwrap();
    assert!(trace.contains("permission"));
}
#[test]
fn history_retention_forever_and_periodic_cleanup_preserve_active_runs() {
    let store = Store::memory().unwrap();
    let mut run = Run::new(document().scene, "manual");
    run.status = RunStatus::Succeeded;
    run.started_at = (chrono::Utc::now() - chrono::Duration::days(40)).to_rfc3339();
    store.save_run(&run).unwrap();
    let mut active = run.clone();
    active.id = id();
    active.status = RunStatus::Running;
    store.save_run(&active).unwrap();
    let mut settings = Settings {
        retention_days: 0,
        ..Default::default()
    };
    store.save_settings(&settings).unwrap();
    assert_eq!(store.cleanup().unwrap(), 0);
    settings.retention_days = 30;
    store.save_settings(&settings).unwrap();
    assert_eq!(store.cleanup().unwrap(), 1);
    assert!(store.run(&active.id).is_ok());
}
#[test]
fn import_transaction_does_not_leave_partial_scenes_or_profiles() {
    let store = Store::memory().unwrap();
    let s = document().scene;
    assert!(store
        .create_scenes_with_profiles(vec![s.clone(), s], &[])
        .is_err());
    assert!(store.scenes().unwrap().is_empty());
}
#[test]
fn sensitive_policy_requires_explicit_confirmation_and_blocks_startup() {
    let mut scene = document().scene;
    scene.workflow.nodes[0] = Node::new("gui.inputSecret", "Secret", json!({}));
    assert!(policy::check(std::iter::once(&scene), "startup", true).is_err());
    scene.allow_commands_at_startup = true;
    assert!(policy::check(std::iter::once(&scene), "startup", true).is_err());
    assert!(policy::check(std::iter::once(&scene), "appStarted", true).is_err());
    scene.sensitive_action_policy = SensitiveActionPolicy::AskEveryTime;
    assert!(policy::check(std::iter::once(&scene), "manual", false).is_err());
    assert!(policy::check(std::iter::once(&scene), "manual", true).is_ok());
    assert!(policy::check(std::iter::once(&scene), "schedule", false).is_err());
    scene.sensitive_action_policy = SensitiveActionPolicy::AllowForThisScene;
    assert!(policy::check(std::iter::once(&scene), "startup", false).is_ok());
}

#[test]
fn application_cannot_be_deleted_while_a_workspace_profile_references_it() {
    let store = Store::memory().unwrap();
    let profile = ApplicationProfile {
        schema_version: 1,
        id: id(),
        display_name: "Workspace application".into(),
        windows: WindowsBinding::default(),
        macos: MacosBinding::default(),
        launch_arguments: vec![],
        ready_detection: None,
    };
    store.save_profile(&profile).unwrap();
    let mut scene = document().scene;
    scene.workflow.nodes = vec![Node::new(
        "workspace.restore",
        "Layout",
        json!({
            "profiles":[{"name":"Office","windows":[{"applicationId":profile.id}]}]
        }),
    )];
    let saved = store.save_scene(scene).unwrap();
    assert!(store.delete_profile(&profile.id).is_err());
    store.delete_scene(&saved.id).unwrap();
    assert!(store.delete_profile(&profile.id).is_ok());
}
