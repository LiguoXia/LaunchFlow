use async_trait::async_trait;
use launchflow_core::{
    engine::Engine,
    model::*,
    platform::PlatformAdapter,
    registry::{NodeContext, NodeDefinition, NodeOutput, NodeRegistry, NodeRunner},
    storage::Store,
    Error, Result,
};
use serde_json::{json, Value};
use std::{
    sync::{
        atomic::{AtomicBool, AtomicUsize, Ordering},
        Arc,
    },
    time::Duration,
};

#[derive(Default)]
struct Desktop {
    unlocked: AtomicBool,
    launches: AtomicUsize,
    attempts: AtomicUsize,
}
#[async_trait]
impl PlatformAdapter for Desktop {
    fn os(&self) -> &'static str {
        "windows"
    }
    fn desktop_ready(&self) -> bool {
        self.unlocked.load(Ordering::SeqCst)
    }
    async fn launch(&self, p: &ApplicationProfile, _: &[String]) -> Result<()> {
        self.attempts.fetch_add(1, Ordering::SeqCst);
        if p.windows.run_as_administrator && !self.desktop_ready() {
            return Err(Error::DesktopUnavailable);
        }
        self.launches.fetch_add(1, Ordering::SeqCst);
        Ok(())
    }
    async fn open_target(&self, _: &str) -> Result<()> {
        Ok(())
    }
}
struct Gui(Arc<AtomicUsize>);
#[async_trait]
impl NodeRunner for Gui {
    fn definition(&self) -> NodeDefinition {
        NodeDefinition {
            node_type: "gui.fixture".into(),
            name: "GUI fixture".into(),
            description: "".into(),
            category: "test".into(),
            fields: vec![],
            defaults: json!({}),
            waiting: false,
        }
    }
    fn validate(&self, _: &Value) -> Result<()> {
        Ok(())
    }
    async fn run(&self, _: &Value, _: &NodeContext) -> Result<NodeOutput> {
        self.0.fetch_add(1, Ordering::SeqCst);
        Ok(NodeOutput::default())
    }
}
fn setup(elevated: bool) -> (Arc<Engine>, Arc<Desktop>, Arc<AtomicUsize>, Node) {
    let desktop = Arc::new(Desktop::default());
    let calls = Arc::new(AtomicUsize::new(0));
    let mut registry = NodeRegistry::builtins();
    registry.register(Arc::new(Gui(calls.clone()))).unwrap();
    let engine = Engine::new(
        Arc::new(Store::memory().unwrap()),
        Arc::new(registry),
        desktop.clone(),
    );
    let profile = ApplicationProfile {
        schema_version: 1,
        id: "fixture".into(),
        display_name: "fixture".into(),
        windows: WindowsBinding {
            run_as_administrator: elevated,
            ..Default::default()
        },
        macos: Default::default(),
        launch_arguments: vec![],
        ready_detection: None,
    };
    engine.store.save_profile(&profile).unwrap();
    let mut launch = Node::new(
        "application.launch",
        "Start",
        json!({"applicationId":"fixture","arguments":[],"alreadyRunning":"newInstance"}),
    );
    launch.timeout_ms = 50;
    (engine, desktop, calls, launch)
}
fn start(engine: &Arc<Engine>, nodes: Vec<Node>, edges: Vec<Edge>) -> Run {
    let mut scene = Scene::new("Locked startup");
    scene.workflow.nodes = nodes;
    scene.workflow.edges = edges;
    scene.sensitive_action_policy =
        launchflow_core::policy::SensitiveActionPolicy::AllowForThisScene;
    let scene = engine.store.save_scene(scene).unwrap();
    engine.start(&scene.id, "startup").unwrap()
}
async fn until(engine: &Engine, id: &str, test: impl Fn(&Run) -> bool) -> Run {
    tokio::time::timeout(Duration::from_secs(4), async {
        loop {
            let run = engine.store.run(id).unwrap();
            if test(&run) {
                return run;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap()
}

#[tokio::test]
async fn apps_launch_before_unlock_while_gui_waits_without_consuming_timeout_or_parallel_slot() {
    let (engine, desktop, calls, launch) = setup(false);
    let mut gui = Node::new("gui.fixture", "Click", json!({}));
    gui.timeout_ms = 50;
    let edge = Edge {
        id: id(),
        from: launch.id.clone(),
        to: gui.id.clone(),
        outlet: success_outlet(),
    };
    let run = start(
        &engine,
        vec![
            launch,
            gui,
            Node::new("system.delay", "Independent", json!({"durationMs":1})),
        ],
        vec![edge],
    );
    until(&engine, &run.id, |r| {
        r.node_runs[1].status == NodeStatus::Waiting
            && r.node_runs[2].status == NodeStatus::Succeeded
    })
    .await;
    tokio::time::sleep(Duration::from_millis(120)).await;
    assert_eq!(desktop.launches.load(Ordering::SeqCst), 1);
    assert_eq!(calls.load(Ordering::SeqCst), 0);
    assert_eq!(
        engine.store.run(&run.id).unwrap().status,
        RunStatus::Running
    );
    desktop.unlocked.store(true, Ordering::SeqCst);
    let done = until(&engine, &run.id, |r| !r.status.is_active()).await;
    assert_eq!(done.status, RunStatus::Succeeded);
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    assert_eq!(done.node_runs[1].retry_count, 0);
}

#[tokio::test]
async fn waiting_for_unlock_can_be_cancelled_without_running_the_action() {
    let (engine, _, calls, _) = setup(false);
    let run = start(
        &engine,
        vec![Node::new("gui.fixture", "Click", json!({}))],
        vec![],
    );
    until(&engine, &run.id, |r| {
        r.node_runs[0].status == NodeStatus::Waiting
    })
    .await;
    engine.cancel(&run.id).unwrap();
    assert_eq!(
        until(&engine, &run.id, |r| !r.status.is_active())
            .await
            .status,
        RunStatus::Cancelled
    );
    assert_eq!(calls.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn consent_is_deferred_without_retry_or_failure_and_respects_pause() {
    let (engine, desktop, _, launch) = setup(true);
    let run = start(&engine, vec![launch], vec![]);
    until(&engine, &run.id, |r| {
        r.node_runs[0].status == NodeStatus::Waiting
    })
    .await;
    assert_eq!(desktop.launches.load(Ordering::SeqCst), 0);
    engine.pause(&run.id).unwrap();
    until(&engine, &run.id, |r| r.status == RunStatus::Paused).await;
    desktop.unlocked.store(true, Ordering::SeqCst);
    tokio::time::sleep(Duration::from_millis(120)).await;
    assert_eq!(desktop.launches.load(Ordering::SeqCst), 0);
    engine.resume(&run.id).unwrap();
    let done = until(&engine, &run.id, |r| !r.status.is_active()).await;
    assert_eq!(done.status, RunStatus::Succeeded);
    assert_eq!(done.node_runs[0].retry_count, 0);
    assert_eq!(desktop.launches.load(Ordering::SeqCst), 1);
    assert_eq!(desktop.attempts.load(Ordering::SeqCst), 2);
}
