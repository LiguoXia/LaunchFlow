//! All trigger decisions live in Rust. Polling is bounded to five seconds; UI uses events.
use crate::{
    engine::Engine,
    model::*,
    parameters::{self, Values},
    platform::PlatformAdapter,
    workflow_nodes::{parse_time, tcp_available},
    Error, Result,
};
use async_trait::async_trait;
use chrono::{DateTime, Datelike, Local, Timelike};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::{BTreeMap, HashSet},
    sync::{Arc, Mutex, RwLock},
    time::Duration,
};
use tokio::sync::broadcast;
use tokio_util::sync::CancellationToken;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TriggerDefinition {
    pub kind: String,
    pub name: String,
    pub defaults: Value,
    pub description: String,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TriggerEvent {
    pub scene_id: String,
    pub trigger_id: String,
    pub kind: String,
    pub message: String,
    pub at: String,
}
#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields, default)]
struct Config {
    time: String,
    days: Vec<u32>,
    shortcut: String,
    host: String,
    port: u16,
    ssid: String,
    state: String,
}
pub struct Observation {
    pub value: String,
    pub fire: bool,
    pub scheduled: bool,
}
#[async_trait]
pub trait TriggerProvider: Send + Sync {
    fn definition(&self) -> TriggerDefinition;
    fn validate(&self, trigger: &Trigger) -> Result<()>;
    async fn observe(
        &self,
        trigger: &Trigger,
        platform: &dyn PlatformAdapter,
        now: DateTime<Local>,
    ) -> Result<Option<Observation>>;
}
struct Builtin {
    kind: &'static str,
    name: &'static str,
    defaults: Value,
    description: &'static str,
}
#[async_trait]
impl TriggerProvider for Builtin {
    fn definition(&self) -> TriggerDefinition {
        TriggerDefinition {
            kind: self.kind.into(),
            name: self.name.into(),
            defaults: self.defaults.clone(),
            description: self.description.into(),
        }
    }
    fn validate(&self, t: &Trigger) -> Result<()> {
        let c: Config = serde_json::from_value(t.config.clone())?;
        match self.kind {
            "schedule" | "weekday" => {
                parse_time(&c.time)?;
                if self.kind == "weekday"
                    && (c.days.is_empty() || c.days.iter().any(|d| !(1..=7).contains(d)))
                {
                    return Err(Error::Validation("Weekday trigger needs days 1–7".into()));
                }
            }
            "globalHotkey" if c.shortcut.trim().is_empty() => {
                return Err(Error::Validation("Hotkey is required".into()))
            }
            "networkAvailable" if c.host.trim().is_empty() || c.port == 0 => {
                return Err(Error::Validation(
                    "Network trigger needs host and port".into(),
                ))
            }
            "wifiSsid" if c.ssid.is_empty() => {
                return Err(Error::Validation("Wi-Fi SSID is required".into()))
            }
            "powerState" if !["ac", "battery"].contains(&c.state.as_str()) => {
                return Err(Error::Validation(
                    "Power trigger state must be ac or battery".into(),
                ))
            }
            _ => {}
        }
        Ok(())
    }
    async fn observe(
        &self,
        t: &Trigger,
        p: &dyn PlatformAdapter,
        now: DateTime<Local>,
    ) -> Result<Option<Observation>> {
        let c: Config = serde_json::from_value(t.config.clone())?;
        let (value, fire, scheduled) = match self.kind {
            "schedule" | "weekday" => {
                let time = parse_time(&c.time)?;
                let fire = now.hour() == time.hour()
                    && now.minute() == time.minute()
                    && (self.kind != "weekday"
                        || c.days.contains(&now.weekday().number_from_monday()));
                (now.format("%Y-%m-%d %H:%M").to_string(), fire, true)
            }
            "networkAvailable" => {
                let yes = tcp_available(&c.host, c.port).await;
                (yes.to_string(), yes, false)
            }
            "wifiSsid" => {
                let ssid = p.wifi_ssid().await?.unwrap_or_default();
                let yes = ssid == c.ssid;
                (ssid, yes, false)
            }
            "monitorChanged" => (p.monitor_signature().await?, true, false),
            "powerState" => {
                let state = p.power_state().await?;
                let yes = state == c.state;
                (state, yes, false)
            }
            _ => return Ok(None),
        };
        Ok(Some(Observation {
            value,
            fire,
            scheduled,
        }))
    }
}
pub struct TriggerRegistry {
    providers: BTreeMap<String, Arc<dyn TriggerProvider>>,
}
impl Default for TriggerRegistry {
    fn default() -> Self {
        let mut registry = Self {
            providers: BTreeMap::new(),
        };
        for (kind, name, defaults, description) in [
            ("manual", "手动运行", json!({}), "从界面或托盘启动"),
            (
                "systemLogin",
                "系统登录",
                json!({}),
                "仅默认启动场景生效；需启用系统登录启动",
            ),
            (
                "appStarted",
                "LaunchFlow 启动",
                json!({}),
                "本次应用进程启动时触发一次",
            ),
            (
                "schedule",
                "每日定时",
                json!({"time":"09:00"}),
                "本地时间；关闭应用时不补发",
            ),
            (
                "weekday",
                "每周定时",
                json!({"time":"09:00","days":[1,2,3,4,5]}),
                "1=周一，7=周日；本地时间",
            ),
            (
                "globalHotkey",
                "全局快捷键",
                json!({"shortcut":"Ctrl+Alt+J"}),
                "由操作系统注册；冲突会显示错误",
            ),
            (
                "networkAvailable",
                "网络恢复",
                json!({"host":"1.1.1.1","port":443}),
                "TCP 端点从不可达变为可达时触发",
            ),
            (
                "wifiSsid",
                "连接 Wi-Fi",
                json!({"ssid":""}),
                "SSID 变化并匹配时触发；可能需要定位权限",
            ),
            (
                "monitorChanged",
                "显示器变化",
                json!({}),
                "显示器连接或布局改变时触发",
            ),
            (
                "powerState",
                "电源状态",
                json!({"state":"ac"}),
                "切换至 ac 或 battery 时触发",
            ),
        ] {
            registry
                .register(Arc::new(Builtin {
                    kind,
                    name,
                    defaults,
                    description,
                }))
                .expect("unique trigger");
        }
        registry
    }
}
impl TriggerRegistry {
    pub fn register(&mut self, p: Arc<dyn TriggerProvider>) -> Result<()> {
        let kind = p.definition().kind;
        if self.providers.contains_key(&kind) {
            return Err(Error::Validation("Duplicate trigger provider".into()));
        }
        self.providers.insert(kind, p);
        Ok(())
    }
    pub fn provider(&self, kind: &str) -> Result<Arc<dyn TriggerProvider>> {
        self.providers
            .get(kind)
            .cloned()
            .ok_or_else(|| Error::Validation(format!("Unknown trigger: {kind}")))
    }
    pub fn definitions(&self) -> Vec<TriggerDefinition> {
        self.providers.values().map(|p| p.definition()).collect()
    }
    pub fn validate(&self, scene: &Scene) -> Result<()> {
        if scene.triggers.len() > 32 {
            return Err(Error::Validation("At most 32 triggers per scene".into()));
        }
        let mut ids = HashSet::new();
        if scene
            .triggers
            .iter()
            .filter(|t| t.enabled && t.kind == "manual")
            .count()
            > 1
        {
            return Err(Error::Validation(
                "Only one enabled manual trigger is allowed".into(),
            ));
        }
        for t in &scene.triggers {
            if t.id.is_empty() || !ids.insert(&t.id) {
                return Err(Error::Validation("Trigger IDs must be unique".into()));
            }
            self.provider(&t.kind)?.validate(t)?;
            if t.enabled && t.kind != "manual" {
                parameters::bind(&scene.parameters, &t.parameters)?;
            } else if t.enabled {
                let mut optional = scene.parameters.clone();
                for parameter in &mut optional {
                    parameter.required = false;
                }
                parameters::bind(&optional, &t.parameters)?;
            }
        }
        Ok(())
    }
}
pub struct TriggerEngine {
    pub registry: TriggerRegistry,
    engine: Arc<Engine>,
    scenes: RwLock<Vec<Scene>>,
    observations: Mutex<BTreeMap<String, String>>,
    status: Mutex<BTreeMap<String, TriggerEvent>>,
    events: broadcast::Sender<TriggerEvent>,
}
impl TriggerEngine {
    pub fn new(engine: Arc<Engine>) -> Arc<Self> {
        let (events, _) = broadcast::channel(128);
        Arc::new(Self {
            registry: TriggerRegistry::default(),
            engine,
            scenes: RwLock::new(vec![]),
            observations: Mutex::new(BTreeMap::new()),
            status: Mutex::new(BTreeMap::new()),
            events,
        })
    }
    pub fn refresh(&self) -> Result<()> {
        *self
            .scenes
            .write()
            .map_err(|_| Error::Runtime("Trigger catalog unavailable".into()))? =
            self.engine.store.scenes()?;
        Ok(())
    }
    pub fn subscribe(&self) -> broadcast::Receiver<TriggerEvent> {
        self.events.subscribe()
    }
    pub fn statuses(&self) -> Vec<TriggerEvent> {
        self.status
            .lock()
            .map(|s| s.values().cloned().collect())
            .unwrap_or_default()
    }
    pub fn report(&self, scene_id: &str, trigger_id: &str, kind: &str, message: &str) {
        let event = TriggerEvent {
            scene_id: scene_id.into(),
            trigger_id: trigger_id.into(),
            kind: kind.into(),
            message: message.into(),
            at: now(),
        };
        let key = format!("{scene_id}:{trigger_id}");
        if let Ok(mut s) = self.status.lock() {
            if s.get(&key)
                .is_some_and(|e| e.kind == kind && e.message == message)
            {
                return;
            }
            s.insert(key, event.clone());
        }
        let _ = self.events.send(event);
    }
    pub fn manual(&self, scene_id: &str, parameters: Values, source: &str) -> Result<Run> {
        self.manual_authorized(scene_id, parameters, source, false)
    }
    pub fn manual_authorized(
        &self,
        scene_id: &str,
        parameters: Values,
        source: &str,
        approved: bool,
    ) -> Result<Run> {
        self.registry.provider("manual")?.validate(&Trigger {
            id: "manual".into(),
            kind: "manual".into(),
            enabled: true,
            config: json!({}),
            parameters: Values::new(),
        })?;
        let mut values = if source != "startup" {
            self.engine
                .store
                .scene(scene_id)?
                .triggers
                .into_iter()
                .find(|t| t.kind == "manual" && t.enabled)
                .map(|t| t.parameters)
                .unwrap_or_default()
        } else {
            Values::new()
        };
        values.extend(parameters);
        self.engine
            .start_authorized(scene_id, source, values, approved)
    }
    pub fn fire(&self, scene_id: &str, trigger_id: &str) -> Result<Run> {
        let scene = self.engine.store.scene(scene_id)?;
        let t = scene
            .triggers
            .iter()
            .find(|t| t.id == trigger_id && t.enabled)
            .ok_or_else(|| Error::Validation("Trigger is disabled or missing".into()))?;
        self.registry.provider(&t.kind)?.validate(t)?;
        if t.kind == "systemLogin" && !scene.is_default {
            return Err(Error::Validation(
                "Only the default scene may run at system login".into(),
            ));
        }
        let result = self.engine.start_with_parameters(
            scene_id,
            if t.kind == "systemLogin" {
                "startup"
            } else {
                &t.kind
            },
            t.parameters.clone(),
        );
        match &result {
            Ok(r) => self.report(scene_id, trigger_id, "fired", &format!("Run {}", r.id)),
            Err(e) => self.report(scene_id, trigger_id, "error", &e.to_string()),
        };
        result
    }
    pub fn lifecycle(&self, kind: &str) -> Result<()> {
        self.registry.provider(kind)?;
        let scenes = self.engine.store.scenes()?;
        for scene in scenes {
            if kind == "systemLogin" && !scene.is_default {
                continue;
            }
            let matching: Vec<_> = scene.triggers.iter().filter(|t| t.kind == kind).collect();
            if kind == "systemLogin" && matching.is_empty() {
                if let Err(e) = self.manual(&scene.id, Values::new(), "startup") {
                    self.report(&scene.id, "defaultStartup", "error", &e.to_string());
                }
            }
            for t in matching.into_iter().filter(|t| t.enabled) {
                let _ = self.fire(&scene.id, &t.id);
            }
        }
        Ok(())
    }
    pub async fn poll_at(&self, clock: DateTime<Local>) -> Result<()> {
        let scenes = self
            .scenes
            .read()
            .map_err(|_| Error::Runtime("Trigger catalog unavailable".into()))?
            .clone();
        for scene in scenes {
            for t in scene.triggers.iter().filter(|t| t.enabled) {
                let provider = self.registry.provider(&t.kind)?;
                let key = format!("{}:{}:{}", scene.id, t.id, t.config);
                let observed = match provider
                    .observe(t, self.engine.platform.as_ref(), clock)
                    .await
                {
                    Ok(Some(v)) => v,
                    Ok(None) => continue,
                    Err(e) => {
                        self.report(&scene.id, &t.id, "error", &e.to_string());
                        continue;
                    }
                };
                let previous = self
                    .observations
                    .lock()
                    .map_err(|_| Error::Runtime("Trigger state unavailable".into()))?
                    .insert(key, observed.value.clone());
                let eligible = observed.fire
                    && (observed.scheduled || previous.is_some_and(|v| v != observed.value));
                if eligible
                    && (!observed.scheduled
                        || self
                            .engine
                            .store
                            .claim_trigger(&format!("{}:{}", scene.id, t.id), &observed.value)?)
                {
                    let _ = self.fire(&scene.id, &t.id);
                }
            }
        }
        Ok(())
    }
    pub fn start(self: &Arc<Self>, cancel: CancellationToken) {
        let this = self.clone();
        tokio::spawn(async move {
            let mut interval = tokio::time::interval(Duration::from_secs(5));
            interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
            loop {
                tokio::select! {_=cancel.cancelled()=>break,_=interval.tick()=>{tokio::select!{_=cancel.cancelled()=>break,result=this.poll_at(Local::now())=>{if let Err(e)=result{this.report("","engine","error",&e.to_string());}}}}}
            }
        });
    }
}
