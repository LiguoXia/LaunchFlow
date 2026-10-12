use chrono::Utc;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;
use uuid::Uuid;

pub const SCHEMA_VERSION: u32 = 1;
pub fn now() -> String {
    Utc::now().to_rfc3339()
}
pub fn id() -> String {
    Uuid::new_v4().to_string()
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Scene {
    pub schema_version: u32,
    pub id: String,
    pub name: String,
    pub description: String,
    pub icon: String,
    pub color: String,
    pub version: u32,
    pub is_default: bool,
    pub allow_commands_at_startup: bool,
    #[serde(default)]
    pub sensitive_action_policy: crate::policy::SensitiveActionPolicy,
    pub workflow: Workflow,
    #[serde(default)]
    pub parameters: Vec<Parameter>,
    #[serde(default)]
    pub triggers: Vec<Trigger>,
    #[serde(default)]
    pub concurrent_run_policy: ConcurrentRunPolicy,
    #[serde(default = "default_parallel")]
    pub max_parallel: usize,
    pub created_at: String,
    pub updated_at: String,
}
impl Scene {
    pub fn new(name: &str) -> Self {
        Self {
            schema_version: SCHEMA_VERSION,
            id: id(),
            name: name.into(),
            description: String::new(),
            icon: "code".into(),
            color: "violet".into(),
            version: 0,
            is_default: false,
            allow_commands_at_startup: false,
            sensitive_action_policy: crate::policy::SensitiveActionPolicy::default(),
            workflow: Workflow::default(),
            parameters: vec![],
            triggers: vec![],
            concurrent_run_policy: ConcurrentRunPolicy::default(),
            max_parallel: default_parallel(),
            created_at: now(),
            updated_at: now(),
        }
    }
}
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Workflow {
    pub nodes: Vec<Node>,
    pub edges: Vec<Edge>,
    #[serde(default)]
    pub annotations: Vec<CanvasAnnotation>,
}

fn default_parallel() -> usize {
    8
}
pub fn success_outlet() -> String {
    "success".into()
}
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ConcurrentRunPolicy {
    #[default]
    Ignore,
    Restart,
    Queue,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Parameter {
    pub name: String,
    pub kind: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub required: bool,
    #[serde(default)]
    pub default_value: Value,
    #[serde(default)]
    pub options: Vec<String>,
    #[serde(default)]
    pub validation: ParameterValidation,
}
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ParameterValidation {
    pub min: Option<f64>,
    pub max: Option<f64>,
    pub pattern: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Trigger {
    pub id: String,
    pub kind: String,
    pub enabled: bool,
    #[serde(default)]
    pub config: Value,
    #[serde(default)]
    pub parameters: BTreeMap<String, Value>,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CanvasAnnotation {
    pub id: String,
    pub kind: String,
    pub text: String,
    pub position: Position,
    pub width: f64,
    pub height: f64,
    #[serde(default)]
    pub node_ids: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Node {
    pub id: String,
    #[serde(rename = "type")]
    pub node_type: String,
    pub name: String,
    pub description: String,
    pub position: Position,
    pub enabled: bool,
    pub config: Value,
    pub retry_policy: RetryPolicy,
    pub timeout_ms: u64,
    pub failure_policy: FailurePolicy,
    pub platform_constraint: Vec<String>,
    pub inputs: BTreeMap<String, Value>,
    pub outputs: BTreeMap<String, Value>,
    pub metadata: BTreeMap<String, Value>,
}
impl Node {
    pub fn new(node_type: &str, name: &str, config: Value) -> Self {
        Self {
            id: id(),
            node_type: node_type.into(),
            name: name.into(),
            description: String::new(),
            position: Position::default(),
            enabled: true,
            config,
            retry_policy: RetryPolicy::default(),
            timeout_ms: 60_000,
            failure_policy: FailurePolicy::StopWorkflow,
            platform_constraint: vec![],
            inputs: BTreeMap::new(),
            outputs: BTreeMap::new(),
            metadata: BTreeMap::new(),
        }
    }
}
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Position {
    pub x: f64,
    pub y: f64,
}
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RetryPolicy {
    pub max_retries: u32,
    pub delay_ms: u64,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum FailurePolicy {
    StopWorkflow,
    SkipAndContinue,
    AskUser,
    FailureBranch,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Edge {
    pub id: String,
    pub from: String,
    pub to: String,
    #[serde(default = "success_outlet")]
    pub outlet: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ApplicationProfile {
    pub schema_version: u32,
    pub id: String,
    pub display_name: String,
    pub windows: WindowsBinding,
    pub macos: MacosBinding,
    pub launch_arguments: Vec<String>,
    pub ready_detection: Option<ReadyDetection>,
}
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WindowsBinding {
    pub executable: String,
    pub process_name: String,
    #[serde(default)]
    pub run_as_administrator: bool,
    #[serde(default)]
    pub use_preauthorized_task: bool,
}
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MacosBinding {
    pub app_path: String,
    pub bundle_id: String,
    pub process_name: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub enum ReadyDetection {
    #[serde(rename_all = "camelCase")]
    Process {
        process_name: String,
    },
    Port {
        host: String,
        port: u16,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum RunStatus {
    Queued,
    Running,
    Paused,
    Succeeded,
    Failed,
    Cancelled,
    Interrupted,
}
impl RunStatus {
    pub fn is_active(&self) -> bool {
        matches!(self, Self::Queued | Self::Running | Self::Paused)
    }
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum NodeStatus {
    Pending,
    Queued,
    Waiting,
    Running,
    Succeeded,
    Failed,
    Skipped,
    Cancelled,
    Paused,
    Retrying,
}
impl NodeStatus {
    pub fn satisfies_dependency(&self) -> bool {
        matches!(self, Self::Succeeded | Self::Skipped)
    }
    pub fn is_active(&self) -> bool {
        matches!(
            self,
            Self::Running | Self::Waiting | Self::Retrying | Self::Paused
        )
    }
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NodeRun {
    pub node_id: String,
    pub name: String,
    pub status: NodeStatus,
    pub started_at: Option<String>,
    pub ended_at: Option<String>,
    pub duration_ms: u64,
    pub retry_count: u32,
    pub message: String,
    pub stdout: String,
    pub stderr: String,
    pub error: Option<String>,
    #[serde(default)]
    pub output: Value,
    #[serde(default)]
    pub outlet: Option<String>,
    #[serde(default)]
    pub reused_from: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Run {
    pub id: String,
    pub scene_id: String,
    pub scene_name: String,
    pub scene_version: u32,
    pub scene_snapshot: Scene,
    pub status: RunStatus,
    pub source: String,
    #[serde(default)]
    pub trigger_id: Option<String>,
    pub started_at: String,
    pub ended_at: Option<String>,
    pub duration_ms: u64,
    pub revision: u64,
    pub node_runs: Vec<NodeRun>,
    pub error: Option<String>,
    #[serde(default)]
    pub parameter_snapshot: BTreeMap<String, Value>,
    #[serde(default)]
    pub subflow_snapshots: BTreeMap<String, Scene>,
    #[serde(default)]
    pub profiles_snapshot: Vec<ApplicationProfile>,
    #[serde(default)]
    pub parent_run_id: Option<String>,
    #[serde(default)]
    pub parent_node_id: Option<String>,
    #[serde(default)]
    pub resumed_from: Option<String>,
}
impl Run {
    pub fn new(scene: Scene, source: &str) -> Self {
        let node_runs = scene
            .workflow
            .nodes
            .iter()
            .map(|n| NodeRun {
                node_id: n.id.clone(),
                name: n.name.clone(),
                status: NodeStatus::Pending,
                started_at: None,
                ended_at: None,
                duration_ms: 0,
                retry_count: 0,
                message: String::new(),
                stdout: String::new(),
                stderr: String::new(),
                error: None,
                output: Value::Null,
                outlet: None,
                reused_from: None,
            })
            .collect();
        Self {
            id: id(),
            scene_id: scene.id.clone(),
            scene_name: scene.name.clone(),
            scene_version: scene.version,
            scene_snapshot: scene,
            status: RunStatus::Running,
            source: source.into(),
            trigger_id: None,
            started_at: now(),
            ended_at: None,
            duration_ms: 0,
            revision: 0,
            node_runs,
            error: None,
            parameter_snapshot: BTreeMap::new(),
            subflow_snapshots: BTreeMap::new(),
            profiles_snapshot: vec![],
            parent_run_id: None,
            parent_node_id: None,
            resumed_from: None,
        }
    }
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunEvent {
    pub kind: String,
    pub run: Run,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Settings {
    pub schema_version: u32,
    pub theme: String,
    pub startup_delay_seconds: u64,
    pub notifications: bool,
    pub retention_days: u32,
}
impl Default for Settings {
    fn default() -> Self {
        Self {
            schema_version: 1,
            theme: "system".into(),
            startup_delay_seconds: 5,
            notifications: true,
            retention_days: 30,
        }
    }
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ValidationIssue {
    pub node_id: Option<String>,
    pub message: String,
}
