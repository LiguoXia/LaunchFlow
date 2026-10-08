//! Reviewable, snapshot-scoped closing. Client input contains opaque IDs, never process IDs.
use crate::{automation::AutomationProvider, storage::Store, Error, Result};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeSet,
    time::{Duration, Instant},
};

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct NativeApp {
    executable: String,
    name: String,
    windows: Vec<String>,
    blocked: Option<String>,
    target: Value,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CloseApp {
    pub id: String,
    pub name: String,
    pub executable: String,
    pub windows: Vec<String>,
    pub selected: bool,
    pub blocked: Option<String>,
    pub state: String,
    pub message: String,
    pub can_force: bool,
    #[serde(skip)]
    key: String,
    #[serde(skip)]
    targets: Vec<Value>,
    #[serde(skip)]
    remaining: BTreeSet<usize>,
    #[serde(skip)]
    results: Vec<Value>,
}
#[derive(Clone, Debug, Serialize)]
pub struct CloseCapture {
    pub token: String,
    pub apps: Vec<CloseApp>,
}
#[derive(Default)]
pub struct WorkspaceCloser {
    capture: Option<CloseCapture>,
    captured_at: Option<Instant>,
}
fn invalid(message: &str) -> Error {
    Error::Validation(message.into())
}
impl WorkspaceCloser {
    pub async fn capture(
        &mut self,
        native: &dyn AutomationProvider,
        store: &Store,
    ) -> Result<CloseCapture> {
        let rows: Vec<NativeApp> = serde_json::from_value(
            native
                .request(json!({"op":"workspaceCloseCapture","ownerPid":std::process::id()}))
                .await
                .map_err(|e| Error::Runtime(e.message))?,
        )?;
        if rows.len() > 256 {
            return Err(invalid("应用数量超过 256，请先手动关闭部分应用。"));
        }
        let mut apps: Vec<CloseApp> = vec![];
        for row in rows {
            let path = if cfg!(windows) {
                row.executable.to_lowercase()
            } else {
                row.executable.clone()
            };
            let key = format!("app:{:x}", Sha256::digest(path.as_bytes()));
            if !path.is_empty() {
                if let Some(app) = apps.iter_mut().find(|a| a.key == key) {
                    app.windows.extend(row.windows);
                    app.targets.push(row.target);
                    if row.blocked.is_some() {
                        app.blocked = row.blocked;
                        app.selected = false;
                    }
                    continue;
                }
            }
            let selected = row.blocked.is_none()
                && store.workspace_close_value(&key)?.as_deref() != Some("false");
            apps.push(CloseApp {
                id: crate::model::id(),
                name: row.name,
                executable: row.executable,
                windows: row.windows,
                selected,
                blocked: row.blocked,
                state: "ready".into(),
                message: String::new(),
                can_force: false,
                key,
                targets: vec![row.target],
                remaining: BTreeSet::new(),
                results: vec![],
            });
        }
        apps.sort_by_key(|a| (a.blocked.is_some(), a.name.to_lowercase()));
        let capture = CloseCapture {
            token: crate::model::id(),
            apps,
        };
        self.capture = Some(capture.clone());
        self.captured_at = Some(Instant::now());
        Ok(capture)
    }
    fn current(&mut self, token: &str) -> Result<&mut CloseCapture> {
        if self
            .captured_at
            .is_none_or(|at| at.elapsed() > Duration::from_secs(900))
        {
            return Err(invalid("捕获已过期，请重新捕获。"));
        }
        self.capture
            .as_mut()
            .filter(|c| c.token == token)
            .ok_or_else(|| invalid("捕获已更新，请重新捕获。"))
    }
    pub fn select(&mut self, store: &Store, token: &str, id: &str, selected: bool) -> Result<()> {
        let app = self
            .current(token)?
            .apps
            .iter_mut()
            .find(|a| a.id == id && a.blocked.is_none())
            .ok_or_else(|| invalid("应用不可选择。"))?;
        store.set_workspace_close_value(&app.key, if selected { "true" } else { "false" })?;
        app.selected = selected;
        Ok(())
    }
    pub async fn execute(
        &mut self,
        native: &dyn AutomationProvider,
        token: &str,
        ids: &[String],
        action: &str,
        confirmed: bool,
    ) -> Result<CloseCapture> {
        if !["graceful", "status", "force"].contains(&action) || (action == "force" && !confirmed) {
            return Err(invalid("强制关闭必须单独确认。"));
        }
        let capture = self.current(token)?;
        let unique: BTreeSet<_> = ids.iter().collect();
        if ids.is_empty()
            || ids.len() != unique.len()
            || ids.iter().any(|id| {
                !capture.apps.iter().any(|a| {
                    &a.id == id
                        && a.blocked.is_none()
                        && a.selected
                        && (action != "force" || a.can_force)
                })
            })
        {
            return Err(invalid(
                "请选择本次捕获中的应用；强制关闭只允许用于正常关闭后仍在运行的应用。",
            ));
        }
        let mut targets = vec![];
        let mut mapping = vec![];
        for (ai, app) in capture
            .apps
            .iter()
            .enumerate()
            .filter(|(_, a)| ids.contains(&a.id))
        {
            for (ti, target) in app.targets.iter().enumerate() {
                if action == "force" && !app.remaining.contains(&ti) {
                    continue;
                }
                targets.push(target.clone());
                mapping.push((ai, ti));
            }
        }
        let request = |action: &str| json!({"op":"workspaceClose","ownerPid":std::process::id(),"action":action,"targets":targets});
        let mut results: Vec<Value> = serde_json::from_value(
            native
                .request(request(action))
                .await
                .map_err(|e| Error::Runtime(e.message))?,
        )?;
        if results.len() != mapping.len() {
            return Err(invalid("关闭服务返回的数据不完整，请重新捕获。"));
        }
        // Give every application its save/exit opportunity concurrently, never force on a timer.
        if action == "graceful" {
            for _ in 0..8 {
                if !results.iter().any(|r| r["state"] == "pending") {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(500)).await;
                let current: Vec<Value> = serde_json::from_value(
                    native
                        .request(request("status"))
                        .await
                        .map_err(|e| Error::Runtime(e.message))?,
                )?;
                if current.len() != results.len() {
                    return Err(invalid("关闭状态数据不完整。"));
                }
                for (old, new) in results.iter_mut().zip(current) {
                    if old["state"] == "pending" || new["state"] == "closed" {
                        *old = new;
                    }
                }
            }
        }
        for app in capture.apps.iter_mut().filter(|a| ids.contains(&a.id)) {
            if action == "graceful" {
                app.remaining.clear();
            }
        }
        for ((ai, ti), result) in mapping.iter().zip(&results) {
            let app = &mut capture.apps[*ai];
            app.results.resize(
                app.targets.len(),
                json!({"state":"ready","message":"尚未请求关闭"}),
            );
            app.results[*ti] = result.clone();
            if action == "graceful" && result["state"] == "pending" {
                app.remaining.insert(*ti);
            }
            if result["state"] != "pending" {
                app.remaining.remove(ti);
            }
        }
        for app in capture.apps.iter_mut().filter(|a| ids.contains(&a.id)) {
            let rows = &app.results;
            let result = rows
                .iter()
                .find(|r| r["state"] == "stale")
                .or_else(|| rows.iter().find(|r| r["state"] == "failed"))
                .or_else(|| rows.iter().find(|r| r["state"] == "pending"))
                .or_else(|| rows.first());
            if let Some(row) = result {
                app.state = row["state"].as_str().unwrap_or("failed").into();
                app.message = row["message"].as_str().unwrap_or("未知关闭结果").into();
            }
            app.can_force = !app.remaining.is_empty();
        }
        Ok(capture.clone())
    }
}
