use launchflow_core::{
    automation::AutomationPaths, engine::Engine, model::*,
    platform::native_platform_with_automation, registry::NodeRegistry, storage::Store,
};
use serde_json::{json, Value};
use std::{sync::Arc, time::Duration};
fn gui(kind: &str, id: &str, window: &Value, element: &str) -> Node {
    let locator = if element.is_empty() {
        json!({"kind":"window","window":window})
    } else {
        json!({"kind":"accessibility","window":window,"automationId":element})
    };
    let mut n = Node::new(&format!("gui.{kind}"), id, json!({"locators":[locator]}));
    n.id = id.into();
    n.timeout_ms = 10000;
    n
}
async fn wait(e: &Engine, id: &str) -> Run {
    tokio::time::timeout(Duration::from_secs(30), async {
        loop {
            let r = e.store.run(id).unwrap();
            if !r.status.is_active() {
                return r;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    })
    .await
    .unwrap()
}
#[tokio::test]
#[ignore = "Requires an interactive desktop and built native automation workers"]
async fn native_gui_dag_semantics_fallback_timeout_cancel_and_highlight() {
    let dir = tempfile::tempdir().unwrap();
    let paths = AutomationPaths {
        data: dir.path().join("automation"),
        ..Default::default()
    };
    let mut child = std::process::Command::new(&paths.harness)
        .spawn()
        .expect("Build native test harness first");
    struct Guard(u32);
    impl Drop for Guard {
        fn drop(&mut self) {
            if let Some(process) =
                sysinfo::System::new_all().process(sysinfo::Pid::from_u32(self.0))
            {
                process.kill();
            }
        }
    }
    let _guard = Guard(child.id());
    let window = json!({"pid":child.id(),"title":"LaunchFlow Automation Test Harness"});
    let platform = native_platform_with_automation(paths);
    let provider = platform.automation();
    let e = Engine::new(
        Arc::new(Store::memory().unwrap()),
        Arc::new(NodeRegistry::builtins()),
        platform,
    );
    let mut scene = Scene::new("Native GUI acceptance");
    let mut input = gui("inputText", "input", &window, "project-input");
    input.config["text"] = json!("Workflow acceptance");
    let mut choice = gui("selectOption", "choice", &window, "environment-choice");
    choice.config["option"] = json!("Staging");
    let mut shortcut = gui("shortcut", "shortcut", &window, "project-input");
    shortcut.config["keys"] = json!(["Ctrl", "Enter"]);
    let mut fallback = gui("click", "click", &window, "missing-primary");
    fallback.config["locators"]
        .as_array_mut()
        .unwrap()
        .push(json!({"kind":"accessibility","window":window,"automationId":"start-button"}));
    let mut result = gui("waitElement", "result", &window, "result-label");
    result.config["locators"][0]["name"] = json!("Result: Workflow acceptance / Staging");
    scene.workflow.nodes = vec![
        gui("waitWindow", "window", &window, ""),
        gui("waitElement", "wait", &window, "start-button"),
        fallback,
        input,
        choice,
        shortcut,
        result,
    ];
    scene.workflow.edges = scene
        .workflow
        .nodes
        .windows(2)
        .map(|n| Edge {
            id: id(),
            from: n[0].id.clone(),
            to: n[1].id.clone(),
            outlet: "success".into(),
        })
        .collect();
    let scene = e.store.save_scene(scene).unwrap();
    let first = wait(&e, &e.start(&scene.id, "test").unwrap().id).await;
    assert_eq!(first.status, RunStatus::Succeeded, "{:?}", first.error);
    assert_eq!(first.node_runs[2].output["automation"]["locatorUsed"], 1);
    assert_eq!(
        first.node_runs[2].output["automation"]["locatorAttempts"][0]["success"],
        false
    );
    provider
        .request(
            json!({"op":"perform","window":window,"action":{"kind":"moveWindow","x":220,"y":160}}),
        )
        .await
        .unwrap();
    provider.request(json!({"op":"perform","window":window,"action":{"kind":"resizeWindow","width":920,"height":850}})).await.unwrap();
    assert_eq!(
        wait(&e, &e.start(&scene.id, "test").unwrap().id)
            .await
            .status,
        RunStatus::Succeeded
    );
    let before=provider.request(json!({"op":"find","window":window,"locator":{"kind":"accessibility","automationId":"result-label"}})).await.unwrap();
    provider.request(json!({"op":"highlight","window":window,"locator":{"kind":"accessibility","automationId":"start-button"},"durationMs":250})).await.unwrap();
    let after=provider.request(json!({"op":"find","window":window,"locator":{"kind":"accessibility","automationId":"result-label"}})).await.unwrap();
    assert_eq!(before["name"], after["name"]);
    let mut timeout = Scene::new("GUI timeout");
    let mut n = gui("waitElement", "missing", &window, "never-present");
    n.timeout_ms = 700;
    timeout.workflow.nodes = vec![n];
    let timeout = e.store.save_scene(timeout).unwrap();
    let failed = wait(&e, &e.start(&timeout.id, "test").unwrap().id).await;
    assert_eq!(failed.status, RunStatus::Failed);
    assert_eq!(
        failed.node_runs[0].output["automation"]["error"]["code"],
        "timeout"
    );
    assert!(failed.node_runs[0].output["automation"]["screenshot"].is_string());
    let mut cancel = timeout;
    cancel.workflow.nodes[0].timeout_ms = 20000;
    let cancel = e.store.save_scene(cancel).unwrap();
    let r = e.start(&cancel.id, "test").unwrap();
    tokio::time::sleep(Duration::from_millis(200)).await;
    e.cancel(&r.id).unwrap();
    assert_eq!(wait(&e, &r.id).await.status, RunStatus::Cancelled);
    let _ = child.kill();
    let _ = child.wait();
}
