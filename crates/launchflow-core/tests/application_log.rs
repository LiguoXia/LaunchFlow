use launchflow_core::{
    application_log::{self, BrokerStage, RequestLog},
    Error,
};
use serde_json::json;
use std::{
    fs,
    io::{Read, Write},
};

#[test]
fn pointer_route_and_legacy_error_export_without_coordinates_or_control_content() {
    use launchflow_core::model::{Node, Run, Scene};
    let dir = tempfile::tempdir().unwrap();
    let mut scene = Scene::new("PRIVATE_CLICK_CONTENT");
    scene
        .workflow
        .nodes
        .push(Node::new("gui.click", "PRIVATE_CLICK_CONTENT", json!({})));
    let mut run = Run::new(scene, "manual");
    run.node_runs[0].output = json!({"automation": {
        "pointer":{"route":"sendInput","targetRole":"Coordinate","positionSource":"explicitPoint","stage":"inputDispatched","inputEventsSent":2,"hitTestMatched":true,"x":1234,"y":4321,"name":"PRIVATE_CLICK_CONTENT"}
    }});
    let text = application_log::report("0.4.11", dir.path(), Some(&run)).unwrap();
    let parsed: serde_json::Value = serde_json::from_str(&text).unwrap();
    assert_eq!(parsed["run"]["nodes"][0]["kind"], "gui.click");
    let pointer = &parsed["run"]["nodes"][0]["automation"]["pointer"];
    assert_eq!(pointer["route"], "sendInput");
    assert_eq!(pointer["inputEventsSent"], 2);
    assert!(pointer.get("x").is_none());
    assert!(!text.contains("PRIVATE_CLICK_CONTENT"));
    run.node_runs[0].output["automation"]["error"] = json!({"code":"impreciseClickTarget","message":"PRIVATE_CLICK_CONTENT","details":{"pointer":{"route":"sendInput","targetRole":"Window","positionSource":"elementBounds","stage":"targetValidation","inputEventsSent":0}}});
    let text = application_log::report("0.4.11", dir.path(), Some(&run)).unwrap();
    let parsed: serde_json::Value = serde_json::from_str(&text).unwrap();
    assert_eq!(
        parsed["run"]["nodes"][0]["automation"]["errorCode"],
        "impreciseClickTarget"
    );
    assert_eq!(
        parsed["run"]["nodes"][0]["automation"]["pointer"]["targetRole"],
        "Window"
    );
    run.node_runs[0].output["automation"]["error"]["details"]["pointer"]["route"] =
        json!("PRIVATE_CLICK_CONTENT");
    run.node_runs[0].output["automation"]["error"]["details"]["pointer"]["targetRole"] =
        json!("PRIVATE_CLICK_CONTENT");
    let text = application_log::report("0.4.11", dir.path(), Some(&run)).unwrap();
    assert!(!text.contains("PRIVATE_CLICK_CONTENT"));
}

#[test]
fn gui_focus_diagnostics_survive_copy_and_bundle_without_private_fields() {
    use launchflow_core::model::{Node, Run, Scene};
    let dir = tempfile::tempdir().unwrap();
    let mut scene = Scene::new("PRIVATE_GUI_NAME");
    scene.workflow.nodes.push(Node::new(
        "gui.activateWindow",
        "PRIVATE_GUI_NAME",
        json!({}),
    ));
    let mut run = Run::new(scene, "manual");
    run.node_runs[0].error = Some("GUI automation failed: focusDenied: PRIVATE_GUI_NAME".into());
    run.node_runs[0].output = json!({"automation": {
        "application":"PRIVATE_GUI_NAME", "window":{"title":"PRIVATE_GUI_NAME"},
        "screenshot":"PRIVATE_GUI_NAME", "durationMs":2345,
        "locatorAttempts":[{"kind":"window","success":true,"durationMs":20,"input":"PRIVATE_GUI_NAME"}],
        "error":{"code":"focusDenied","message":"PRIVATE_GUI_NAME","details":{
            "stage":"foregroundTimeout","elapsedMs":2000,"foregroundMatched":false,
            "requestAccepted":true,"foregroundGrantAccepted":true,"hiddenRestoreRequested":true,"targetVisible":false,
            "hiddenRestoreMethod":"applicationActivation","applicationId":"PRIVATE_GUI_NAME","title":"PRIVATE_GUI_NAME"}}
    }});
    let report = application_log::report("0.4.10", dir.path(), Some(&run)).unwrap();
    assert!(!report.contains("PRIVATE_GUI_NAME"));
    let parsed: serde_json::Value = serde_json::from_str(&report).unwrap();
    let a = &parsed["run"]["nodes"][0]["automation"];
    assert_eq!(a["errorCode"], "focusDenied");
    assert_eq!(a["focus"]["stage"], "foregroundTimeout");
    assert_eq!(a["focus"]["requestAccepted"], true);
    assert_eq!(a["focus"]["hiddenRestoreRequested"], true);
    assert_eq!(a["focus"]["targetVisible"], false);
    assert_eq!(a["focus"]["hiddenRestoreMethod"], "applicationActivation");
    let bundle =
        launchflow_core::diagnostics::bundle("0.4.10", 1, &json!({}), &[run.clone()]).unwrap();
    let mut zip = zip::ZipArchive::new(std::io::Cursor::new(bundle)).unwrap();
    let mut text = String::new();
    zip.by_name("runs.json")
        .unwrap()
        .read_to_string(&mut text)
        .unwrap();
    assert!(text.contains("foregroundTimeout"));
    assert!(text.contains("applicationActivation"));
    assert!(!text.contains("PRIVATE_GUI_NAME"));
    run.node_runs[0].output["automation"]["error"]["code"] = json!("PRIVATE_GUI_NAME");
    run.node_runs[0].output["automation"]["error"]["details"]["stage"] = json!("PRIVATE_GUI_NAME");
    run.node_runs[0].output["automation"]["error"]["details"]["requestAccepted"] =
        json!("PRIVATE_GUI_NAME");
    let report = application_log::report("0.4.10", dir.path(), Some(&run)).unwrap();
    assert!(!report.contains("PRIVATE_GUI_NAME"));
}

#[test]
fn failure_details_persist_without_request_secrets_or_raw_exceptions() {
    let dir = tempfile::tempdir().unwrap();
    let mut log = RequestLog::begin(
        dir.path(),
        &json!({"op":"applicationAuthorizationRun","profileId":"private-name","executable":"C:/private/path.exe","arguments":["super-secret-token"]}),
    );
    log.stage(BrokerStage::Response);
    log.response(&json!({"error":{"message":"super-secret-token"},"diagnostics":{"steps":[{"stage":"task.run","elapsedMs":12,"input":"super-secret-token"}],"exceptionType":"System.ArgumentException","hresult":"0x80070057","frames":["LaunchFlow.Native.TaskAuthorization.Run","C:/private/source.cs"],"message":"super-secret-token","osVersion":"10.0.26200.0","runtimeVersion":"4.0.30319.42000"}}));
    log.finish(&Err(Error::ApplicationLaunchReview(
        "super-secret-token".into(),
    )));
    drop(log);
    let events = application_log::read(dir.path()).unwrap();
    assert_eq!(events[1]["outcome"], "failed");
    assert_eq!(events[1]["native"]["hresult"], "0x80070057");
    assert_eq!(events[1]["native"]["steps"][0]["stage"], "task.run");
    assert_eq!(events[1]["native"]["frames"].as_array().unwrap().len(), 1);
    let copy = application_log::report("0.4.4", dir.path(), None).unwrap();
    let disk = fs::read_to_string(dir.path().join("logs/application.jsonl")).unwrap();
    for content in [copy, disk] {
        for secret in ["super-secret-token", "private-name", "C:/private"] {
            assert!(!content.contains(secret));
        }
    }
    let bundle = launchflow_core::diagnostics::bundle_with_application_log(
        "0.4.4",
        1,
        &json!({}),
        &[],
        &events,
    )
    .unwrap();
    let mut zip = zip::ZipArchive::new(std::io::Cursor::new(bundle)).unwrap();
    let mut text = String::new();
    zip.by_name("application-log.json")
        .unwrap()
        .read_to_string(&mut text)
        .unwrap();
    assert!(text.contains("0x80070057"));
    assert!(!text.contains("super-secret-token"));
}

#[test]
fn interrupted_requests_are_distinguishable_and_disk_errors_do_not_abort_launch() {
    let dir = tempfile::tempdir().unwrap();
    {
        let mut log = RequestLog::begin(dir.path(), &json!({"op":"launchApplication"}));
        log.stage(BrokerStage::Read);
    }
    let events = application_log::read(dir.path()).unwrap();
    assert_eq!(events[1]["outcome"], "interrupted");
    assert_eq!(events[1]["brokerStage"], "read");
    let blocked = dir.path().join("not-a-directory");
    fs::write(&blocked, "fixture").unwrap();
    let mut log = RequestLog::begin(&blocked, &json!({"op":"launchApplication"}));
    log.finish(&Ok(json!({"launched":true})));
}

#[test]
fn rotation_and_partial_records_keep_recent_logs_bounded_and_export_safe() {
    let dir = tempfile::tempdir().unwrap();
    let logs = dir.path().join("logs");
    fs::create_dir(&logs).unwrap();
    fs::write(logs.join("application.jsonl"), vec![b'x'; 1_048_576]).unwrap();
    let mut log = RequestLog::begin(dir.path(), &json!({"op":"launchApplication"}));
    log.finish(&Ok(json!({"launched":true})));
    assert_eq!(
        fs::metadata(logs.join("application.previous.jsonl"))
            .unwrap()
            .len(),
        1_048_576
    );
    assert!(fs::metadata(logs.join("application.jsonl")).unwrap().len() < 1_048_576);
    fs::OpenOptions::new()
        .append(true)
        .open(logs.join("application.jsonl"))
        .unwrap()
        .write_all(b"{partial")
        .unwrap();
    let mut events = application_log::read(dir.path()).unwrap();
    assert_eq!(events.as_array().unwrap().len(), 2);
    events[0]["message"] = json!("private-output");
    events[0]["profile"] = json!("C:/private-path");
    events[0]["native"] = json!({"message":"private-output"});
    let text = application_log::sanitize_entries(&events).to_string();
    assert!(!text.contains("private-"));
}

#[cfg(windows)]
#[tokio::test]
async fn native_failure_reaches_persistent_log_through_platform_bridge() {
    use launchflow_core::{
        automation::AutomationPaths, model::*, platform::native_platform_with_automation,
    };
    let dir = tempfile::tempdir().unwrap();
    let platform = native_platform_with_automation(AutomationPaths {
        data: dir.path().into(),
        ..Default::default()
    });
    let profile = ApplicationProfile {
        schema_version: 1,
        id: "private-test-id".into(),
        display_name: "private-name".into(),
        windows: WindowsBinding {
            executable: "C:\\missing-log-test.exe".into(),
            run_as_administrator: true,
            ..Default::default()
        },
        macos: MacosBinding::default(),
        launch_arguments: vec!["private-token".into()],
        ready_detection: None,
    };
    let error = platform.launch(&profile, &[]).await.unwrap_err();
    assert!(error.to_string().contains("检查应用路径与参数"));
    let events = application_log::read(dir.path()).unwrap();
    assert_eq!(events[1]["outcome"], "failed");
    assert_eq!(
        events[1]["native"]["exceptionType"],
        "LaunchFlow.Native.NativeFailure"
    );
    assert!(events.to_string().contains("application.validate"));
    assert!(!events.to_string().contains("private-token"));
    assert!(!events.to_string().contains("missing-log-test"));
}
