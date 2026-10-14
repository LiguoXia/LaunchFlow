use crate::{model::*, platform::PlatformAdapter, Error, Result};
use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{collections::BTreeMap, path::Path, sync::Arc, time::Duration};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Field {
    pub key: String,
    pub label: String,
    pub kind: String,
    pub required: bool,
    pub options: Vec<String>,
    pub hint: String,
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NodeDefinition {
    pub node_type: String,
    pub name: String,
    pub description: String,
    pub category: String,
    pub fields: Vec<Field>,
    pub defaults: Value,
    pub waiting: bool,
}
#[derive(Default)]
pub struct NodeOutput {
    pub message: String,
    pub stdout: String,
    pub stderr: String,
    pub output: Value,
    pub outlet: Option<String>,
}
pub struct NodeContext {
    pub diagnostics: Arc<std::sync::Mutex<crate::automation::Diagnostic>>,
    pub platform: Arc<dyn PlatformAdapter>,
    pub profiles: Vec<ApplicationProfile>,
    pub subflows: Option<Arc<dyn SubflowExecutor>>,
}
#[async_trait]
pub trait SubflowExecutor: Send + Sync {
    async fn execute(
        &self,
        scene_id: &str,
        parameters: BTreeMap<String, Value>,
    ) -> Result<NodeOutput>;
}
#[async_trait]
pub trait NodeRunner: Send + Sync {
    fn definition(&self) -> NodeDefinition;
    fn validate(&self, config: &Value) -> Result<()>;
    async fn run(&self, config: &Value, ctx: &NodeContext) -> Result<NodeOutput>;
    async fn failure_diagnostics(
        &self,
        _config: &Value,
        _ctx: &NodeContext,
        _error: &Error,
    ) -> Option<Value> {
        None
    }
}
pub struct NodeRegistry {
    runners: BTreeMap<String, Arc<dyn NodeRunner>>,
}
impl Default for NodeRegistry {
    fn default() -> Self {
        Self::builtins()
    }
}
impl NodeRegistry {
    pub fn builtins() -> Self {
        let mut registry = Self {
            runners: BTreeMap::new(),
        };
        registry
            .register(Arc::new(LaunchRunner))
            .expect("unique builtin");
        for kind in ["file", "folder", "url"] {
            registry
                .register(Arc::new(OpenRunner(kind)))
                .expect("unique builtin");
        }
        registry
            .register(Arc::new(DelayRunner))
            .expect("unique builtin");
        registry
            .register(Arc::new(CommandRunner))
            .expect("unique builtin");
        registry
            .register(Arc::new(ProcessRunner))
            .expect("unique builtin");
        registry
            .register(Arc::new(PortRunner))
            .expect("unique builtin");
        for runner in crate::workflow_nodes::runners() {
            registry.register(runner).expect("unique builtin");
        }
        for runner in crate::automation::runner::runners() {
            registry.register(runner).expect("unique GUI runner");
        }
        registry
            .register(Arc::new(crate::clipboard::CopyTextRunner))
            .expect("unique clipboard runner");
        registry
            .register(Arc::new(crate::workspace::RestoreRunner))
            .expect("unique workspace runner");
        registry
    }
    pub fn register(&mut self, runner: Arc<dyn NodeRunner>) -> Result<()> {
        let key = runner.definition().node_type;
        if self.runners.contains_key(&key) {
            return Err(Error::Validation(format!("Duplicate node type: {key}")));
        }
        self.runners.insert(key, runner);
        Ok(())
    }
    pub fn runner(&self, kind: &str) -> Result<Arc<dyn NodeRunner>> {
        self.runners
            .get(kind)
            .cloned()
            .ok_or_else(|| Error::Validation(format!("Unknown node type: {kind}")))
    }
    pub fn definitions(&self) -> Vec<NodeDefinition> {
        self.runners.values().map(|r| r.definition()).collect()
    }
}
pub(crate) fn field(key: &str, label: &str, kind: &str, required: bool, hint: &str) -> Field {
    Field {
        key: key.into(),
        label: label.into(),
        kind: kind.into(),
        required,
        options: vec![],
        hint: hint.into(),
    }
}
pub(crate) fn required(value: &str, name: &str) -> Result<()> {
    if value.trim().is_empty() || value.contains('\0') {
        return Err(Error::Validation(format!(
            "{name} is required and cannot contain NUL"
        )));
    }
    Ok(())
}
fn done(message: impl Into<String>) -> NodeOutput {
    NodeOutput {
        message: message.into(),
        ..Default::default()
    }
}
pub(crate) fn definition(
    kind: &str,
    name: &str,
    description: &str,
    category: &str,
    fields: Vec<Field>,
    defaults: Value,
    waiting: bool,
) -> NodeDefinition {
    NodeDefinition {
        node_type: kind.into(),
        name: name.into(),
        description: description.into(),
        category: category.into(),
        fields,
        defaults,
        waiting,
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct LaunchConfig {
    application_id: String,
    arguments: Vec<String>,
    already_running: String,
}
struct LaunchRunner;
#[async_trait]
impl NodeRunner for LaunchRunner {
    fn definition(&self) -> NodeDefinition {
        let mut running = field(
            "alreadyRunning",
            "应用已运行时",
            "select",
            true,
            "跳过重复启动，仍检查 Ready 条件",
        );
        running.options = vec!["skip".into(), "newInstance".into()];
        definition(
            "application.launch",
            "启动应用",
            "通过应用配置启动，并等待就绪条件",
            "application",
            vec![
                field(
                    "applicationId",
                    "应用",
                    "application",
                    true,
                    "先在应用库中绑定本机路径",
                ),
                field(
                    "arguments",
                    "启动参数",
                    "arguments",
                    false,
                    "每行一个参数，无需额外引号",
                ),
                running,
            ],
            json!({"applicationId":"","arguments":[],"alreadyRunning":"skip"}),
            false,
        )
    }
    fn validate(&self, config: &Value) -> Result<()> {
        let c: LaunchConfig = serde_json::from_value(config.clone())?;
        required(&c.application_id, "Application")?;
        if !["skip", "newInstance"].contains(&c.already_running.as_str()) {
            return Err(Error::Validation(
                "Unsupported already-running policy".into(),
            ));
        }
        Ok(())
    }
    async fn run(&self, config: &Value, ctx: &NodeContext) -> Result<NodeOutput> {
        let c: LaunchConfig = serde_json::from_value(config.clone())?;
        let profile = ctx
            .profiles
            .iter()
            .find(|p| p.id == c.application_id)
            .ok_or_else(|| Error::Validation("Missing application profile".into()))?;
        let name = if ctx.platform.os() == "windows" {
            &profile.windows.process_name
        } else {
            &profile.macos.process_name
        };
        let exists = c.already_running == "skip"
            && !name.is_empty()
            && ctx.platform.process_exists(name).await?;
        if !exists {
            ctx.platform.launch(profile, &c.arguments).await?;
        }
        if let Some(ready) = &profile.ready_detection {
            wait_ready(ready, ctx).await?;
            return Ok(done("Application ready"));
        }
        Ok(done(if exists {
            "Already running; launch skipped"
        } else {
            "Launch requested (no readiness condition configured)"
        }))
    }
}
struct OpenRunner(&'static str);
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct TargetConfig {
    target: String,
}
#[async_trait]
impl NodeRunner for OpenRunner {
    fn definition(&self) -> NodeDefinition {
        let (name, label, hint) = match self.0 {
            "file" => ("打开文件", "文件路径", "使用系统默认关联"),
            "folder" => ("打开文件夹", "文件夹路径", "在系统文件管理器中打开"),
            _ => ("打开网页", "URL", "仅接受 http:// 或 https://"),
        };
        definition(
            &format!("application.open.{}", self.0),
            name,
            hint,
            "application",
            vec![field("target", label, self.0, true, hint)],
            json!({"target":""}),
            false,
        )
    }
    fn validate(&self, config: &Value) -> Result<()> {
        let c: TargetConfig = serde_json::from_value(config.clone())?;
        required(&c.target, "Target")?;
        if self.0 == "url" {
            let url =
                url::Url::parse(&c.target).map_err(|_| Error::Validation("Invalid URL".into()))?;
            if !["http", "https"].contains(&url.scheme())
                || url.host_str().is_none()
                || !url.username().is_empty()
                || url.password().is_some()
            {
                return Err(Error::Validation(
                    "Only HTTP(S) URLs without embedded credentials are allowed".into(),
                ));
            }
        }
        Ok(())
    }
    async fn run(&self, config: &Value, ctx: &NodeContext) -> Result<NodeOutput> {
        self.validate(config)?;
        let c: TargetConfig = serde_json::from_value(config.clone())?;
        if self.0 == "file" && !Path::new(&c.target).is_file() {
            return Err(Error::Validation("File does not exist".into()));
        }
        if self.0 == "folder" && !Path::new(&c.target).is_dir() {
            return Err(Error::Validation("Directory does not exist".into()));
        }
        ctx.platform.open_target(&c.target).await?;
        Ok(done("Opened with the system default application"))
    }
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DelayConfig {
    duration_ms: u64,
}
struct DelayRunner;
#[async_trait]
impl NodeRunner for DelayRunner {
    fn definition(&self) -> NodeDefinition {
        definition(
            "system.delay",
            "等待时长",
            "有意延迟；服务启动请使用 Ready 检测",
            "system",
            vec![field(
                "durationMs",
                "时长（毫秒）",
                "number",
                true,
                "例如 1000 = 1 秒",
            )],
            json!({"durationMs":1000}),
            true,
        )
    }
    fn validate(&self, config: &Value) -> Result<()> {
        let c: DelayConfig = serde_json::from_value(config.clone())?;
        if c.duration_ms > 86_400_000 {
            return Err(Error::Validation("Delay must be at most 24 hours".into()));
        }
        Ok(())
    }
    async fn run(&self, config: &Value, _: &NodeContext) -> Result<NodeOutput> {
        let c: DelayConfig = serde_json::from_value(config.clone())?;
        tokio::time::sleep(Duration::from_millis(c.duration_ms)).await;
        Ok(done("Delay complete"))
    }
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CommandConfig {
    program: String,
    arguments: Vec<String>,
    cwd: String,
    capture_output: bool,
}
struct CommandRunner;
#[async_trait]
impl NodeRunner for CommandRunner {
    fn definition(&self) -> NodeDefinition {
        definition(
            "system.command",
            "运行命令",
            "以普通用户运行程序，参数逐项传递",
            "system",
            vec![
                field(
                    "program",
                    "程序",
                    "file",
                    true,
                    "可执行文件或 PATH 中的命令，例如 git",
                ),
                field(
                    "arguments",
                    "参数",
                    "arguments",
                    false,
                    "每行一个参数；脚本须显式选择解释器",
                ),
                field(
                    "cwd",
                    "工作目录",
                    "folder",
                    false,
                    "留空使用 LaunchFlow 的工作目录",
                ),
                field(
                    "captureOutput",
                    "保存输出",
                    "boolean",
                    false,
                    "仅用于不包含敏感内容的命令；默认不采集输出",
                ),
            ],
            json!({"program":"","arguments":[],"cwd":"","captureOutput":false}),
            false,
        )
    }
    fn validate(&self, config: &Value) -> Result<()> {
        let c: CommandConfig = serde_json::from_value(config.clone())?;
        required(&c.program, "Program")?;
        if c.arguments.iter().any(|s| s.contains('\0')) {
            return Err(Error::Validation("Arguments cannot contain NUL".into()));
        }
        Ok(())
    }
    async fn run(&self, config: &Value, ctx: &NodeContext) -> Result<NodeOutput> {
        let c: CommandConfig = serde_json::from_value(config.clone())?;
        let output = ctx
            .platform
            .command(&c.program, &c.arguments, Some(&c.cwd), c.capture_output)
            .await?;
        if output.code != 0 {
            return Err(Error::Runtime(format!(
                "Command exited with code {}{}",
                output.code,
                if output.stderr.is_empty() {
                    String::new()
                } else {
                    format!(": {}", redact(&output.stderr))
                }
            )));
        }
        Ok(NodeOutput {
            message: "Command completed (exit 0)".into(),
            stdout: redact(&output.stdout),
            stderr: redact(&output.stderr),
            output: json!({"exitCode":output.code,"stdout":redact(&output.stdout),"stderr":redact(&output.stderr)}),
            outlet: None,
        })
    }
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ProcessConfig {
    process_name: String,
}
struct ProcessRunner;
#[async_trait]
impl NodeRunner for ProcessRunner {
    fn definition(&self) -> NodeDefinition {
        definition(
            "wait.process",
            "等待进程",
            "等待精确进程名出现",
            "wait",
            vec![field(
                "processName",
                "进程名",
                "text",
                true,
                "Windows 示例 idea64.exe；macOS 示例 idea",
            )],
            json!({"processName":""}),
            true,
        )
    }
    fn validate(&self, config: &Value) -> Result<()> {
        let c: ProcessConfig = serde_json::from_value(config.clone())?;
        required(&c.process_name, "Process name")
    }
    async fn run(&self, config: &Value, ctx: &NodeContext) -> Result<NodeOutput> {
        let c: ProcessConfig = serde_json::from_value(config.clone())?;
        wait_ready(
            &ReadyDetection::Process {
                process_name: c.process_name,
            },
            ctx,
        )
        .await?;
        Ok(done("Process detected"))
    }
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct PortConfig {
    host: String,
    port: u16,
}
struct PortRunner;
#[async_trait]
impl NodeRunner for PortRunner {
    fn definition(&self) -> NodeDefinition {
        definition(
            "wait.port",
            "等待端口",
            "TCP 连接成功后继续执行",
            "wait",
            vec![
                field("host", "主机", "text", true, "本机使用 127.0.0.1"),
                field("port", "端口", "number", true, "1–65535"),
            ],
            json!({"host":"127.0.0.1","port":8080}),
            true,
        )
    }
    fn validate(&self, config: &Value) -> Result<()> {
        let c: PortConfig = serde_json::from_value(config.clone())?;
        required(&c.host, "Host")?;
        if c.port == 0 {
            return Err(Error::Validation("Port must be between 1 and 65535".into()));
        }
        Ok(())
    }
    async fn run(&self, config: &Value, ctx: &NodeContext) -> Result<NodeOutput> {
        let c: PortConfig = serde_json::from_value(config.clone())?;
        wait_ready(
            &ReadyDetection::Port {
                host: c.host,
                port: c.port,
            },
            ctx,
        )
        .await?;
        Ok(done("TCP port ready"))
    }
}
pub async fn wait_ready(ready: &ReadyDetection, ctx: &NodeContext) -> Result<()> {
    loop {
        let success = match ready {
            ReadyDetection::Process { process_name } => {
                ctx.platform.process_exists(process_name).await?
            }
            ReadyDetection::Port { host, port } => matches!(
                tokio::time::timeout(
                    Duration::from_secs(1),
                    tokio::net::TcpStream::connect((host.as_str(), *port))
                )
                .await,
                Ok(Ok(_))
            ),
        };
        if success {
            return Ok(());
        }
        tokio::time::sleep(Duration::from_millis(750)).await;
    }
}
/// Best-effort diagnostic redaction. Output capture is opt-in; this is not a secret vault.
pub fn redact(text: &str) -> String {
    text.lines()
        .map(|line| {
            let lower = line.to_ascii_lowercase();
            if [
                "password",
                "passwd",
                "secret",
                "token",
                "api_key",
                "apikey",
                "authorization",
                "private key",
            ]
            .iter()
            .any(|key| lower.contains(key))
            {
                "[sensitive diagnostic line redacted]".to_string()
            } else {
                line.to_string()
            }
        })
        .collect::<Vec<_>>()
        .join("\n")
}
