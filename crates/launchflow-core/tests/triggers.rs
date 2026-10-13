use async_trait::async_trait;
use chrono::{Local, TimeZone};
use launchflow_core::{
    engine::Engine,
    model::*,
    parameters::Values,
    platform::{native_platform, PlatformAdapter},
    registry::NodeRegistry,
    storage::Store,
    triggers::{TriggerEngine, TriggerRegistry},
};
use serde_json::json;
use std::{
    sync::{
        atomic::{AtomicU32, Ordering},
        Arc,
    },
    time::Duration,
};
struct Sensors {
    monitors: AtomicU32,
    power: AtomicU32,
    wifi: AtomicU32,
}
#[async_trait]
impl PlatformAdapter for Sensors {
    fn os(&self) -> &'static str {
        native_platform().os()
    }
    async fn launch(&self, _: &ApplicationProfile, _: &[String]) -> launchflow_core::Result<()> {
        unreachable!()
    }
    async fn open_target(&self, _: &str) -> launchflow_core::Result<()> {
        unreachable!()
    }
    async fn monitor_count(&self) -> launchflow_core::Result<u32> {
        Ok(self.monitors.load(Ordering::SeqCst))
    }
    async fn power_state(&self) -> launchflow_core::Result<String> {
        Ok(if self.power.load(Ordering::SeqCst) == 1 {
            "ac"
        } else {
            "battery"
        }
        .into())
    }
    async fn wifi_ssid(&self) -> launchflow_core::Result<Option<String>> {
        Ok(Some(
            if self.wifi.load(Ordering::SeqCst) == 1 {
                "Office"
            } else {
                "Home"
            }
            .into(),
        ))
    }
}
fn scene(e: &Engine, name: &str, kind: &str, config: serde_json::Value) -> Scene {
    let mut s = Scene::new(name);
    s.concurrent_run_policy = ConcurrentRunPolicy::Queue;
    s.workflow.nodes = vec![Node::new("system.delay", "delay", json!({"durationMs":1}))];
    s.triggers = vec![Trigger {
        id: id(),
        kind: kind.into(),
        enabled: true,
        config,
        parameters: Values::new(),
    }];
    e.store.save_scene(s).unwrap()
}
async fn settle(e: &Engine) {
    tokio::time::timeout(Duration::from_secs(3), async {
        while e.has_active() {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .unwrap();
}
#[tokio::test]
async fn once_trigger_fires_at_seconds_boundary_and_survives_database_reopen() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("once.db");
    let due = Local.with_ymd_and_hms(2026, 10, 13, 12, 30, 45).unwrap();
    let scene_id;
    {
        let e = Engine::new(
            Arc::new(Store::open(&path).unwrap()),
            Arc::new(NodeRegistry::builtins()),
            native_platform(),
        );
        let s = scene(
            &e,
            "once",
            "once",
            json!({"dateTime":"2026-10-13 12:30:45"}),
        );
        scene_id = s.id.clone();
        let t = TriggerEngine::new(e.clone());
        t.registry.validate(&s).unwrap();
        t.refresh().unwrap();
        t.poll_at(due - chrono::Duration::seconds(1)).await.unwrap();
        assert!(e.store.runs().unwrap().is_empty());
        let (a, b) = tokio::join!(t.poll_at(due), t.poll_at(due));
        a.unwrap();
        b.unwrap();
        settle(&e).await;
        let runs = e.store.runs().unwrap();
        assert_eq!(runs.len(), 1);
        assert_eq!(runs[0].source, "once");
        assert_eq!(
            runs[0].trigger_id.as_deref(),
            Some(s.triggers[0].id.as_str())
        );
        assert_eq!(
            runs[0].scene_snapshot.triggers[0].config["dateTime"],
            "2026-10-13 12:30:45"
        );
    }
    let e = Engine::new(
        Arc::new(Store::open(&path).unwrap()),
        Arc::new(NodeRegistry::builtins()),
        native_platform(),
    );
    let t = TriggerEngine::new(e.clone());
    t.refresh().unwrap();
    t.poll_at(due + chrono::Duration::days(2)).await.unwrap();
    assert_eq!(e.store.runs().unwrap().len(), 1);
    // An earlier, different appointment is a new request. Returning to an already
    // fired appointment must not repeat it, nor should moving the clock backwards.
    let mut s = e.store.scene(&scene_id).unwrap();
    s.triggers[0].config = json!({"dateTime":"2026-10-12 12:30:45"});
    s = e.store.save_scene(s.clone()).unwrap();
    t.refresh().unwrap();
    t.poll_at(due).await.unwrap();
    settle(&e).await;
    assert_eq!(e.store.runs().unwrap().len(), 2);
    s.triggers[0].config = json!({"dateTime":"2026-10-13 12:30:45"});
    e.store.save_scene(s).unwrap();
    t.refresh().unwrap();
    t.poll_at(due - chrono::Duration::hours(1)).await.unwrap();
    t.poll_at(due).await.unwrap();
    assert_eq!(e.store.runs().unwrap().len(), 2);
}

#[tokio::test]
async fn once_trigger_disabled_and_missed_deadline_catchup() {
    let e = Engine::new(
        Arc::new(Store::memory().unwrap()),
        Arc::new(NodeRegistry::builtins()),
        native_platform(),
    );
    let mut s = scene(
        &e,
        "once disabled",
        "once",
        json!({"dateTime":"2026-10-13 12:30:45"}),
    );
    s.triggers[0].enabled = false;
    s = e.store.save_scene(s.clone()).unwrap();
    let t = TriggerEngine::new(e.clone());
    t.refresh().unwrap();
    let after = Local.with_ymd_and_hms(2026, 10, 14, 12, 30, 50).unwrap();
    t.poll_at(after).await.unwrap();
    assert!(e.store.runs().unwrap().is_empty());
    s.triggers[0].enabled = true;
    e.store.save_scene(s).unwrap();
    t.refresh().unwrap();
    t.poll_at(after).await.unwrap();
    t.poll_at(after).await.unwrap();
    settle(&e).await;
    assert_eq!(e.store.runs().unwrap().len(), 1);
    let mut invalid = e.store.scenes().unwrap().remove(0);
    invalid.triggers[0].config = json!({"dateTime":"2026-02-29 12:30:45"});
    assert!(t.registry.validate(&invalid).is_err());
}

#[tokio::test]
async fn schedule_weekday_and_persistent_dedup() {
    let store = Arc::new(Store::memory().unwrap());
    let e = Engine::new(
        store.clone(),
        Arc::new(NodeRegistry::builtins()),
        native_platform(),
    );
    scene(&e, "daily", "schedule", json!({"time":"09:00"}));
    scene(
        &e,
        "weekdays",
        "weekday",
        json!({"time":"09:00","days":[1,2,3,4,5]}),
    );
    let t = TriggerEngine::new(e.clone());
    t.refresh().unwrap();
    let monday = Local.with_ymd_and_hms(2026, 10, 5, 9, 0, 0).unwrap();
    t.poll_at(monday).await.unwrap();
    t.poll_at(monday).await.unwrap();
    settle(&e).await;
    assert_eq!(store.runs().unwrap().len(), 2);
    let after_restart = TriggerEngine::new(e.clone());
    after_restart.refresh().unwrap();
    after_restart.poll_at(monday).await.unwrap();
    assert_eq!(store.runs().unwrap().len(), 2);
    after_restart
        .poll_at(Local.with_ymd_and_hms(2026, 10, 10, 9, 0, 0).unwrap())
        .await
        .unwrap();
    settle(&e).await;
    assert_eq!(store.runs().unwrap().len(), 3);
}
#[tokio::test]
async fn cron_five_and_six_fields_deduplicate_restart_and_preserve_the_trigger_snapshot() {
    let e = Engine::new(
        Arc::new(Store::memory().unwrap()),
        Arc::new(NodeRegistry::builtins()),
        native_platform(),
    );
    let minute = scene(
        &e,
        "minute",
        "cron",
        json!({"expression":"*/5 9 * * MON-FRI"}),
    );
    let seconds = scene(
        &e,
        "seconds",
        "cron",
        json!({"expression":"10,20 0 9 * * MON"}),
    );
    let t = TriggerEngine::new(e.clone());
    t.refresh().unwrap();
    let time = |s| Local.with_ymd_and_hms(2026, 10, 5, 9, 0, s).unwrap();
    t.poll_at(time(7)).await.unwrap(); // Five-field schedules still fire after second zero.
    t.poll_at(time(10)).await.unwrap();
    t.poll_at(time(10)).await.unwrap();
    settle(&e).await;
    assert_eq!(e.store.runs().unwrap().len(), 2);
    let restarted = TriggerEngine::new(e.clone());
    restarted.refresh().unwrap();
    restarted.poll_at(time(10)).await.unwrap();
    restarted.poll_at(time(20)).await.unwrap();
    restarted.poll_at(time(10)).await.unwrap(); // Clock rollback does not re-fire an old slot.
    settle(&e).await;
    let runs = e.store.runs().unwrap();
    assert_eq!(runs.len(), 3);
    for run in &runs {
        assert_eq!(run.source, "cron");
        assert_eq!(
            run.trigger_id.as_ref(),
            Some(&run.scene_snapshot.triggers[0].id)
        );
    }
    assert_eq!(runs.iter().filter(|r| r.scene_id == minute.id).count(), 1);
    let mut changed = seconds;
    changed.triggers[0].config = json!({"expression":"0 10 * * *"});
    e.store.save_scene(changed).unwrap();
    assert!(e
        .store
        .runs()
        .unwrap()
        .iter()
        .filter(|r| r.scene_id != minute.id)
        .all(|r| r.scene_snapshot.triggers[0].config["expression"] == "10,20 0 9 * * MON"));
}

#[test]
fn cron_validation_calendar_and_disabled_triggers() {
    use launchflow_core::cron_schedule::{observation, parse};
    for invalid in [
        "",
        "* * *",
        "61 * * * *",
        "*/0 * * * *",
        "0 0 0 0 0 0",
        "0 0 * * * * 2026",
    ] {
        assert!(parse(invalid).is_err(), "{invalid}");
    }
    let monday = Local.with_ymd_and_hms(2026, 10, 5, 9, 5, 13).unwrap();
    assert!(observation("*/5 9 * OCT MON-FRI", monday).unwrap().1);
    assert!(!observation("0 8 * * *", monday).unwrap().1);
    assert!(
        observation("5 9 1 * MON", monday).unwrap().1,
        "DOM and DOW follow POSIX OR semantics"
    );
    let leap = Local.with_ymd_and_hms(2028, 2, 29, 12, 0, 1).unwrap();
    assert!(observation("0 12 29 FEB *", leap).unwrap().1);
    let mut s = Scene::new("invalid cron");
    s.triggers = vec![Trigger {
        id: id(),
        kind: "cron".into(),
        enabled: false,
        config: json!({"expression":"invalid"}),
        parameters: Values::new(),
    }];
    assert!(TriggerRegistry::default().validate(&s).is_err());
}

#[tokio::test]
async fn cron_disabled_no_catchup_and_sensitive_confirmation_are_preserved() {
    let e = Engine::new(
        Arc::new(Store::memory().unwrap()),
        Arc::new(NodeRegistry::builtins()),
        native_platform(),
    );
    let mut s = scene(&e, "disabled", "cron", json!({"expression":"0 9 * * *"}));
    s.triggers[0].enabled = false;
    e.store.save_scene(s).unwrap();
    scene(&e, "missed", "cron", json!({"expression":"0 8 * * *"}));
    let mut sensitive = scene(&e, "sensitive", "cron", json!({"expression":"* * * * *"}));
    sensitive.workflow.nodes = vec![Node::new(
        "system.command",
        "never executed",
        json!({"program":"cmd.exe","arguments":["/c","exit","0"],"workingDirectory":"","captureOutput":true}),
    )];
    sensitive.sensitive_action_policy =
        launchflow_core::policy::SensitiveActionPolicy::AskEveryTime;
    let sensitive = e.store.save_scene(sensitive).unwrap();
    let t = TriggerEngine::new(e.clone());
    t.refresh().unwrap();
    t.poll_at(Local.with_ymd_and_hms(2026, 10, 5, 9, 0, 0).unwrap())
        .await
        .unwrap();
    assert!(e.store.runs().unwrap().is_empty());
    assert!(t
        .statuses()
        .iter()
        .any(|event| event.scene_id == sensitive.id && event.kind == "error"));
}
#[tokio::test]
async fn lifecycle_hotkey_and_default_login_use_registry() {
    let e = Engine::new(
        Arc::new(Store::memory().unwrap()),
        Arc::new(NodeRegistry::builtins()),
        native_platform(),
    );
    let a = scene(&e, "default", "systemLogin", json!({}));
    let b = scene(&e, "nondefault", "systemLogin", json!({}));
    scene(&e, "started", "appStarted", json!({}));
    let hot = scene(
        &e,
        "hotkey",
        "globalHotkey",
        json!({"shortcut":"Ctrl+Alt+J"}),
    );
    e.store.set_default(Some(&a.id)).unwrap();
    let t = TriggerEngine::new(e.clone());
    t.refresh().unwrap();
    t.lifecycle("systemLogin").unwrap();
    t.lifecycle("appStarted").unwrap();
    t.fire(&hot.id, &hot.triggers[0].id).unwrap();
    settle(&e).await;
    let runs = e.store.runs().unwrap();
    assert_eq!(runs.len(), 3);
    assert!(!runs.iter().any(|r| r.scene_id == b.id));
    assert!(t.fire(&b.id, &b.triggers[0].id).is_err());
    assert_eq!(t.registry.definitions().len(), 12);
}
#[tokio::test]
async fn startup_policy_rejection_is_visible_and_authorized_scene_passes_preflight() {
    let e = Engine::new(
        Arc::new(Store::memory().unwrap()),
        Arc::new(NodeRegistry::builtins()),
        native_platform(),
    );
    let mut s = Scene::new("startup policy fixture");
    s.workflow.nodes.push(Node::new("gui.click", "fixture click", json!({"locators":[{"kind":"accessibility","window":{"title":"isolated nonexistent fixture"},"role":"Button","automationId":"go"}]})));
    let s = e.store.save_scene(s).unwrap();
    e.store.set_default(Some(&s.id)).unwrap();
    let triggers = TriggerEngine::new(e.clone());
    assert!(triggers
        .startup()
        .unwrap_err()
        .to_string()
        .contains("startupPolicyBlocked"));
    let history = e.store.runs().unwrap();
    assert_eq!(history.len(), 1);
    assert_eq!(history[0].status, RunStatus::Failed);
    assert_eq!(history[0].source, "startup");
    assert!(history[0]
        .node_runs
        .iter()
        .all(|n| n.status == NodeStatus::Skipped));
    assert!(!e.has_active());
    let mut authorized = e.store.scene(&s.id).unwrap();
    authorized.sensitive_action_policy =
        launchflow_core::policy::SensitiveActionPolicy::AllowForThisScene;
    let authorized = e.store.save_scene(authorized).unwrap();
    assert!(e.check_startup(&authorized, &Values::new()).is_ok());
    assert_eq!(
        e.store.runs().unwrap().len(),
        1,
        "Preflight must not execute input"
    );
}
#[tokio::test]
async fn startup_disabled_trigger_is_reported_and_duplicate_login_definitions_run_once() {
    let e = Engine::new(
        Arc::new(Store::memory().unwrap()),
        Arc::new(NodeRegistry::builtins()),
        native_platform(),
    );
    let mut s = scene(&e, "startup", "systemLogin", json!({}));
    s.triggers[0].enabled = false;
    let mut s = e.store.save_scene(s).unwrap();
    e.store.set_default(Some(&s.id)).unwrap();
    let triggers = TriggerEngine::new(e.clone());
    assert!(triggers
        .startup()
        .unwrap_err()
        .to_string()
        .contains("startupTriggerDisabled"));
    assert_eq!(e.store.runs().unwrap().len(), 1);
    s.triggers[0].enabled = true;
    let mut second = s.triggers[0].clone();
    second.id = id();
    s.triggers.push(second);
    e.store.save_scene(s).unwrap();
    triggers.startup().unwrap().unwrap();
    settle(&e).await;
    assert_eq!(
        e.store
            .runs()
            .unwrap()
            .iter()
            .filter(|r| r.status == RunStatus::Succeeded)
            .count(),
        1
    );
}
#[tokio::test]
async fn sensor_transitions_are_edge_triggered_and_do_not_fire_initially() {
    let sensors = Arc::new(Sensors {
        monitors: AtomicU32::new(1),
        power: AtomicU32::new(0),
        wifi: AtomicU32::new(0),
    });
    let e = Engine::new(
        Arc::new(Store::memory().unwrap()),
        Arc::new(NodeRegistry::builtins()),
        sensors.clone(),
    );
    scene(&e, "monitor", "monitorChanged", json!({}));
    scene(&e, "power", "powerState", json!({"state":"ac"}));
    scene(&e, "wifi", "wifiSsid", json!({"ssid":"Office"}));
    let t = TriggerEngine::new(e.clone());
    t.refresh().unwrap();
    t.poll_at(Local::now()).await.unwrap();
    assert!(e.store.runs().unwrap().is_empty());
    sensors.monitors.store(2, Ordering::SeqCst);
    sensors.power.store(1, Ordering::SeqCst);
    sensors.wifi.store(1, Ordering::SeqCst);
    t.poll_at(Local::now()).await.unwrap();
    t.poll_at(Local::now()).await.unwrap();
    settle(&e).await;
    assert_eq!(e.store.runs().unwrap().len(), 3);
}
#[tokio::test]
async fn network_trigger_uses_actual_tcp_transition() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    drop(listener);
    let e = Engine::new(
        Arc::new(Store::memory().unwrap()),
        Arc::new(NodeRegistry::builtins()),
        native_platform(),
    );
    scene(
        &e,
        "network",
        "networkAvailable",
        json!({"host":"127.0.0.1","port":port}),
    );
    let t = TriggerEngine::new(e.clone());
    t.refresh().unwrap();
    t.poll_at(Local::now()).await.unwrap();
    let _listener = tokio::net::TcpListener::bind(("127.0.0.1", port))
        .await
        .unwrap();
    t.poll_at(Local::now()).await.unwrap();
    settle(&e).await;
    assert_eq!(e.store.runs().unwrap().len(), 1);
}
#[test]
fn unknown_and_invalid_trigger_config_are_rejected() {
    let registry = TriggerRegistry::default();
    let mut s = Scene::new("bad");
    s.triggers = vec![Trigger {
        id: id(),
        kind: "schedule".into(),
        enabled: true,
        config: json!({"time":"99:99"}),
        parameters: Values::new(),
    }];
    assert!(registry.validate(&s).is_err());
    s.triggers[0].kind = "unknown".into();
    assert!(registry.validate(&s).is_err());
}

#[tokio::test]
async fn manual_trigger_defaults_are_overridable_and_do_not_leak_into_login() {
    let e = Engine::new(
        Arc::new(Store::memory().unwrap()),
        Arc::new(NodeRegistry::builtins()),
        native_platform(),
    );
    let mut s = scene(&e, "manual parameters", "manual", json!({}));
    s.parameters =
        serde_json::from_value(json!([{"name":"delay","kind":"number","required":true}])).unwrap();
    s.workflow.nodes[0].config = json!({"durationMs":"${delay}"});
    s.triggers[0].parameters.insert("delay".into(), json!(1));
    TriggerRegistry::default().validate(&s).unwrap();
    s = e.store.save_scene(s).unwrap();
    let t = TriggerEngine::new(e.clone());
    let first = t.manual(&s.id, Values::new(), "manual").unwrap();
    settle(&e).await;
    assert_eq!(first.parameter_snapshot["delay"], json!(1));
    let second = t
        .manual(&s.id, Values::from([("delay".into(), json!(2))]), "tray")
        .unwrap();
    settle(&e).await;
    assert_eq!(second.parameter_snapshot["delay"], json!(2));
    assert!(t.manual(&s.id, Values::new(), "startup").is_err());
    s.triggers[0]
        .parameters
        .insert("delay".into(), json!("bad"));
    assert!(t.registry.validate(&s).is_err());
}
