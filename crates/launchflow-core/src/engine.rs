use crate::{
    model::*,
    parameters::{self, Values},
    platform::PlatformAdapter,
    registry::{NodeContext, NodeOutput, NodeRegistry, SubflowExecutor},
    storage::Store,
    validation::validate_scene,
    Error, Result,
};
use async_trait::async_trait;
use serde_json::{json, Value};
use std::{
    collections::{BTreeMap, HashMap, HashSet},
    future::Future,
    pin::Pin,
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant},
};
use tokio::{
    sync::{broadcast, mpsc, watch},
    task::JoinSet,
};
use tokio_util::sync::CancellationToken;

#[derive(Clone)]
struct Control {
    root_id: String,
    cancel: CancellationToken,
    pause: watch::Sender<bool>,
    decisions: mpsc::UnboundedSender<(String, String)>,
    done: watch::Sender<bool>,
}
struct ActiveRun {
    scene_id: String,
    parent: Option<String>,
    ordinal: u64,
    control: Control,
}
pub struct Engine {
    pub store: Arc<Store>,
    pub registry: Arc<NodeRegistry>,
    pub platform: Arc<dyn PlatformAdapter>,
    active: Mutex<HashMap<String, ActiveRun>>,
    events: broadcast::Sender<RunEvent>,
    sequence: AtomicU64,
    maintenance: AtomicBool,
}
impl Engine {
    pub fn new(
        store: Arc<Store>,
        registry: Arc<NodeRegistry>,
        platform: Arc<dyn PlatformAdapter>,
    ) -> Arc<Self> {
        let (events, _) = broadcast::channel(1024);
        Arc::new(Self {
            store,
            registry,
            platform,
            active: Mutex::new(HashMap::new()),
            events,
            sequence: AtomicU64::new(0),
            maintenance: AtomicBool::new(false),
        })
    }
    pub fn subscribe(&self) -> broadcast::Receiver<RunEvent> {
        self.events.subscribe()
    }
    pub fn begin_maintenance(&self) -> bool {
        self.maintenance
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .is_ok()
    }
    pub fn end_maintenance(&self) {
        self.maintenance.store(false, Ordering::SeqCst);
    }
    pub fn is_maintenance(&self) -> bool {
        self.maintenance.load(Ordering::SeqCst)
    }
    fn snapshots(&self, scene: &Scene, for_run: bool) -> Result<BTreeMap<String, Scene>> {
        let mut scenes: BTreeMap<_, _> = self
            .store
            .scenes()?
            .into_iter()
            .map(|s| (s.id.clone(), s))
            .collect();
        scenes.insert(scene.id.clone(), scene.clone());
        let profiles = self.store.profiles()?;
        fn visit(
            e: &Engine,
            id: &str,
            all: &BTreeMap<String, Scene>,
            stack: &mut HashSet<String>,
            found: &mut BTreeMap<String, Scene>,
            profiles: &[ApplicationProfile],
            for_run: bool,
        ) -> Result<()> {
            if stack.contains(id) {
                return Err(Error::Validation(
                    "Circular subflow reference detected".into(),
                ));
            }
            if found.contains_key(id) {
                return Ok(());
            }
            if stack.len() >= 16 {
                return Err(Error::Validation(
                    "Subflow nesting exceeds 16 levels".into(),
                ));
            }
            let scene = all
                .get(id)
                .ok_or_else(|| Error::Validation(format!("Missing subflow: {id}")))?;
            crate::triggers::TriggerRegistry::default().validate(scene)?;
            let issues = validate_scene(scene, &e.registry, profiles, e.platform.os(), for_run);
            if !issues.is_empty() {
                return Err(Error::Validation(
                    issues
                        .iter()
                        .map(|i| format!("{}: {}", scene.name, i.message))
                        .collect::<Vec<_>>()
                        .join("\n"),
                ));
            }
            stack.insert(id.into());
            for n in scene
                .workflow
                .nodes
                .iter()
                .filter(|n| n.enabled && n.node_type == "flow.subflow")
            {
                let c: crate::workflow_nodes::SubflowConfig =
                    serde_json::from_value(n.config.clone())?;
                visit(e, &c.scene_id, all, stack, found, profiles, for_run)?;
                let child = &all[&c.scene_id];
                if c.parameters
                    .keys()
                    .any(|k| !child.parameters.iter().any(|p| &p.name == k))
                {
                    return Err(Error::Validation("Unknown subflow parameter".into()));
                }
                for p in &child.parameters {
                    if p.required
                        && p.default_value.is_null()
                        && !c.parameters.contains_key(&p.name)
                    {
                        return Err(Error::Validation(format!(
                            "Missing required subflow parameter: {}",
                            p.name
                        )));
                    }
                }
            }
            stack.remove(id);
            found.insert(id.into(), scene.clone());
            Ok(())
        }
        let mut found = BTreeMap::new();
        visit(
            self,
            &scene.id,
            &scenes,
            &mut HashSet::new(),
            &mut found,
            &profiles,
            for_run,
        )?;
        found.remove(&scene.id);
        Ok(found)
    }
    pub fn validate(&self, scene: &Scene, for_run: bool) -> Result<Vec<ValidationIssue>> {
        let issues = validate_scene(
            scene,
            &self.registry,
            &self.store.profiles()?,
            self.platform.os(),
            for_run,
        );
        if !issues.is_empty() {
            return Ok(issues);
        }
        Ok(match self.snapshots(scene, for_run) {
            Ok(_) => vec![],
            Err(e) => vec![ValidationIssue {
                node_id: None,
                message: e.to_string(),
            }],
        })
    }
    pub fn start(self: &Arc<Self>, scene_id: &str, source: &str) -> Result<Run> {
        self.start_with_parameters(scene_id, source, Values::new())
    }
    /// Execute exactly one GUI node from an unsaved editor snapshot.
    pub fn test_action(
        self: &Arc<Self>,
        scene: Scene,
        node_id: &str,
        values: Values,
    ) -> Result<Run> {
        self.test_action_authorized(scene, node_id, values, false)
    }
    pub fn test_action_authorized(
        self: &Arc<Self>,
        mut scene: Scene,
        node_id: &str,
        values: Values,
        approved: bool,
    ) -> Result<Run> {
        let mut node = scene
            .workflow
            .nodes
            .iter()
            .find(|n| n.id == node_id && n.node_type.starts_with("gui."))
            .cloned()
            .ok_or_else(|| Error::Validation("Select a GUI action to test".into()))?;
        node.enabled = true;
        // A failure outlet has no downstream branch in this isolated snapshot.
        if node.failure_policy == FailurePolicy::FailureBranch {
            node.failure_policy = FailurePolicy::StopWorkflow;
        }
        scene.id = format!("action-test-{}", id());
        scene.name = format!("Test Action · {}", node.name);
        scene.workflow.nodes = vec![node];
        scene.workflow.edges.clear();
        scene.triggers.clear();
        crate::policy::check(std::iter::once(&scene), "actionTest", approved)?;
        let issues = self.validate(&scene, true)?;
        if !issues.is_empty() {
            return Err(Error::Validation(
                issues
                    .iter()
                    .map(|i| i.message.clone())
                    .collect::<Vec<_>>()
                    .join("\n"),
            ));
        }
        let parameters = parameters::bind(&scene.parameters, &values)?;
        let mut run = Run::new(scene, "actionTest");
        run.parameter_snapshot = parameters;
        run.profiles_snapshot = self.store.profiles()?;
        self.enqueue(run, None)
    }
    pub fn start_with_parameters(
        self: &Arc<Self>,
        scene_id: &str,
        source: &str,
        parameters: Values,
    ) -> Result<Run> {
        self.start_authorized(scene_id, source, parameters, false)
    }
    pub fn sensitive_actions(&self, scene_id: &str) -> Result<Vec<String>> {
        let scene = self.store.scene(scene_id)?;
        let snapshots = self.snapshots(&scene, false)?;
        Ok(std::iter::once(&scene)
            .chain(snapshots.values().filter(|s| s.id != scene.id))
            .filter(|s| {
                s.sensitive_action_policy == crate::policy::SensitiveActionPolicy::AskEveryTime
            })
            .flat_map(|s| {
                s.workflow
                    .nodes
                    .iter()
                    .filter(|n| crate::policy::sensitive(n))
                    .map(|n| format!("{} · {}", s.name, n.name))
            })
            .collect())
    }
    pub fn start_authorized(
        self: &Arc<Self>,
        scene_id: &str,
        source: &str,
        parameters: Values,
        approved: bool,
    ) -> Result<Run> {
        self.start_authorized_with_trigger(scene_id, source, parameters, approved, None)
    }
    pub fn start_authorized_with_trigger(
        self: &Arc<Self>,
        scene_id: &str,
        source: &str,
        parameters: Values,
        approved: bool,
        trigger_id: Option<&str>,
    ) -> Result<Run> {
        let scene = self.store.scene(scene_id)?;
        let snapshots = self.snapshots(&scene, true)?;
        crate::policy::check(
            std::iter::once(&scene).chain(snapshots.values()),
            source,
            approved,
        )?;
        let parameters = parameters::bind(&scene.parameters, &parameters)?;
        let mut run = Run::new(scene, source);
        run.trigger_id = trigger_id.map(str::to_owned);
        run.parameter_snapshot = parameters;
        run.subflow_snapshots = snapshots;
        run.profiles_snapshot = self.store.profiles()?;
        self.enqueue(run, None)
    }
    pub fn check_startup(&self, scene: &Scene, values: &Values) -> Result<()> {
        let snapshots = self.snapshots(scene, true)?;
        crate::policy::check(
            std::iter::once(scene).chain(snapshots.values()),
            "startup",
            false,
        )?;
        parameters::bind(&scene.parameters, values)?;
        Ok(())
    }
    pub fn record_startup_rejection(&self, scene: Scene, message: &str) -> Result<Run> {
        let mut run = Run::new(scene, "startup");
        run.status = RunStatus::Failed;
        run.ended_at = Some(now());
        run.error = Some(message.into());
        for node in &mut run.node_runs {
            node.status = NodeStatus::Skipped;
            node.message = "启动检查未通过，步骤未执行".into();
        }
        self.publish(&mut run, "RunFailed")?;
        Ok(run)
    }
    fn enqueue(self: &Arc<Self>, mut run: Run, parent: Option<Control>) -> Result<Run> {
        let mut active = self
            .active
            .lock()
            .map_err(|_| Error::Runtime("Run manager lock unavailable".into()))?;
        if self.maintenance.load(Ordering::SeqCst) {
            return Err(Error::Runtime(
                "LaunchFlow is preparing an update. Try again after installation.".into(),
            ));
        }
        let mut predecessors = vec![];
        if parent.is_none() {
            let mut existing: Vec<_> = active
                .iter()
                .filter(|(id, a)| {
                    a.parent.is_none()
                        && a.scene_id == run.scene_id
                        && !*a.control.done.borrow()
                        && self
                            .store
                            .run(id)
                            .map(|r| r.status.is_active())
                            .unwrap_or(true)
                })
                .collect();
            existing.sort_by_key(|(_, a)| a.ordinal);
            if !existing.is_empty() {
                match run.scene_snapshot.concurrent_run_policy {
                    ConcurrentRunPolicy::Ignore => return self.store.run(existing[0].0),
                    ConcurrentRunPolicy::Restart => {
                        for (_, a) in &existing {
                            a.control.cancel.cancel();
                        }
                    }
                    ConcurrentRunPolicy::Queue => {
                        if existing.len() >= 32 {
                            return Err(Error::Validation("Scene queue is full (32 runs)".into()));
                        }
                    }
                }
                predecessors = existing
                    .iter()
                    .map(|(_, a)| a.control.done.subscribe())
                    .collect();
                run.status = RunStatus::Queued;
            }
        }
        let (decisions, receiver) = mpsc::unbounded_channel();
        let (done, _) = watch::channel(false);
        let control = Control {
            root_id: parent
                .as_ref()
                .map(|p| p.root_id.clone())
                .unwrap_or_else(|| run.id.clone()),
            cancel: parent
                .as_ref()
                .map(|p| p.cancel.child_token())
                .unwrap_or_default(),
            pause: parent
                .as_ref()
                .map(|p| p.pause.clone())
                .unwrap_or_else(|| watch::channel(false).0),
            decisions,
            done,
        };
        self.publish(
            &mut run,
            if !predecessors.is_empty() {
                "RunQueued"
            } else {
                "RunCreated"
            },
        )?;
        active.insert(
            run.id.clone(),
            ActiveRun {
                scene_id: run.scene_id.clone(),
                parent: run.parent_run_id.clone(),
                ordinal: self.sequence.fetch_add(1, Ordering::Relaxed),
                control: control.clone(),
            },
        );
        let engine = self.clone();
        let initial = run.clone();
        tokio::spawn(async move {
            let mut run = initial;
            for mut previous in predecessors {
                tokio::select! {
                    _=control.cancel.cancelled()=>{},
                    _=async { while !*previous.borrow() { if previous.changed().await.is_err() { break; } } }=>{}
                }
            }
            if let Err(error) = engine.execute(&mut run, control.clone(), receiver).await {
                control.cancel.cancel();
                run.status = RunStatus::Failed;
                run.error = Some(format!(
                    "Persistence or engine failure: {}",
                    crate::registry::redact(&error.to_string())
                ));
                run.ended_at = Some(now());
                let _ = engine.publish(&mut run, "RunFailed");
            }
            control.done.send_replace(true);
            if let Ok(mut active) = engine.active.lock() {
                active.remove(&run.id);
            }
            let _ = engine.store.cleanup();
        });
        Ok(run)
    }
    fn control(&self, run_id: &str) -> Result<Control> {
        self.active
            .lock()
            .map_err(|_| Error::Runtime("Run manager lock unavailable".into()))?
            .get(run_id)
            .map(|a| a.control.clone())
            .ok_or_else(|| Error::Validation("Run is no longer active".into()))
    }
    pub fn cancel(&self, run_id: &str) -> Result<()> {
        self.control(run_id)?.cancel.cancel();
        Ok(())
    }
    pub fn pause(&self, run_id: &str) -> Result<()> {
        self.control(run_id)?.pause.send_replace(true);
        Ok(())
    }
    pub fn resume(&self, run_id: &str) -> Result<()> {
        let control = self.control(run_id)?;
        let family: Vec<String> = self
            .active
            .lock()
            .map_err(|_| Error::Runtime("Run manager lock unavailable".into()))?
            .iter()
            .filter(|(_, a)| a.control.root_id == control.root_id)
            .map(|(id, _)| id.clone())
            .collect();
        if family.iter().any(|id| {
            self.store
                .run(id)
                .is_ok_and(|r| r.node_runs.iter().any(|n| n.status == NodeStatus::Paused))
        }) {
            return Err(Error::Validation(
                "Resolve the failed node with Retry or Skip before resuming".into(),
            ));
        }
        control.pause.send_replace(false);
        Ok(())
    }
    pub fn decide(&self, run_id: &str, node_id: &str, action: &str) -> Result<()> {
        if !["retry", "skip"].contains(&action) {
            return Err(Error::Validation("Decision must be retry or skip".into()));
        }
        if !self
            .store
            .run(run_id)?
            .node_runs
            .iter()
            .any(|n| n.node_id == node_id && n.status == NodeStatus::Paused)
        {
            return Err(Error::Validation("Node is not awaiting a decision".into()));
        }
        self.control(run_id)?
            .decisions
            .send((node_id.into(), action.into()))
            .map_err(|_| Error::Runtime("Run has finished".into()))
    }
    pub fn recover(
        self: &Arc<Self>,
        run_id: &str,
        action: &str,
        node_id: Option<&str>,
    ) -> Result<Run> {
        self.recover_authorized(run_id, action, node_id, false)
    }
    pub fn recover_authorized(
        self: &Arc<Self>,
        run_id: &str,
        action: &str,
        node_id: Option<&str>,
        approved: bool,
    ) -> Result<Run> {
        let previous = self.store.run(run_id)?;
        if previous.status.is_active() {
            return Err(Error::Validation("Active runs cannot be recovered".into()));
        }
        if !["retryFailed", "continue", "safeResume", "skip", "restart"].contains(&action) {
            return Err(Error::Validation("Unknown recovery action".into()));
        }
        if self.scene_active(&previous.scene_id) {
            return Err(Error::Validation(
                "Stop the current scene run before recovery".into(),
            ));
        }
        let uncertain = previous.node_runs.iter().any(|r| {
            r.started_at.is_some()
                && (!reusable(r) || action == "restart")
                && previous.scene_snapshot.workflow.nodes.iter().any(|n| {
                    n.id == r.node_id
                        && (crate::policy::sensitive(n) || n.node_type == "flow.subflow")
                })
        });
        if action == "safeResume" && uncertain {
            return Err(Error::Validation("A sensitive operation may have executed before interruption. Review it, then explicitly restart or skip it; safe resume cannot repeat it.".into()));
        }
        if uncertain && !approved {
            return Err(Error::Validation("sensitiveApprovalRequired: Recovery may repeat a sensitive operation. Explicit confirmation is required.".into()));
        }
        crate::policy::check(
            std::iter::once(&previous.scene_snapshot).chain(previous.subflow_snapshots.values()),
            "recovery",
            approved,
        )?;
        let mut run = Run::new(previous.scene_snapshot.clone(), "recovery");
        run.parameter_snapshot = previous.parameter_snapshot.clone();
        run.subflow_snapshots = previous.subflow_snapshots.clone();
        run.profiles_snapshot = if previous.profiles_snapshot.is_empty() {
            self.store.profiles()?
        } else {
            previous.profiles_snapshot.clone()
        };
        run.resumed_from = Some(previous.id.clone());
        if action != "restart" {
            let target = node_id.or_else(|| {
                previous
                    .node_runs
                    .iter()
                    .find(|n| n.status == NodeStatus::Failed && n.outlet.is_none())
                    .map(|n| n.node_id.as_str())
            });
            if action == "skip" && target.is_none() {
                return Err(Error::Validation("Choose a failed node to skip".into()));
            }
            if let Some(id) = target {
                if !previous.node_runs.iter().any(|n| {
                    n.node_id == id
                        && matches!(
                            n.status,
                            NodeStatus::Failed | NodeStatus::Cancelled | NodeStatus::Paused
                        )
                }) {
                    return Err(Error::Validation(
                        "Recovery target must be a failed or interrupted node".into(),
                    ));
                }
            }
            for (state, old) in run.node_runs.iter_mut().zip(&previous.node_runs) {
                if reusable(old) && Some(old.node_id.as_str()) != target {
                    *state = old.clone();
                    if state.outlet.is_none() {
                        state.outlet = Some(success_outlet());
                    }
                    state.reused_from = Some(previous.id.clone());
                } else if action == "skip" && Some(old.node_id.as_str()) == target {
                    state.status = NodeStatus::Skipped;
                    state.outlet = bypass(
                        &run.scene_snapshot
                            .workflow
                            .nodes
                            .iter()
                            .find(|n| n.id == old.node_id)
                            .expect("snapshot node")
                            .node_type,
                    );
                    state.message = "Skipped by recovery decision".into();
                    state.reused_from = Some(previous.id.clone());
                } else if run
                    .scene_snapshot
                    .workflow
                    .nodes
                    .iter()
                    .any(|n| n.id == old.node_id && n.node_type == "flow.subflow")
                {
                    state.output = old.output.clone();
                }
            }
        }
        self.enqueue(run, None)
    }
    pub fn cancel_all(&self) {
        if let Ok(active) = self.active.lock() {
            for a in active.values() {
                a.control.cancel.cancel();
            }
        }
    }
    pub fn has_active(&self) -> bool {
        self.active.lock().map(|a| !a.is_empty()).unwrap_or(true)
    }
    pub fn scene_active(&self, id: &str) -> bool {
        self.active
            .lock()
            .map(|a| a.values().any(|v| v.scene_id == id))
            .unwrap_or(true)
    }
    fn publish(&self, run: &mut Run, kind: &str) -> Result<()> {
        run.revision += 1;
        self.store.save_run(run)?;
        let _ = self.events.send(RunEvent {
            kind: kind.into(),
            run: run.clone(),
        });
        Ok(())
    }
    fn execute<'a>(
        self: &'a Arc<Self>,
        run: &'a mut Run,
        control: Control,
        mut decisions: mpsc::UnboundedReceiver<(String, String)>,
    ) -> Pin<Box<dyn Future<Output = Result<()>> + Send + 'a>> {
        Box::pin(async move {
            let started = Instant::now();
            let local_cancel = control.cancel.child_token();
            let mut pause = control.pause.subscribe();
            let (parameters, secrets) = parameters::runtime_values(
                &run.scene_snapshot.parameters,
                &run.parameter_snapshot,
                self.platform.automation().as_ref(),
            )
            .await?;
            let nodes = run.scene_snapshot.workflow.nodes.clone();
            let edges = run.scene_snapshot.workflow.edges.clone();
            let indices: HashMap<_, _> = nodes
                .iter()
                .enumerate()
                .map(|(i, n)| (n.id.as_str(), i))
                .collect();
            let mut tasks = JoinSet::new();
            let mut retries: HashMap<usize, Instant> = HashMap::new();
            let mut awaiting = HashSet::new();
            let mut waiting_desktop = HashSet::new();
            run.status = if *pause.borrow() {
                RunStatus::Paused
            } else {
                RunStatus::Running
            };
            self.publish(run, "RunStarted")?;
            loop {
                if control.cancel.is_cancelled() {
                    run.status = RunStatus::Cancelled;
                    break;
                }
                let paused = *pause.borrow();
                if paused && run.status != RunStatus::Paused {
                    run.status = RunStatus::Paused;
                    self.publish(run, "RunPaused")?;
                }
                if !paused && run.status == RunStatus::Paused && awaiting.is_empty() {
                    run.status = RunStatus::Running;
                    self.publish(run, "RunResumed")?;
                }
                let mut progressed = false;
                if !paused && awaiting.is_empty() {
                    for (index, node) in nodes.iter().enumerate() {
                        if waiting_desktop.contains(&index) {
                            if !self.platform.desktop_ready() {
                                continue;
                            }
                            waiting_desktop.remove(&index);
                            run.node_runs[index].status = NodeStatus::Pending;
                            run.node_runs[index].message.clear();
                        }
                        if tasks.len() >= run.scene_snapshot.max_parallel {
                            break;
                        }
                        let retry_ready = run.node_runs[index].status == NodeStatus::Retrying
                            && retries
                                .get(&index)
                                .is_some_and(|due| *due <= Instant::now());
                        if run.node_runs[index].status != NodeStatus::Pending && !retry_ready {
                            continue;
                        }
                        if !retry_ready {
                            let incoming: Vec<_> =
                                edges.iter().filter(|e| e.to == node.id).collect();
                            if !incoming
                                .iter()
                                .all(|e| terminal(&run.node_runs[indices[e.from.as_str()]].status))
                            {
                                continue;
                            }
                            let reachable = incoming.is_empty()
                                || incoming.iter().any(|e| {
                                    let outlet =
                                        run.node_runs[indices[e.from.as_str()]].outlet.as_deref();
                                    outlet == Some(e.outlet.as_str())
                                        || (outlet == Some("bypass") && e.outlet != "failure")
                                });
                            if !reachable || !node.enabled {
                                let state = &mut run.node_runs[index];
                                state.status = NodeStatus::Skipped;
                                state.ended_at = Some(now());
                                state.outlet = if reachable {
                                    bypass(&node.node_type)
                                } else {
                                    None
                                };
                                state.message = if reachable {
                                    "Disabled in scene"
                                } else {
                                    "Inactive branch"
                                }
                                .into();
                                self.publish(run, "NodeSkipped")?;
                                progressed = true;
                                continue;
                            }
                        }
                        retries.remove(&index);
                        if (node.node_type.starts_with("gui.")
                            || node.node_type == "clipboard.copyText"
                            || node.node_type == "workspace.restore")
                            && !self.platform.desktop_ready()
                        {
                            waiting_desktop.insert(index);
                            run.node_runs[index].status = NodeStatus::Waiting;
                            run.node_runs[index].message = Error::DesktopUnavailable.to_string();
                            self.publish(run, "NodeWaitingForDesktop")?;
                            continue;
                        }
                        run.node_runs[index].status = NodeStatus::Queued;
                        self.publish(run, "NodeQueued")?;
                        // A child run persists its inputs. Forward environment references,
                        // never materialized secret values, across this persistence boundary.
                        let values = if node.node_type == "flow.subflow"
                            || node.node_type == "gui.inputSecret"
                        {
                            &run.parameter_snapshot
                        } else {
                            &parameters
                        };
                        let config = parameters::resolve(&node.config, values, run);
                        let runner = self.registry.runner(&node.node_type)?;
                        let mut resolved = config.and_then(|mut c| {
                            for field in runner
                                .definition()
                                .fields
                                .iter()
                                .filter(|f| f.kind == "arguments")
                            {
                                if let Some(args) =
                                    c.get_mut(&field.key).and_then(Value::as_array_mut)
                                {
                                    for value in args {
                                        if value.is_number() || value.is_boolean() {
                                            *value = Value::String(value.to_string());
                                        }
                                    }
                                }
                            }
                            runner.validate(&c)?;
                            Ok(c)
                        });
                        if !node.platform_constraint.is_empty()
                            && !node
                                .platform_constraint
                                .iter()
                                .any(|p| p == self.platform.os())
                        {
                            resolved = Err(Error::Validation(format!(
                                "Active node does not support {}",
                                self.platform.os()
                            )));
                        }
                        let state = &mut run.node_runs[index];
                        state.status = NodeStatus::Running;
                        state.started_at.get_or_insert_with(now);
                        state.ended_at = None;
                        state.error = None;
                        self.publish(run, "NodeStarted")?;
                        if runner.definition().waiting {
                            run.node_runs[index].status = NodeStatus::Waiting;
                            self.publish(run, "NodeWaiting")?;
                        }
                        let engine = self.clone();
                        let ctx = NodeContext {
                            diagnostics: Default::default(),
                            platform: self.platform.clone(),
                            profiles: run.profiles_snapshot.clone(),
                            subflows: Some(Arc::new(ChildExecutor {
                                engine,
                                parent: run.clone(),
                                node_id: node.id.clone(),
                                control: Control {
                                    cancel: local_cancel.child_token(),
                                    ..control.clone()
                                },
                            })),
                        };
                        let cancel = local_cancel.clone();
                        let timeout = node.timeout_ms;
                        let launching_application = node.node_type == "application.launch";
                        let diagnostic_config = resolved
                            .as_ref()
                            .ok()
                            .cloned()
                            .unwrap_or_else(|| node.config.clone());
                        tasks.spawn(async move {
                            let start=Instant::now();
                            let mut result=match resolved {
                                Err(e)=>Err(e),
                                Ok(config)=>tokio::select! {
                                    biased;
                                    _=cancel.cancelled()=>Err(Error::Runtime("Node cancelled".into())),
                                    result=tokio::time::timeout(Duration::from_millis(timeout),runner.run(&config,&ctx))=>result.unwrap_or_else(|_| Err(if launching_application {
                                        Error::ApplicationLaunchReview(format!("启动应用超时（{timeout} ms）。请检查系统授权框（如有）及应用是否已启动，必要时延长步骤超时后手动重试；为避免重复启动，本步骤不自动重试。"))
                                    } else { Error::Runtime(format!("Node timed out after {timeout} ms")) })),
                                }
                            };
                            if let Err(error)=&result {
                                if let Ok(Some(value))=tokio::time::timeout(Duration::from_secs(3),runner.failure_diagnostics(&diagnostic_config,&ctx,error)).await {
                                    if let Ok(diagnostic)=serde_json::from_value(value) {
                                        let message = match error { Error::Automation {message,..} => message.clone(), _ => error.to_string() };
                                        result=Err(Error::Automation{message,diagnostic:Box::new(diagnostic)});
                                    }
                                }
                            }
                            (index,start.elapsed().as_millis() as u64,result)
                        });
                        progressed = true;
                    }
                }
                if tasks.is_empty()
                    && retries.is_empty()
                    && awaiting.is_empty()
                    && run.node_runs.iter().all(|n| terminal(&n.status))
                {
                    run.status = RunStatus::Succeeded;
                    break;
                }
                if progressed {
                    continue;
                }
                if tasks.is_empty()
                    && retries.is_empty()
                    && awaiting.is_empty()
                    && waiting_desktop.is_empty()
                    && !paused
                {
                    return Err(Error::Runtime(
                        "No runnable node remains; invalid dependency state".into(),
                    ));
                }
                let mut delay = if paused {
                    Duration::from_secs(86400)
                } else {
                    retries
                        .values()
                        .min()
                        .map(|t| t.saturating_duration_since(Instant::now()))
                        .unwrap_or(Duration::from_secs(86400))
                };
                if !paused && !waiting_desktop.is_empty() {
                    delay = delay.min(Duration::from_secs(1));
                }
                tokio::select! {
                    biased;
                    _=control.cancel.cancelled()=>{run.status=RunStatus::Cancelled;break;},
                    _=pause.changed()=>{},
                    Some((node_id,action))=decisions.recv()=>{
                        if let Some(&index)=indices.get(node_id.as_str()) {
                            if awaiting.remove(&index) {
                                if action=="skip" {
                                    run.node_runs[index].status=NodeStatus::Skipped; run.node_runs[index].outlet=bypass(&nodes[index].node_type); run.node_runs[index].message="Skipped by user".into();
                                    self.publish(run,"NodeSkipped")?;
                                } else { run.node_runs[index].status=NodeStatus::Pending; run.node_runs[index].retry_count=0; run.node_runs[index].error=None; self.publish(run,"NodeRetryRequested")?; }
                                if awaiting.is_empty() {
                                    let family:Vec<String>=self.active.lock().map_err(|_|Error::Runtime("Run manager lock unavailable".into()))?.iter().filter(|(id,a)|*id!=&run.id && a.control.root_id==control.root_id).map(|(id,_)|id.clone()).collect();
                                    if !family.iter().any(|id|self.store.run(id).is_ok_and(|r|r.node_runs.iter().any(|n|n.status==NodeStatus::Paused))) {control.pause.send_replace(false);}
                                }
                            }
                        }
                    },
                    result=tasks.join_next(), if !tasks.is_empty()=>{
                        let (index,elapsed,result)=result.expect("nonempty").map_err(|e| Error::Runtime(format!("Node task failed: {e}")))?;
                        let state=&mut run.node_runs[index]; state.duration_ms+=elapsed; state.ended_at=Some(now());
                        match result {
                            Ok(mut output)=>{
                                state.status=NodeStatus::Succeeded; state.message=parameters::scrub(&output.message,&secrets);
                                state.stdout=parameters::scrub(&output.stdout,&secrets); state.stderr=parameters::scrub(&output.stderr,&secrets);
                                parameters::scrub_value(&mut output.output,&secrets);
                                state.output=output.output; state.outlet=Some(output.outlet.unwrap_or_else(success_outlet));
                                self.publish(run,"NodeSucceeded")?;
                            },
                            Err(error)=>{
                                if matches!(error, Error::DesktopUnavailable) {
                                    state.status = NodeStatus::Waiting; state.ended_at = None; state.error = None;
                                    state.message = error.to_string(); waiting_desktop.insert(index);
                                    self.publish(run,"NodeWaitingForDesktop")?;
                                    continue;
                                }
                                let retryable = !matches!(error, Error::ApplicationLaunchReview(_));
                                if let Error::Automation {diagnostic,..}=&error {let mut value=json!({"automation":diagnostic});parameters::scrub_value(&mut value,&secrets);state.output=value;}
                                if let Error::Subflow { run_id,.. }=&error {state.output=json!({"runId":run_id});}
                                let error=parameters::scrub(&error.to_string(),&secrets);
                                state.status=NodeStatus::Failed; state.error=Some(error.clone());
                                self.publish(run,"NodeFailed")?;
                                if retryable && run.node_runs[index].retry_count<nodes[index].retry_policy.max_retries {
                                    run.node_runs[index].retry_count+=1; run.node_runs[index].status=NodeStatus::Retrying;
                                    retries.insert(index,Instant::now()+Duration::from_millis(nodes[index].retry_policy.delay_ms));
                                    self.publish(run,"NodeRetrying")?;
                                } else { match nodes[index].failure_policy {
                                    FailurePolicy::StopWorkflow=>{run.status=RunStatus::Failed;run.error=Some(error);break;},
                                    FailurePolicy::SkipAndContinue=>{run.node_runs[index].status=NodeStatus::Skipped;run.node_runs[index].outlet=bypass(&nodes[index].node_type);self.publish(run,"NodeSkipped")?;},
                                    FailurePolicy::FailureBranch=>{run.node_runs[index].outlet=Some("failure".into());self.publish(run,"NodeFailureRouted")?;},
                                    FailurePolicy::AskUser=>{run.node_runs[index].status=NodeStatus::Paused;awaiting.insert(index);control.pause.send_replace(true);run.status=RunStatus::Paused;self.publish(run,"RunPaused")?;},
                                } }
                            }
                        }
                    },
                    _=tokio::time::sleep(delay)=>{},
                }
            }
            local_cancel.cancel();
            while tasks.join_next().await.is_some() {}
            // Subflows persist their cancellation before the parent becomes terminal.
            let children: Vec<_> = self
                .active
                .lock()
                .map_err(|_| Error::Runtime("Run manager lock unavailable".into()))?
                .values()
                .filter(|a| a.parent.as_deref() == Some(run.id.as_str()))
                .map(|a| a.control.done.subscribe())
                .collect();
            for mut done in children {
                while !*done.borrow() {
                    if done.changed().await.is_err() {
                        break;
                    }
                }
            }
            for state in &mut run.node_runs {
                if !terminal(&state.status) {
                    state.status = NodeStatus::Cancelled;
                    state.ended_at = Some(now());
                    state.message = "Workflow stopped before completion".into();
                }
            }
            run.duration_ms = started.elapsed().as_millis() as u64;
            run.ended_at = Some(now());
            self.publish(
                run,
                match run.status {
                    RunStatus::Succeeded => "RunCompleted",
                    RunStatus::Cancelled => "RunCancelled",
                    _ => "RunFailed",
                },
            )
        })
    }
}
fn terminal(status: &NodeStatus) -> bool {
    matches!(
        status,
        NodeStatus::Succeeded | NodeStatus::Failed | NodeStatus::Skipped | NodeStatus::Cancelled
    )
}
fn bypass(kind: &str) -> Option<String> {
    if kind == "flow.condition" {
        None
    } else {
        Some("bypass".into())
    }
}
fn reusable(state: &NodeRun) -> bool {
    state.outlet.is_some()
        || state.status == NodeStatus::Succeeded
        || (state.status == NodeStatus::Skipped && state.message == "Disabled in scene")
}
struct ChildExecutor {
    engine: Arc<Engine>,
    parent: Run,
    node_id: String,
    control: Control,
}
struct CancelChild(CancellationToken);
impl Drop for CancelChild {
    fn drop(&mut self) {
        self.0.cancel();
    }
}
#[async_trait]
impl SubflowExecutor for ChildExecutor {
    async fn execute(&self, scene_id: &str, supplied: Values) -> Result<NodeOutput> {
        let scene = self
            .parent
            .subflow_snapshots
            .get(scene_id)
            .ok_or_else(|| Error::Validation("Subflow missing from run snapshot".into()))?
            .clone();
        let parameters = parameters::bind(&scene.parameters, &supplied)?;
        let mut run = Run::new(scene, "subflow");
        run.parameter_snapshot = parameters;
        run.parent_run_id = Some(self.parent.id.clone());
        run.parent_node_id = Some(self.node_id.clone());
        run.subflow_snapshots = self.parent.subflow_snapshots.clone();
        run.profiles_snapshot = self.parent.profiles_snapshot.clone();
        if let Some(previous_id) = self
            .parent
            .node_runs
            .iter()
            .find(|n| n.node_id == self.node_id)
            .and_then(|n| n.output["runId"].as_str())
        {
            let previous = self.engine.store.run(previous_id)?;
            if previous.scene_id != run.scene_id || previous.status.is_active() {
                return Err(Error::Validation(
                    "Subflow recovery snapshot mismatch or prior attempt still active".into(),
                ));
            }
            run.resumed_from = Some(previous.id.clone());
            for (state, old) in run.node_runs.iter_mut().zip(&previous.node_runs) {
                if reusable(old) {
                    *state = old.clone();
                    if state.outlet.is_none() {
                        state.outlet = Some(success_outlet());
                    }
                    state.reused_from = Some(previous.id.clone());
                } else {
                    state.output = old.output.clone();
                }
            }
        }
        let child = self.engine.enqueue(run, Some(self.control.clone()))?;
        if let Ok(control) = self.engine.control(&child.id) {
            let _guard = CancelChild(control.cancel.clone());
            let mut done = control.done.subscribe();
            while !*done.borrow() {
                if done.changed().await.is_err() {
                    break;
                }
            }
        }
        let result = self.engine.store.run(&child.id)?;
        if result.status != RunStatus::Succeeded {
            return Err(Error::Subflow {
                run_id: result.id,
                message: format!(
                    "{}: {}",
                    result.scene_name,
                    result
                        .error
                        .unwrap_or_else(|| format!("{:?}", result.status))
                ),
            });
        }
        let outputs: BTreeMap<String, Value> = result
            .node_runs
            .iter()
            .map(|n| (n.node_id.clone(), n.output.clone()))
            .collect();
        Ok(NodeOutput {
            message: format!("Subflow completed: {}", result.scene_name),
            output: json!({"runId":result.id,"nodes":outputs}),
            ..Default::default()
        })
    }
}
