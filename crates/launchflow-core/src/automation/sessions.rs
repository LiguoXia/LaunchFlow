use super::*;
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::{sync::Mutex, time::Duration};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    sync::{broadcast, mpsc},
};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionState {
    pub id: String,
    pub mode: String,
    pub status: String,
    pub element: Value,
    pub locator: Value,
    pub actions: Vec<Value>,
    #[serde(default)]
    pub reviewed: bool,
    pub error: Option<AutomationError>,
}

pub struct SessionManager {
    paths: AutomationPaths,
    state: Mutex<Option<SessionState>>,
    control: Mutex<Option<mpsc::Sender<String>>>,
    events: broadcast::Sender<SessionState>,
}
impl SessionManager {
    pub fn new(paths: AutomationPaths) -> Arc<Self> {
        let (events, _) = broadcast::channel(32);
        Arc::new(Self {
            paths,
            state: Mutex::new(None),
            control: Mutex::new(None),
            events,
        })
    }
    pub fn subscribe(&self) -> broadcast::Receiver<SessionState> {
        self.events.subscribe()
    }
    pub fn current(&self) -> Option<SessionState> {
        self.state.lock().ok().and_then(|s| s.clone())
    }
    pub fn acknowledge_recording(&self, id: &str) -> AutomationResult<()> {
        let mut current = self
            .state
            .lock()
            .map_err(|_| AutomationError::new("unavailable", "Recording state unavailable"))?;
        if let Some(state) = current.as_mut().filter(|s| s.id == id) {
            if state.mode != "record" || state.status != "stopped" {
                return Err(AutomationError::new(
                    "sessionActive",
                    "Stop the recording before reviewing it",
                ));
            }
            state.reviewed = true;
            state.actions.clear();
            let _ = self.events.send(state.clone());
        }
        // A stale review must never acknowledge or interrupt a newer recording.
        Ok(())
    }
    fn publish(&self, change: impl FnOnce(&mut SessionState)) {
        if let Ok(mut current) = self.state.lock() {
            if let Some(state) = current.as_mut() {
                change(state);
                let _ = self.events.send(state.clone());
            }
        }
    }
    pub fn control(&self, operation: &str) -> AutomationResult<()> {
        if !["stop", "pause", "resume"].contains(&operation) {
            return Err(AutomationError::new(
                "invalidRequest",
                "Unknown session control",
            ));
        }
        self.control
            .lock()
            .unwrap()
            .as_ref()
            .ok_or_else(|| AutomationError::new("sessionStopped", "No active input session"))?
            .try_send(operation.into())
            .map_err(|_| AutomationError::new("sessionStopped", "Input session has stopped"))
    }
    pub fn start(
        self: &Arc<Self>,
        mode: &str,
        window: WindowLocator,
    ) -> AutomationResult<SessionState> {
        if !["pick", "record"].contains(&mode) || mode == "record" && window.is_empty() {
            return Err(AutomationError::new(
                "invalidRequest",
                "Recording must target one application/window",
            ));
        }
        let mut active = self.control.lock().unwrap();
        if active.is_some() {
            return Err(AutomationError::new(
                "sessionActive",
                "Stop the current picker/recorder first",
            ));
        }
        let mut child = super::bridge::command(&self.paths)?.spawn().map_err(|_| {
            AutomationError::new("workerUnavailable", "Could not start input session")
        })?;
        #[cfg(windows)]
        let scope = crate::platform::windows::CommandScope::attach(&child).map_err(|_| {
            AutomationError::new(
                "workerUnavailable",
                "Could not manage recording worker lifetime",
            )
        })?;
        let (mut tx, mut rx) = (
            child.stdin.take().unwrap(),
            BufReader::new(child.stdout.take().unwrap()).lines(),
        );
        let (sender, mut commands) = mpsc::channel::<String>(8);
        *active = Some(sender);
        drop(active);
        let state = SessionState {
            id: crate::model::id(),
            mode: mode.into(),
            status: "starting".into(),
            element: Value::Null,
            locator: Value::Null,
            actions: vec![],
            reviewed: false,
            error: None,
        };
        *self.state.lock().unwrap() = Some(state.clone());
        let manager = self.clone();
        let initial = json!({"op":mode,"window":window}).to_string() + "\n";
        tokio::spawn(async move {
            #[cfg(windows)]
            let _scope = scope;
            let mut stop_at: Option<tokio::time::Instant> = None;
            let mut started = false;
            let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
            if tx.write_all(initial.as_bytes()).await.is_err() {
                manager.publish(|s| {
                    s.status = "failed".into();
                    s.error = Some(AutomationError::new(
                        "workerUnavailable",
                        "Input session did not start",
                    ));
                });
            } else {
                loop {
                    tokio::select! {
                        command = commands.recv() => {
                            let Some(operation) = command else { break };
                            let line = json!({"op":operation}).to_string() + "\n";
                            let _ = tx.write_all(line.as_bytes()).await;
                            if operation == "stop" {
                                stop_at = Some(tokio::time::Instant::now() + Duration::from_secs(2));
                            }
                        }
                        line = rx.next_line() => {
                            let Ok(Some(line)) = line else { break };
                            if line.len() >= 2 * 1024 * 1024 { break; }
                            let Ok(event) = serde_json::from_str::<Value>(&line) else { break };
                            if event["ok"] == false {
                                manager.publish(|s| {
                                    s.status = "failed".into();
                                    s.error = serde_json::from_value(event["error"].clone()).ok();
                                });
                                break;
                            }
                            match event["event"].as_str().unwrap_or("") {
                                "state" => {
                                    started = true;
                                    manager.publish(|s| s.status = event["state"].as_str().unwrap_or("recording").into());
                                }
                                "hover" => manager.publish(|s| s.element = event["element"].clone()),
                                "selected" => manager.publish(|s| {
                                    s.element = event["element"].clone();
                                    s.locator = event["locator"].clone();
                                    s.status = "selected".into();
                                }),
                                "actions" => {
                                    manager.publish(|s| s.actions = event["actions"].as_array().cloned().unwrap_or_default().into_iter().take(256).collect());
                                    if event["actions"].as_array().is_some_and(|a| a.len() >= 256) {
                                        let _ = tx.write_all(b"{\"op\":\"stop\"}\n").await;
                                        stop_at = Some(tokio::time::Instant::now() + Duration::from_secs(2));
                                    }
                                }
                                "cancelled" => manager.publish(|s| s.status = "cancelled".into()),
                                "stopped" => {
                                    manager.publish(|s| {
                                        if s.status != "selected" && s.status != "cancelled" {
                                            s.status = "stopped".into();
                                        }
                                        if let Some(actions) = event["actions"].as_array() {
                                            s.actions = actions.iter().take(256).cloned().collect();
                                        }
                                    });
                                    break;
                                }
                                _ => {}
                            }
                        }
                        _ = tokio::time::sleep(Duration::from_millis(150)) => {
                            if stop_at.is_some_and(|d| tokio::time::Instant::now() >= d) { break; }
                            if !started && tokio::time::Instant::now() >= deadline {
                                manager.publish(|s| {
                                    s.status = "failed".into();
                                    s.error = Some(AutomationError::new("permissionDenied", "Native input session did not become ready; inspect system permissions"));
                                });
                                break;
                            }
                        }
                    }
                }
            }
            let _ = child.kill().await;
            let _ = child.wait().await;
            manager.publish(|s| {
                if ["starting", "recording", "paused", "picking"].contains(&s.status.as_str()) {
                    s.status = "stopped".into();
                }
            });
            *manager.control.lock().unwrap() = None;
        });
        Ok(state)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn recording(id: &str, status: &str) -> SessionState {
        SessionState {
            id: id.into(),
            mode: "record".into(),
            status: status.into(),
            element: Value::Null,
            locator: Value::Null,
            actions: vec![json!({"kind":"click"})],
            reviewed: false,
            error: None,
        }
    }
    #[test]
    fn completed_review_is_consumed_and_cannot_clear_another_or_active_recording() {
        let manager = SessionManager::new(AutomationPaths::default());
        let mut events = manager.subscribe();
        *manager.state.lock().unwrap() = Some(recording("first", "stopped"));
        manager.acknowledge_recording("first").unwrap();
        let event = events.try_recv().unwrap();
        assert!(event.reviewed && event.actions.is_empty());
        assert!(manager.current().unwrap().reviewed);
        manager.acknowledge_recording("first").unwrap();
        *manager.state.lock().unwrap() = Some(recording("new", "recording"));
        manager.acknowledge_recording("first").unwrap();
        assert!(!manager.current().unwrap().reviewed);
        assert!(manager.acknowledge_recording("new").is_err());
        assert_eq!(manager.current().unwrap().actions.len(), 1);
    }
}
