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
    assert_eq!(t.registry.definitions().len(), 10);
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
