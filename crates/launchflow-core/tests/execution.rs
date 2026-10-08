use launchflow_core::{
    engine::Engine,
    model::*,
    platform::native_platform,
    registry::{NodeContext, NodeRegistry},
    storage::Store,
};
use serde_json::json;
use std::{sync::Arc, time::Duration};

fn engine() -> Arc<Engine> {
    Engine::new(
        Arc::new(Store::memory().unwrap()),
        Arc::new(NodeRegistry::builtins()),
        native_platform(),
    )
}
fn chain(engine: &Engine, nodes: Vec<Node>) -> Scene {
    let edges = nodes
        .windows(2)
        .map(|pair| Edge {
            id: id(),
            outlet: success_outlet(),
            from: pair[0].id.clone(),
            to: pair[1].id.clone(),
        })
        .collect();
    let mut scene = Scene::new("Integration");
    scene.workflow = Workflow {
        nodes,
        edges,
        ..Default::default()
    };
    engine.store.save_scene(scene).unwrap()
}
async fn finished(engine: &Engine, id: &str) -> Run {
    tokio::time::timeout(Duration::from_secs(15), async {
        loop {
            let run = engine.store.run(id).unwrap();
            if !run.status.is_active() {
                return run;
            }
            tokio::time::sleep(Duration::from_millis(15)).await;
        }
    })
    .await
    .expect("run completed within 15 seconds")
}
fn command(mode: &str) -> Node {
    Node::new(
        "system.command",
        mode,
        json!({"program":env!("CARGO_BIN_EXE_launchflow-fixture"),"arguments":[mode],"cwd":"","captureOutput":true}),
    )
}

#[tokio::test]
async fn command_arguments_are_literal_and_output_is_bounded_and_redacted() {
    let e = engine();
    let mut node = command("echo");
    node.config["arguments"] = json!(["echo", "literal spaces & $(not-a-shell) ; `quoted`",]);
    let scene = chain(&e, vec![node, command("sensitive")]);
    let initial = e.start(&scene.id, "manual").unwrap();
    let run = finished(&e, &initial.id).await;
    assert_eq!(run.status, RunStatus::Succeeded);
    assert!(run.node_runs[0].stdout.contains("$(not-a-shell)"));
    assert!(run.node_runs[1].stdout.contains("redacted"));
    assert!(!serde_json::to_string(&run)
        .unwrap()
        .contains("do-not-persist"));
}
#[tokio::test]
async fn command_failure_prevents_downstream_execution() {
    let e = engine();
    let scene = chain(
        &e,
        vec![
            command("fail"),
            Node::new("system.delay", "after", json!({"durationMs":1})),
        ],
    );
    let initial = e.start(&scene.id, "manual").unwrap();
    let run = finished(&e, &initial.id).await;
    assert_eq!(run.status, RunStatus::Failed);
    assert!(run.error.unwrap().contains('7'));
    assert_eq!(run.node_runs[1].status, NodeStatus::Cancelled);
    assert!(run.node_runs[1].started_at.is_none());
}
#[tokio::test]
async fn timeout_stops_wait_and_duplicate_triggers_are_ignored() {
    let e = engine();
    let mut node = Node::new("system.delay", "slow", json!({"durationMs":5_000}));
    node.timeout_ms = 80;
    let scene = chain(&e, vec![node]);
    let first = e.start(&scene.id, "manual").unwrap();
    let second = e.start(&scene.id, "manual").unwrap();
    assert_eq!(first.id, second.id);
    let run = finished(&e, &first.id).await;
    assert_eq!(run.status, RunStatus::Failed);
    assert!(run.error.unwrap().contains("timed out"));
}
#[tokio::test]
async fn cancel_interrupts_long_wait_and_persists_events() {
    let e = engine();
    let mut events = e.subscribe();
    let scene = chain(
        &e,
        vec![Node::new(
            "system.delay",
            "waiting",
            json!({"durationMs":10_000}),
        )],
    );
    let first = e.start(&scene.id, "manual").unwrap();
    tokio::time::sleep(Duration::from_millis(30)).await;
    e.cancel(&first.id).unwrap();
    let run = finished(&e, &first.id).await;
    assert_eq!(run.status, RunStatus::Cancelled);
    assert!(run.duration_ms < 1_000);
    let mut revisions = vec![];
    while let Ok(event) = events.try_recv() {
        assert!(e.store.run(&event.run.id).unwrap().revision >= event.run.revision);
        revisions.push(event.run.revision);
    }
    assert!(revisions.len() >= 3);
    assert!(revisions.windows(2).all(|w| w[0] < w[1]));
}
#[tokio::test]
async fn wait_port_uses_real_tcp_and_timeout() {
    let e = engine();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let scene = chain(
        &e,
        vec![Node::new(
            "wait.port",
            "TCP",
            json!({"host":"127.0.0.1","port":port}),
        )],
    );
    let initial = e.start(&scene.id, "manual").unwrap();
    assert_eq!(finished(&e, &initial.id).await.status, RunStatus::Succeeded);
    drop(listener);
    let mut closed = scene;
    closed.workflow.nodes[0].timeout_ms = 100;
    let closed = e.store.save_scene(closed).unwrap();
    let initial = e.start(&closed.id, "manual").unwrap();
    assert_eq!(finished(&e, &initial.id).await.status, RunStatus::Failed);
}
#[tokio::test]
async fn launch_native_application_wait_process_and_readiness() {
    let e = engine();
    let dir = tempfile::tempdir().unwrap();
    let marker = dir.path().join("started");
    let program = env!("CARGO_BIN_EXE_launchflow-fixture");
    let process_name = std::path::Path::new(program)
        .file_name()
        .unwrap()
        .to_string_lossy()
        .to_string();
    let profile = ApplicationProfile {
        schema_version: 1,
        id: "fixture".into(),
        display_name: "Fixture".into(),
        windows: WindowsBinding {
            use_preauthorized_task: false,
            run_as_administrator: false,
            executable: program.into(),
            process_name: process_name.clone(),
        },
        macos: MacosBinding {
            app_path: program.into(),
            bundle_id: String::new(),
            process_name: process_name.clone(),
        },
        launch_arguments: vec![
            "sleep".into(),
            "1800".into(),
            marker.to_string_lossy().into_owned(),
        ],
        ready_detection: Some(ReadyDetection::Process {
            process_name: process_name.clone(),
        }),
    };
    e.store.save_profile(&profile).unwrap();
    let scene = chain(
        &e,
        vec![
            Node::new(
                "application.launch",
                "launch",
                json!({"applicationId":"fixture","arguments":[],"alreadyRunning":"newInstance"}),
            ),
            Node::new(
                "wait.process",
                "process",
                json!({"processName":process_name}),
            ),
        ],
    );
    let initial = e.start(&scene.id, "manual").unwrap();
    let run = finished(&e, &initial.id).await;
    assert_eq!(run.status, RunStatus::Succeeded, "{:?}", run.error);
    tokio::time::timeout(Duration::from_secs(2), async {
        while !marker.exists() {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    assert!(marker.exists());
}
#[tokio::test]
async fn scheduling_uses_dependencies_and_skips_disabled_nodes() {
    let e = engine();
    let a = Node::new("system.delay", "first", json!({"durationMs":1}));
    let mut b = Node::new("system.delay", "disabled", json!({"durationMs":10_000}));
    b.enabled = false;
    let mut scene = chain(&e, vec![a, b]);
    scene.workflow.nodes.reverse();
    let scene = e.store.save_scene(scene).unwrap();
    let initial = e.start(&scene.id, "manual").unwrap();
    let run = finished(&e, &initial.id).await;
    assert_eq!(run.status, RunStatus::Succeeded);
    assert_eq!(run.node_runs[0].status, NodeStatus::Skipped);
    assert_eq!(run.node_runs[1].status, NodeStatus::Succeeded);
}
#[tokio::test]
async fn startup_commands_require_scene_authorization() {
    let e = engine();
    let mut node = command("echo");
    node.config["captureOutput"] = json!(false);
    let mut scene = chain(&e, vec![node]);
    assert!(e.start(&scene.id, "startup").is_err());
    scene.allow_commands_at_startup = true;
    scene.sensitive_action_policy =
        launchflow_core::policy::SensitiveActionPolicy::AllowForThisScene;
    let scene = e.store.save_scene(scene).unwrap();
    let run = e.start(&scene.id, "startup").unwrap();
    assert_eq!(finished(&e, &run.id).await.status, RunStatus::Succeeded);
}
#[tokio::test]
async fn registry_runner_can_be_called_without_desktop_or_ui() {
    let registry = NodeRegistry::builtins();
    let ctx = NodeContext {
        diagnostics: Default::default(),
        subflows: None,
        platform: native_platform(),
        profiles: vec![],
    };
    let output = registry
        .runner("system.delay")
        .unwrap()
        .run(&json!({"durationMs":0}), &ctx)
        .await
        .unwrap();
    assert_eq!(output.message, "Delay complete");
}
