//! Bounded local application diagnostics. Requests, arguments and free-text errors are never logged.
use crate::{model::Run, portable::digest, Result};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    fs,
    io::{Read, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
    sync::Mutex,
    time::Instant,
};

const LIMIT: u64 = 1_048_576;
static WRITE_LOCK: Mutex<()> = Mutex::new(());
const STAGES: &[&str] = &[
    "request.received",
    "task.lookup",
    "task.validate",
    "task.run",
    "receipt.wait",
    "receipt.validate",
    "authorization.consent",
    "authorization.revoke",
    "application.validate",
    "application.shell",
];

#[derive(Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
enum Operation {
    LaunchApplication,
    ApplicationAuthorizationStatus,
    ApplicationAuthorizationGrant,
    ApplicationAuthorizationRevoke,
    ApplicationAuthorizationRun,
    Unknown,
}
#[derive(Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum BrokerStage {
    Start,
    Write,
    Read,
    Parse,
    Response,
}
#[derive(Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
enum Outcome {
    Started,
    Succeeded,
    Failed,
    Interrupted,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Entry {
    at: chrono::DateTime<chrono::Utc>,
    request_id: uuid::Uuid,
    operation: Operation,
    outcome: Outcome,
    broker_stage: BrokerStage,
    profile: Option<String>,
    application: Option<String>,
    argument_count: usize,
    duration_ms: u64,
    os_error: Option<i32>,
    native: Value,
}
fn token(value: &Value, max: usize) -> Option<&str> {
    value.as_str().filter(|s| {
        s.len() <= max
            && s.chars()
                .all(|c| c.is_ascii_alphanumeric() || "._+`<>".contains(c))
    })
}
fn native(value: &Value) -> Value {
    let registration = &value["registration"];
    let registration_phase = registration["phase"].as_str().filter(|s| {
        [
            "读取授权请求",
            "检查管理员账户",
            "检查授权请求有效期",
            "校验应用文件",
            "创建受保护的授权目录",
            "安装受保护的启动助手",
            "连接任务计划程序",
            "创建任务文件夹",
            "构建固定启动任务",
            "保存授权配置",
            "登记计划任务",
            "核对计划任务",
        ]
        .contains(s)
    });
    let steps: Vec<_> = value["steps"]
        .as_array()
        .into_iter()
        .flatten()
        .take(32)
        .filter_map(|s| {
            let stage = s["stage"].as_str().filter(|x| STAGES.contains(x))?;
            Some(json!({"stage":stage,"elapsedMs":s["elapsedMs"].as_u64()}))
        })
        .collect();
    let frames: Vec<_> = value["frames"]
        .as_array()
        .into_iter()
        .flatten()
        .take(12)
        .filter_map(|s| token(s, 240))
        .collect();
    json!({"steps":steps,"errorCode":token(&value["errorCode"],80),"exceptionType":token(&value["exceptionType"],160),"hresult":hresult(&value["hresult"]),"frames":frames,"win32Error":value["win32Error"].as_i64(),
        "registration":{"phase":registration_phase,"exceptionType":token(&registration["exceptionType"],160),"hresult":hresult(&registration["hresult"])},
        "osVersion":value["osVersion"].as_str().filter(|s|s.len()<64 && s.chars().all(|c|c.is_ascii_digit() || c=='.')),
        "runtimeVersion":value["runtimeVersion"].as_str().filter(|s|s.len()<64 && s.chars().all(|c|c.is_ascii_digit() || c=='.'))})
}
fn hresult(value: &Value) -> Option<&str> {
    value.as_str().filter(|s| {
        s.len() == 10 && s.starts_with("0x") && s[2..].bytes().all(|b| b.is_ascii_hexdigit())
    })
}
fn folder(data: &Path) -> PathBuf {
    data.join("logs")
}
pub fn sanitize_entries(value: &Value) -> Value {
    let entries: Vec<_> = value
        .as_array()
        .into_iter()
        .flatten()
        .rev()
        .take(120)
        .filter_map(|v| {
            let mut entry: Entry = serde_json::from_value(v.clone()).ok()?;
            entry.native = native(&entry.native);
            for value in [&mut entry.profile, &mut entry.application] {
                if !value
                    .as_ref()
                    .is_some_and(|s| s.len() == 64 && s.bytes().all(|b| b.is_ascii_hexdigit()))
                {
                    *value = None;
                }
            }
            Some(entry)
        })
        .collect();
    json!(entries.into_iter().rev().collect::<Vec<_>>())
}
fn append(data: &Path, entry: &Entry) -> std::io::Result<()> {
    let _guard = WRITE_LOCK
        .lock()
        .map_err(|_| std::io::Error::other("log lock unavailable"))?;
    let folder = folder(data);
    fs::create_dir_all(&folder)?;
    let path = folder.join("application.jsonl");
    let mut line = serde_json::to_vec(entry)?;
    line.push(b'\n');
    if fs::metadata(&path).is_ok_and(|m| m.len() + line.len() as u64 > LIMIT) {
        let previous = folder.join("application.previous.jsonl");
        if previous.exists() {
            fs::remove_file(&previous)?;
        }
        fs::rename(&path, previous)?;
    }
    fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)?
        .write_all(&line)
}
pub struct RequestLog {
    data: PathBuf,
    entry: Entry,
    started: Instant,
    finished: bool,
}
impl RequestLog {
    pub fn begin(data: &Path, request: &Value) -> Self {
        let entry = Entry {
            at: chrono::Utc::now(),
            request_id: uuid::Uuid::new_v4(),
            operation: serde_json::from_value(request["op"].clone()).unwrap_or(Operation::Unknown),
            outcome: Outcome::Started,
            broker_stage: BrokerStage::Start,
            profile: request["profileId"].as_str().map(|s| digest(s.as_bytes())),
            application: request["executable"].as_str().map(|s| digest(s.as_bytes())),
            argument_count: request["arguments"].as_array().map_or(0, Vec::len),
            duration_ms: 0,
            os_error: None,
            native: Value::Null,
        };
        let _ = append(data, &entry);
        Self {
            data: data.into(),
            entry,
            started: Instant::now(),
            finished: false,
        }
    }
    pub fn stage(&mut self, stage: BrokerStage) {
        self.entry.broker_stage = stage;
    }
    pub fn response(&mut self, response: &Value) {
        self.entry.native = native(&response["diagnostics"]);
    }
    pub fn finish(&mut self, result: &Result<Value>) {
        self.finished = true;
        self.entry.outcome = if result.is_ok() {
            Outcome::Succeeded
        } else {
            Outcome::Failed
        };
        if let Err(crate::Error::Io(e)) = result {
            self.entry.os_error = e.raw_os_error();
        }
        self.write();
    }
    fn write(&mut self) {
        self.entry.at = chrono::Utc::now();
        self.entry.duration_ms = self.started.elapsed().as_millis() as u64;
        let _ = append(&self.data, &self.entry); // Disk errors must not change launch behavior.
    }
}
impl Drop for RequestLog {
    fn drop(&mut self) {
        if !self.finished {
            self.entry.outcome = Outcome::Interrupted;
            self.write();
        }
    }
}
pub fn read(data: &Path) -> Result<Value> {
    let _guard = WRITE_LOCK
        .lock()
        .map_err(|_| crate::Error::Runtime("诊断日志暂不可用".into()))?;
    let mut entries = Vec::new();
    for name in ["application.previous.jsonl", "application.jsonl"] {
        let path = folder(data).join(name);
        let mut file = match fs::File::open(path) {
            Ok(f) => f,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => continue,
            Err(e) => return Err(e.into()),
        };
        file.seek(SeekFrom::Start(
            file.metadata()?.len().saturating_sub(LIMIT),
        ))?;
        let mut bytes = Vec::new();
        file.take(LIMIT).read_to_end(&mut bytes)?;
        for line in String::from_utf8_lossy(&bytes).lines() {
            if let Ok(mut entry) = serde_json::from_str::<Entry>(line) {
                // Reapply the allowlist when exporting persisted data; ignore partial or corrupt lines.
                entry.native = native(&entry.native);
                for value in [&mut entry.profile, &mut entry.application] {
                    if !value
                        .as_ref()
                        .is_some_and(|s| s.len() == 64 && s.bytes().all(|b| b.is_ascii_hexdigit()))
                    {
                        *value = None;
                    }
                }
                entries.push(entry);
            }
        }
    }
    let first = entries.len().saturating_sub(120);
    Ok(sanitize_entries(&serde_json::to_value(&entries[first..])?))
}
pub fn report(version: &str, data: &Path, run: Option<&Run>) -> Result<String> {
    let context = run.map(|r| json!({"run":digest(r.id.as_bytes()),"status":r.status,"startedAt":crate::diagnostics::timestamp(&r.started_at),"endedAt":r.ended_at.as_deref().and_then(crate::diagnostics::timestamp),"durationMs":r.duration_ms,
        "nodes":r.node_runs.iter().map(|n| json!({"node":digest(n.node_id.as_bytes()),"status":n.status,"retryCount":n.retry_count,"durationMs":n.duration_ms,"errorCategory":n.error.as_deref().map(crate::diagnostics::category),"automation":crate::diagnostics::automation(&n.output)})).collect::<Vec<_>>()}));
    Ok(serde_json::to_string_pretty(
        &json!({"format":"LaunchFlow application diagnostics v1","appVersion":version,"os":std::env::consts::OS,"architecture":std::env::consts::ARCH,"exportedAt":crate::model::now(),"privacy":"No names, paths, arguments, credentials, input, screenshots or raw process output. Application/profile IDs are SHA-256 digests.","run":context,"events":read(data)?}),
    )?)
}
