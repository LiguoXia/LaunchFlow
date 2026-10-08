use launchflow_core::{
    engine::Engine,
    model::*,
    parameters::{self, Values},
    platform::native_platform,
    registry::NodeRegistry,
    storage::Store,
    validation::graph_order,
};
use serde_json::json;
use std::{sync::Arc, time::Duration};
#[tokio::test]
async fn cancelling_middle_queue_entry_does_not_release_later_runs_early() {
    let e = engine();
    let mut s = scene(&e, vec![delay("a", 220)], vec![]);
    s.concurrent_run_policy = ConcurrentRunPolicy::Queue;
    let s = e.store.save_scene(s).unwrap();
    let a = e.start(&s.id, "manual").unwrap();
    state(&e, &a.id, NodeStatus::Waiting).await;
    let b = e.start(&s.id, "manual").unwrap();
    let c = e.start(&s.id, "manual").unwrap();
    e.cancel(&b.id).unwrap();
    let ar = wait(&e, &a.id).await;
    let cr = wait(&e, &c.id).await;
    assert_eq!(wait(&e, &b.id).await.status, RunStatus::Cancelled);
    assert!(cr.node_runs[0].started_at >= ar.node_runs[0].ended_at);
}
#[tokio::test]
async fn subflow_forwards_secret_references_without_persisting_resolved_values() {
    let e = engine();
    let key = format!("LAUNCHFLOW_CHILD_SECRET_{}", std::process::id());
    let secret = "unmarked-child-sensitive-value";
    std::env::set_var(&key, secret);
    let parameter = Parameter {
        name: "credential".into(),
        kind: "secretReference".into(),
        description: "".into(),
        required: true,
        default_value: json!(format!("env:{key}")),
        options: vec![],
        validation: Default::default(),
    };
    let mut child = scene(
        &e,
        vec![cmd("echo", json!(["echo", "${credential}"]))],
        vec![],
    );
    child.parameters = vec![parameter.clone()];
    let child = e.store.save_scene(child).unwrap();
    let mut parent = scene(
        &e,
        vec![Node::new(
            "flow.subflow",
            "child",
            json!({"sceneId":child.id,"parameters":{"credential":"${credential}"}}),
        )],
        vec![],
    );
    parent.parameters = vec![parameter];
    let parent = e.store.save_scene(parent).unwrap();
    let r = wait(&e, &e.start(&parent.id, "manual").unwrap().id).await;
    std::env::remove_var(&key);
    assert_eq!(r.status, RunStatus::Succeeded, "{:?}", r.error);
    let runs = e.store.runs().unwrap();
    assert_eq!(runs.len(), 2);
    assert!(!serde_json::to_string(&runs).unwrap().contains(secret));
    assert!(runs
        .iter()
        .all(|r| r.parameter_snapshot["credential"] == json!(format!("env:{key}"))));
}
#[tokio::test]
async fn timeout_cleans_up_command_descendants() {
    let e = engine();
    let d = tempfile::tempdir().unwrap();
    let marker = d.path().join("child-pid");
    let mut n = cmd("fork", json!(["fork-sleep", marker]));
    n.timeout_ms = 350;
    let s = scene(&e, vec![n], vec![]);
    let r = wait(&e, &e.start(&s.id, "manual").unwrap().id).await;
    assert_eq!(r.status, RunStatus::Failed);
    let pid = std::fs::read_to_string(marker)
        .expect("descendant started")
        .parse()
        .unwrap();
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert!(sysinfo::System::new_all()
        .process(sysinfo::Pid::from_u32(pid))
        .is_none());
}
#[tokio::test]
async fn numeric_parameter_is_typed_for_delay_and_stringified_for_command_arguments() {
    let e = engine();
    let mut s = scene(
        &e,
        vec![
            Node {
                id: "a".into(),
                ..Node::new("system.delay", "Delay", json!({"durationMs":"${ms}"}))
            },
            cmd("b", json!(["echo", "${ms}"])),
        ],
        vec![edge("a", "b", "success")],
    );
    s.parameters = vec![Parameter {
        name: "ms".into(),
        kind: "number".into(),
        description: "".into(),
        required: true,
        default_value: json!(12),
        options: vec![],
        validation: Default::default(),
    }];
    let s = e.store.save_scene(s).unwrap();
    let r = wait(&e, &e.start(&s.id, "manual").unwrap().id).await;
    assert_eq!(r.status, RunStatus::Succeeded, "{:?}", r.error);
    assert_eq!(r.node_runs[1].stdout, "12");
}
#[tokio::test]
async fn parent_cannot_resume_past_child_asking_for_a_decision() {
    let e = engine();
    let mut n = cmd("fail", json!(["fail"]));
    n.failure_policy = FailurePolicy::AskUser;
    let child = scene(&e, vec![n], vec![]);
    let parent = scene(
        &e,
        vec![Node::new(
            "flow.subflow",
            "Child",
            json!({"sceneId":child.id,"parameters":{}}),
        )],
        vec![],
    );
    let r = e.start(&parent.id, "manual").unwrap();
    let child_id = tokio::time::timeout(Duration::from_secs(3), async {
        loop {
            if let Some(child) = e.store.runs().unwrap().into_iter().find(|c| {
                c.parent_run_id.as_deref() == Some(&r.id)
                    && c.node_runs.iter().any(|n| n.status == NodeStatus::Paused)
            }) {
                break child.id;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .unwrap();
    assert!(e.resume(&r.id).is_err());
    e.decide(&child_id, "fail", "skip").unwrap();
    assert_eq!(wait(&e, &r.id).await.status, RunStatus::Succeeded);
}
fn engine() -> Arc<Engine> {
    Engine::new(
        Arc::new(Store::memory().unwrap()),
        Arc::new(NodeRegistry::builtins()),
        native_platform(),
    )
}
fn delay(id: &str, ms: u64) -> Node {
    let mut n = Node::new("system.delay", id, json!({"durationMs":ms}));
    n.id = id.into();
    n
}
fn cmd(id: &str, args: serde_json::Value) -> Node {
    let mut n = Node::new(
        "system.command",
        id,
        json!({"program":env!("CARGO_BIN_EXE_launchflow-fixture"),"arguments":args,"cwd":"","captureOutput":true}),
    );
    n.id = id.into();
    n
}
fn edge(from: &str, to: &str, outlet: &str) -> Edge {
    Edge {
        id: id(),
        from: from.into(),
        to: to.into(),
        outlet: outlet.into(),
    }
}
fn scene(e: &Engine, nodes: Vec<Node>, edges: Vec<Edge>) -> Scene {
    let mut s = Scene::new("DAG test");
    s.workflow.nodes = nodes;
    s.workflow.edges = edges;
    e.store.save_scene(s).unwrap()
}
async fn wait(e: &Engine, id: &str) -> Run {
    tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            let r = e.store.run(id).unwrap();
            if !r.status.is_active() {
                return r;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .expect("run should finish")
}
async fn state(e: &Engine, id: &str, status: NodeStatus) {
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            if e.store
                .run(id)
                .unwrap()
                .node_runs
                .iter()
                .any(|n| n.status == status)
            {
                break;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .unwrap();
}
fn condition(value: &str) -> Node {
    let mut n = Node::new("flow.condition", "OS", json!({"kind":"os","value":value}));
    n.id = "if".into();
    n
}
#[tokio::test]
async fn parallel_real_commands_and_join_follow_edges_not_array_order() {
    let e = engine();
    let join = Node {
        id: "join".into(),
        ..Node::new("flow.join", "join", json!({}))
    };
    let s = scene(
        &e,
        vec![
            join,
            cmd("c", json!(["sleep", "250"])),
            delay("root", 1),
            cmd("b", json!(["sleep", "250"])),
        ],
        vec![
            edge("root", "b", "success"),
            edge("root", "c", "success"),
            edge("b", "join", "success"),
            edge("c", "join", "success"),
        ],
    );
    let r = wait(&e, &e.start(&s.id, "manual").unwrap().id).await;
    assert_eq!(r.status, RunStatus::Succeeded);
    let b = &r.node_runs[3];
    let c = &r.node_runs[1];
    let j = &r.node_runs[0];
    assert!(
        b.started_at < c.ended_at && c.started_at < b.ended_at,
        "commands must overlap"
    );
    assert!(
        j.started_at >= b.ended_at && j.started_at >= c.ended_at,
        "join must wait for both"
    );
}
#[test]
fn detects_cycles_missing_nodes_duplicate_edges_and_invalid_outlets() {
    let e = engine();
    let mut s = scene(
        &e,
        vec![delay("a", 0), delay("b", 0)],
        vec![edge("a", "b", "success")],
    );
    assert_eq!(graph_order(&s.workflow).unwrap(), vec!["a", "b"]);
    s.workflow.edges.push(edge("b", "a", "success"));
    assert!(e
        .start(&e.store.save_scene(s.clone()).unwrap().id, "manual")
        .is_err());
    s.workflow.edges.pop();
    s.workflow.edges[0].outlet = "unknown".into();
    assert!(!e.validate(&s, true).unwrap().is_empty());
    s.workflow.edges[0].to = "missing".into();
    assert!(graph_order(&s.workflow).is_err());
}
#[tokio::test]
async fn true_false_branches_skip_inactive_os_nodes_and_join() {
    for selected in ["windows", "macos"] {
        let e = engine();
        let mut foreign = delay("false", 0);
        foreign.platform_constraint = vec!["macos".into()];
        let s = scene(
            &e,
            vec![
                condition(selected),
                delay("true", 0),
                foreign,
                Node {
                    id: "join".into(),
                    ..Node::new("flow.join", "Join", json!({}))
                },
            ],
            vec![
                edge("if", "true", "true"),
                edge("if", "false", "false"),
                edge("true", "join", "success"),
                edge("false", "join", "success"),
            ],
        );
        // Ensure the selected branch supports this host; the inactive branch may be foreign.
        let mut s = s;
        let false_active = native_platform().os() != selected;
        if false_active {
            s.workflow.nodes[2].platform_constraint.clear();
        } else {
            s.workflow.nodes[1].platform_constraint.clear();
        }
        let s = e.store.save_scene(s).unwrap();
        let r = wait(&e, &e.start(&s.id, "manual").unwrap().id).await;
        assert_eq!(r.status, RunStatus::Succeeded, "{:?}", r.error);
        assert_eq!(
            r.node_runs[if false_active { 1 } else { 2 }].status,
            NodeStatus::Skipped
        );
        assert_eq!(r.node_runs[3].status, NodeStatus::Succeeded);
    }
}
#[tokio::test]
async fn retries_emit_events_then_succeed() {
    let e = engine();
    let d = tempfile::tempdir().unwrap();
    let mut n = cmd("retry", json!(["fail-once", d.path().join("marker")]));
    n.retry_policy = RetryPolicy {
        max_retries: 2,
        delay_ms: 30,
    };
    let s = scene(&e, vec![n], vec![]);
    let mut events = e.subscribe();
    let r = wait(&e, &e.start(&s.id, "manual").unwrap().id).await;
    assert_eq!(r.status, RunStatus::Succeeded);
    assert_eq!(r.node_runs[0].retry_count, 1);
    let mut kinds = vec![];
    while let Ok(ev) = events.try_recv() {
        kinds.push(ev.kind);
    }
    assert!(kinds.contains(&"NodeFailed".into()) && kinds.contains(&"NodeRetrying".into()));
    assert_eq!(kinds.iter().filter(|k| *k == "NodeStarted").count(), 2);
}
#[tokio::test]
async fn failure_policies_stop_skip_and_route() {
    for policy in [
        FailurePolicy::StopWorkflow,
        FailurePolicy::SkipAndContinue,
        FailurePolicy::FailureBranch,
    ] {
        let e = engine();
        let mut a = cmd("a", json!(["fail"]));
        a.failure_policy = policy.clone();
        let mut edges = vec![edge("a", "b", "success")];
        if policy == FailurePolicy::FailureBranch {
            edges.push(edge("a", "failure", "failure"));
        }
        let mut nodes = vec![a, delay("b", 0)];
        if policy == FailurePolicy::FailureBranch {
            nodes.push(delay("failure", 0));
        }
        let s = scene(&e, nodes, edges);
        let r = wait(&e, &e.start(&s.id, "manual").unwrap().id).await;
        match policy {
            FailurePolicy::StopWorkflow => {
                assert_eq!(r.status, RunStatus::Failed);
                assert_eq!(r.node_runs[1].status, NodeStatus::Cancelled);
            }
            FailurePolicy::SkipAndContinue => {
                assert_eq!(r.status, RunStatus::Succeeded);
                assert_eq!(r.node_runs[1].status, NodeStatus::Succeeded);
            }
            _ => {
                assert_eq!(r.status, RunStatus::Succeeded);
                assert_eq!(r.node_runs[1].status, NodeStatus::Skipped);
                assert_eq!(r.node_runs[2].status, NodeStatus::Succeeded);
            }
        }
    }
}
#[tokio::test]
async fn ask_user_pauses_and_skip_resumes() {
    let e = engine();
    let mut n = cmd("a", json!(["fail"]));
    n.failure_policy = FailurePolicy::AskUser;
    let s = scene(&e, vec![n, delay("b", 0)], vec![edge("a", "b", "success")]);
    let r = e.start(&s.id, "manual").unwrap();
    state(&e, &r.id, NodeStatus::Paused).await;
    assert_eq!(e.store.run(&r.id).unwrap().status, RunStatus::Paused);
    assert!(e.resume(&r.id).is_err());
    e.decide(&r.id, "a", "skip").unwrap();
    assert_eq!(wait(&e, &r.id).await.status, RunStatus::Succeeded);
}
#[tokio::test]
async fn pause_allows_current_task_to_finish_but_not_downstream() {
    let e = engine();
    let s = scene(
        &e,
        vec![delay("a", 140), delay("b", 0)],
        vec![edge("a", "b", "success")],
    );
    let r = e.start(&s.id, "manual").unwrap();
    state(&e, &r.id, NodeStatus::Waiting).await;
    e.pause(&r.id).unwrap();
    tokio::time::sleep(Duration::from_millis(220)).await;
    let paused = e.store.run(&r.id).unwrap();
    assert_eq!(paused.status, RunStatus::Paused);
    assert_eq!(paused.node_runs[0].status, NodeStatus::Succeeded);
    assert_eq!(paused.node_runs[1].status, NodeStatus::Pending);
    e.resume(&r.id).unwrap();
    assert_eq!(wait(&e, &r.id).await.status, RunStatus::Succeeded);
}
#[tokio::test]
async fn timeout_kills_command_and_cancel_stops_parallel_waits() {
    let e = engine();
    let d = tempfile::tempdir().unwrap();
    let marker = d.path().join("pid");
    let mut n = cmd("slow", json!(["sleep", "10000", marker]));
    n.timeout_ms = 100;
    let s = scene(&e, vec![n], vec![]);
    let r = wait(&e, &e.start(&s.id, "manual").unwrap().id).await;
    assert_eq!(r.status, RunStatus::Failed);
    assert!(r.error.unwrap().contains("timed out"));
    if let Ok(pid) = std::fs::read_to_string(marker) {
        tokio::time::sleep(Duration::from_millis(50)).await;
        let sys = sysinfo::System::new_all();
        assert!(sys
            .process(sysinfo::Pid::from_u32(pid.parse().unwrap()))
            .is_none());
    }
    let s = scene(&e, vec![delay("a", 5000), delay("b", 5000)], vec![]);
    let r = e.start(&s.id, "manual").unwrap();
    state(&e, &r.id, NodeStatus::Waiting).await;
    e.cancel(&r.id).unwrap();
    let r = wait(&e, &r.id).await;
    assert_eq!(r.status, RunStatus::Cancelled);
    assert!(r
        .node_runs
        .iter()
        .all(|n| n.status == NodeStatus::Cancelled));
}
#[tokio::test]
async fn parameters_are_typed_runtime_resolved_and_snapshotted() {
    let e = engine();
    let mut s = scene(
        &e,
        vec![
            cmd("a", json!(["echo", "${project}", "${run.id}"])),
            cmd("b", json!(["echo", "${node.a.output.stdout}"])),
        ],
        vec![edge("a", "b", "success")],
    );
    s.parameters = vec![Parameter {
        name: "project".into(),
        kind: "string".into(),
        description: "".into(),
        required: true,
        default_value: serde_json::Value::Null,
        options: vec![],
        validation: Default::default(),
    }];
    let s = e.store.save_scene(s).unwrap();
    assert!(e
        .start(&s.id, "manual")
        .unwrap_err()
        .to_string()
        .contains("Missing required"));
    let r = e
        .start_with_parameters(
            &s.id,
            "manual",
            Values::from([("project".into(), json!("literal & $(no-eval)"))]),
        )
        .unwrap();
    let mut changed = s;
    changed.workflow.nodes.clear();
    changed.workflow.edges.clear();
    e.store.save_scene(changed).unwrap();
    let r = wait(&e, &r.id).await;
    assert_eq!(r.status, RunStatus::Succeeded);
    assert_eq!(r.scene_snapshot.workflow.nodes.len(), 2);
    assert!(r.node_runs[1].stdout.contains("literal & $(no-eval)"));
    assert!(r.node_runs[0].stdout.contains(&r.id));
}
#[test]
fn parameter_validation_rejects_unknown_expression_and_bad_types() {
    let p = Parameter {
        name: "port".into(),
        kind: "number".into(),
        description: "".into(),
        required: true,
        default_value: json!(80),
        options: vec![],
        validation: ParameterValidation {
            min: Some(1.0),
            max: Some(65535.0),
            pattern: None,
        },
    };
    assert!(parameters::bind(
        std::slice::from_ref(&p),
        &Values::from([("port".into(), json!("abc"))])
    )
    .is_err());
    assert!(parameters::bind(&[p], &Values::from([("port".into(), json!(70000))])).is_err());
    assert!(parameters::references("${alert(1)}").is_err());
}
#[tokio::test]
async fn subflow_parameters_results_snapshots_and_cancellation() {
    let e = engine();
    let mut child = scene(&e, vec![delay("inside", 100)], vec![]);
    child.parameters = vec![Parameter {
        name: "ms".into(),
        kind: "number".into(),
        description: "".into(),
        required: true,
        default_value: serde_json::Value::Null,
        options: vec![],
        validation: Default::default(),
    }];
    child.workflow.nodes[0].config = json!({"durationMs":"${ms}"});
    let child = e.store.save_scene(child).unwrap();
    let sub = Node::new(
        "flow.subflow",
        "child",
        json!({"sceneId":child.id,"parameters":{"ms":150}}),
    );
    let parent = scene(&e, vec![sub], vec![]);
    let r = e.start(&parent.id, "manual").unwrap();
    let mut changed = child;
    changed.workflow.nodes[0].config = json!({"durationMs":10000});
    e.store.save_scene(changed).unwrap();
    let r = wait(&e, &r.id).await;
    assert_eq!(r.status, RunStatus::Succeeded, "{:?}", r.error);
    assert!(r.node_runs[0].output["runId"].is_string());
    let mut parent = parent;
    parent.workflow.nodes[0].config["parameters"]["ms"] = json!(10000);
    let parent = e.store.save_scene(parent).unwrap();
    let r = e.start(&parent.id, "manual").unwrap();
    state(&e, &r.id, NodeStatus::Waiting).await;
    e.cancel(&r.id).unwrap();
    assert_eq!(wait(&e, &r.id).await.status, RunStatus::Cancelled);
    assert!(e
        .store
        .runs()
        .unwrap()
        .iter()
        .filter(|c| c.parent_run_id.as_deref() == Some(&r.id))
        .all(|c| c.status == RunStatus::Cancelled));
}
#[test]
fn rejects_missing_and_recursive_subflows_before_start() {
    let e = engine();
    let mut a = scene(&e, vec![delay("a", 0)], vec![]);
    let b = scene(
        &e,
        vec![Node::new(
            "flow.subflow",
            "A",
            json!({"sceneId":a.id,"parameters":{}}),
        )],
        vec![],
    );
    a.workflow.nodes = vec![Node::new(
        "flow.subflow",
        "B",
        json!({"sceneId":b.id,"parameters":{}}),
    )];
    let a = e.store.save_scene(a).unwrap();
    assert!(e
        .start(&a.id, "manual")
        .unwrap_err()
        .to_string()
        .contains("Circular subflow"));
    let mut a = a;
    a.workflow.nodes[0].config["sceneId"] = json!("missing");
    let a = e.store.save_scene(a).unwrap();
    assert!(e
        .start(&a.id, "manual")
        .unwrap_err()
        .to_string()
        .contains("Missing subflow"));
}
#[tokio::test]
async fn ignore_queue_restart_obey_policy() {
    for policy in [
        ConcurrentRunPolicy::Ignore,
        ConcurrentRunPolicy::Queue,
        ConcurrentRunPolicy::Restart,
    ] {
        let e = engine();
        let mut s = scene(&e, vec![delay("a", 180)], vec![]);
        s.concurrent_run_policy = policy.clone();
        let s = e.store.save_scene(s).unwrap();
        let a = e.start(&s.id, "manual").unwrap();
        state(&e, &a.id, NodeStatus::Waiting).await;
        let b = e.start(&s.id, "hotkey").unwrap();
        match policy {
            ConcurrentRunPolicy::Ignore => assert_eq!(a.id, b.id),
            ConcurrentRunPolicy::Queue => {
                assert_ne!(a.id, b.id);
                assert_eq!(b.status, RunStatus::Queued);
                let ar = wait(&e, &a.id).await;
                let br = wait(&e, &b.id).await;
                assert_eq!(br.status, RunStatus::Succeeded);
                assert!(br.node_runs[0].started_at >= ar.node_runs[0].ended_at);
            }
            ConcurrentRunPolicy::Restart => {
                assert_eq!(wait(&e, &a.id).await.status, RunStatus::Cancelled);
                assert_eq!(wait(&e, &b.id).await.status, RunStatus::Succeeded);
            }
        }
    }
}
#[tokio::test]
async fn continue_reuses_successful_side_effects_and_supports_skip_restart() {
    let e = engine();
    let d = tempfile::tempdir().unwrap();
    let marker = d.path().join("effects");
    let s = scene(
        &e,
        vec![
            cmd("a", json!(["append", marker])),
            cmd("b", json!(["fail-once", d.path().join("failed")])),
            delay("c", 0),
        ],
        vec![edge("a", "b", "success"), edge("b", "c", "success")],
    );
    let first = wait(&e, &e.start(&s.id, "manual").unwrap().id).await;
    assert_eq!(first.status, RunStatus::Failed);
    assert!(e.recover(&first.id, "safeResume", None).is_err());
    assert!(e.recover(&first.id, "continue", None).is_err());
    let r = wait(
        &e,
        &e.recover_authorized(&first.id, "continue", None, true)
            .unwrap()
            .id,
    )
    .await;
    assert_eq!(r.status, RunStatus::Succeeded);
    assert_eq!(
        r.node_runs[0].reused_from.as_deref(),
        Some(first.id.as_str())
    );
    assert_eq!(std::fs::read_to_string(&marker).unwrap().lines().count(), 1);
    let skip = wait(
        &e,
        &e.recover_authorized(&first.id, "skip", Some("b"), true)
            .unwrap()
            .id,
    )
    .await;
    assert_eq!(skip.node_runs[1].status, NodeStatus::Skipped);
    let restart = wait(
        &e,
        &e.recover_authorized(&first.id, "restart", None, true)
            .unwrap()
            .id,
    )
    .await;
    assert_eq!(restart.status, RunStatus::Succeeded);
    assert_eq!(std::fs::read_to_string(marker).unwrap().lines().count(), 2);
}
#[tokio::test]
async fn subflow_recovery_does_not_repeat_successful_side_effects() {
    let e = engine();
    let d = tempfile::tempdir().unwrap();
    let marker = d.path().join("effects");
    let child = scene(
        &e,
        vec![
            cmd("a", json!(["append", marker])),
            cmd("b", json!(["fail-once", d.path().join("failed")])),
        ],
        vec![edge("a", "b", "success")],
    );
    let parent = scene(
        &e,
        vec![Node::new(
            "flow.subflow",
            "child",
            json!({"sceneId":child.id,"parameters":{}}),
        )],
        vec![],
    );
    let r = wait(&e, &e.start(&parent.id, "manual").unwrap().id).await;
    assert_eq!(r.status, RunStatus::Failed);
    assert!(e.recover(&r.id, "retryFailed", None).is_err());
    let recovered = wait(
        &e,
        &e.recover_authorized(&r.id, "retryFailed", None, true)
            .unwrap()
            .id,
    )
    .await;
    assert_eq!(
        recovered.status,
        RunStatus::Succeeded,
        "{:?}",
        recovered.error
    );
    assert_eq!(std::fs::read_to_string(marker).unwrap().lines().count(), 1);
}
#[tokio::test]
async fn secret_reference_value_never_enters_history() {
    let e = engine();
    let key = format!("LAUNCHFLOW_TEST_SECRET_{}", std::process::id());
    std::env::set_var(&key, "fixture-sensitive-value-123");
    let mut s = scene(&e, vec![cmd("a", json!(["echo", "${password}"]))], vec![]);
    s.parameters = vec![Parameter {
        name: "password".into(),
        kind: "secretReference".into(),
        description: "".into(),
        required: true,
        default_value: json!(format!("env:{key}")),
        options: vec![],
        validation: Default::default(),
    }];
    let s = e.store.save_scene(s).unwrap();
    let r = wait(&e, &e.start(&s.id, "manual").unwrap().id).await;
    std::env::remove_var(&key);
    assert_eq!(r.status, RunStatus::Succeeded);
    let stored = serde_json::to_string(&r).unwrap();
    assert!(!stored.contains("fixture-sensitive-value-123"));
    assert!(stored.contains("env:"));
}
