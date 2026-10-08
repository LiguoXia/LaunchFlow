use crate::{parameters::Values, registry::*, Error, Result};
use async_trait::async_trait;
use chrono::{Datelike, Local, NaiveTime};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{path::Path, sync::Arc, time::Duration};

pub fn runners() -> Vec<Arc<dyn NodeRunner>> {
    vec![
        Arc::new(ConditionRunner),
        Arc::new(JoinRunner),
        Arc::new(SubflowRunner),
    ]
}
pub async fn tcp_available(host: &str, port: u16) -> bool {
    matches!(
        tokio::time::timeout(
            Duration::from_secs(2),
            tokio::net::TcpStream::connect((host, port))
        )
        .await,
        Ok(Ok(_))
    )
}
#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase", deny_unknown_fields, default)]
pub struct ConditionConfig {
    pub kind: String,
    pub value: String,
    pub host: String,
    pub port: u16,
    pub url: String,
    pub expected_status: Option<u16>,
    pub program: String,
    pub arguments: Vec<String>,
    pub exit_code: i32,
    pub start: String,
    pub end: String,
    pub weekdays: Vec<u32>,
    pub count: u32,
}
struct ConditionRunner;
#[async_trait]
impl NodeRunner for ConditionRunner {
    fn definition(&self) -> NodeDefinition {
        let mut kind = field("kind", "条件类型", "select", true, "true / false 分支");
        kind.options = [
            "os",
            "process",
            "window",
            "file",
            "directory",
            "tcp",
            "http",
            "environment",
            "command",
            "time",
            "weekday",
            "network",
            "monitors",
            "power",
        ]
        .map(str::to_string)
        .to_vec();
        definition(
            "flow.condition",
            "条件分支",
            "检测系统状态，选择 true 或 false 出口",
            "flow",
            vec![
                kind,
                field(
                    "value",
                    "匹配值",
                    "text",
                    false,
                    "OS: windows/macos；进程名、窗口标题、路径、环境变量名或 ac/battery",
                ),
                field("host", "主机", "text", false, "TCP / 网络检测的目标主机"),
                field(
                    "port",
                    "端口",
                    "number",
                    false,
                    "网络可用指可连接此 TCP 端点",
                ),
                field(
                    "url",
                    "HTTP URL",
                    "text",
                    false,
                    "仅 http/https；不保存响应正文",
                ),
                field("expectedStatus", "HTTP 状态码", "number", false, "例如 200"),
                field("program", "程序", "file", false, "命令结果检测"),
                field("arguments", "参数", "arguments", false, "每行一个参数"),
                field("exitCode", "预期退出码", "number", false, "0 表示成功"),
                field("start", "开始时间", "text", false, "本地时间 HH:mm"),
                field("end", "结束时间", "text", false, "HH:mm；支持跨午夜"),
                field("weekdays", "星期", "json", false, "数组：1=周一 … 7=周日"),
                field("count", "显示器数量", "number", false, "精确匹配"),
            ],
            json!({"kind":"os","value":"windows","host":"1.1.1.1","port":443,"url":"https://example.com","expectedStatus":200,"program":"","arguments":[],"exitCode":0,"start":"09:00","end":"18:00","weekdays":[1,2,3,4,5],"count":1}),
            false,
        )
    }
    fn validate(&self, config: &Value) -> Result<()> {
        let c: ConditionConfig = serde_json::from_value(config.clone())?;
        match c.kind.as_str() {
            "os" if ["windows", "macos"].contains(&c.value.as_str()) => {}
            "process" | "window" | "file" | "directory" | "environment" => {
                required(&c.value, "Condition value")?
            }
            "tcp" | "network" => {
                required(&c.host, "Host")?;
                if c.port == 0 {
                    return Err(Error::Validation("TCP port must be 1–65535".into()));
                }
            }
            "http" => {
                let url = url::Url::parse(&c.url)
                    .map_err(|_| Error::Validation("Invalid HTTP URL".into()))?;
                if !["http", "https"].contains(&url.scheme())
                    || url.host_str().is_none()
                    || !url.username().is_empty()
                    || url.password().is_some()
                    || !c.expected_status.is_some_and(|s| (100..=599).contains(&s))
                {
                    return Err(Error::Validation(
                        "HTTP condition requires a safe HTTP(S) URL and status".into(),
                    ));
                }
            }
            "command" => {
                required(&c.program, "Program")?;
                if c.arguments.iter().any(|s| s.contains('\0')) {
                    return Err(Error::Validation("NUL in command argument".into()));
                }
            }
            "time" => {
                parse_time(&c.start)?;
                parse_time(&c.end)?;
            }
            "weekday"
                if !c.weekdays.is_empty() && c.weekdays.iter().all(|d| (1..=7).contains(d)) => {}
            "monitors" => {}
            "power" if ["ac", "battery", "unknown"].contains(&c.value.as_str()) => {}
            _ => {
                return Err(Error::Validation(
                    "Unsupported condition kind or configuration".into(),
                ))
            }
        }
        Ok(())
    }
    async fn run(&self, config: &Value, ctx: &NodeContext) -> Result<NodeOutput> {
        self.validate(config)?;
        let c: ConditionConfig = serde_json::from_value(config.clone())?;
        let matched = match c.kind.as_str() {
            "os" => ctx.platform.os() == c.value,
            "process" => ctx.platform.process_exists(&c.value).await?,
            "window" => ctx.platform.window_exists(&c.value).await?,
            "file" => Path::new(&c.value).is_file(),
            "directory" => Path::new(&c.value).is_dir(),
            "tcp" | "network" => tcp_available(&c.host, c.port).await,
            "http" => reqwest::Client::builder()
                .timeout(Duration::from_secs(10))
                .redirect(reqwest::redirect::Policy::limited(5))
                .build()
                .map_err(|_| Error::Runtime("HTTP client unavailable".into()))?
                .get(&c.url)
                .send()
                .await
                .map(|r| Some(r.status().as_u16()) == c.expected_status)
                .unwrap_or(false),
            "environment" => std::env::var_os(&c.value).is_some_and(|v| !v.is_empty()),
            "command" => {
                ctx.platform
                    .command(&c.program, &c.arguments, None, false)
                    .await?
                    .code
                    == c.exit_code
            }
            "time" => {
                let time = Local::now().time();
                let start = parse_time(&c.start)?;
                let end = parse_time(&c.end)?;
                if start <= end {
                    time >= start && time < end
                } else {
                    time >= start || time < end
                }
            }
            "weekday" => c
                .weekdays
                .contains(&Local::now().weekday().number_from_monday()),
            "monitors" => ctx.platform.monitor_count().await? == c.count,
            "power" => ctx.platform.power_state().await? == c.value,
            _ => return Err(Error::Validation("Unknown condition".into())),
        };
        Ok(NodeOutput {
            message: format!("Condition: {matched}"),
            output: json!({"value":matched}),
            outlet: Some(matched.to_string()),
            ..Default::default()
        })
    }
}
pub fn parse_time(text: &str) -> Result<NaiveTime> {
    NaiveTime::parse_from_str(text, "%H:%M")
        .map_err(|_| Error::Validation("Time must use HH:mm".into()))
}
struct JoinRunner;
#[async_trait]
impl NodeRunner for JoinRunner {
    fn definition(&self) -> NodeDefinition {
        definition(
            "flow.join",
            "汇合",
            "等待所有上游结束；至少一个有效分支到达才继续",
            "flow",
            vec![],
            json!({}),
            false,
        )
    }
    fn validate(&self, config: &Value) -> Result<()> {
        if config.as_object().is_some_and(|o| o.is_empty()) {
            Ok(())
        } else {
            Err(Error::Validation(
                "Join takes an empty configuration".into(),
            ))
        }
    }
    async fn run(&self, _: &Value, _: &NodeContext) -> Result<NodeOutput> {
        Ok(NodeOutput {
            message: "Dependencies joined".into(),
            ..Default::default()
        })
    }
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SubflowConfig {
    pub scene_id: String,
    #[serde(default)]
    pub parameters: Values,
}
struct SubflowRunner;
#[async_trait]
impl NodeRunner for SubflowRunner {
    fn definition(&self) -> NodeDefinition {
        definition(
            "flow.subflow",
            "运行子流程",
            "执行另一个场景的运行快照并返回节点输出",
            "flow",
            vec![
                field("sceneId", "子场景", "scene", true, "禁止循环引用"),
                field(
                    "parameters",
                    "传入参数",
                    "json",
                    false,
                    "JSON 对象；可使用变量引用",
                ),
            ],
            json!({"sceneId":"","parameters":{}}),
            true,
        )
    }
    fn validate(&self, config: &Value) -> Result<()> {
        let c: SubflowConfig = serde_json::from_value(config.clone())?;
        required(&c.scene_id, "Subflow scene")
    }
    async fn run(&self, config: &Value, ctx: &NodeContext) -> Result<NodeOutput> {
        let c: SubflowConfig = serde_json::from_value(config.clone())?;
        ctx.subflows
            .as_ref()
            .ok_or_else(|| Error::Runtime("Subflow execution requires a workflow context".into()))?
            .execute(&c.scene_id, c.parameters)
            .await
    }
}
