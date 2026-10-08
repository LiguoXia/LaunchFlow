use async_trait::async_trait;
use launchflow_core::{
    automation::{
        AutomationPaths, AutomationProvider, AutomationResult, WindowLocator, WindowProvider,
    },
    storage::Store,
    workspace_close::WorkspaceCloser,
};
use serde_json::{json, Value};
use std::sync::Mutex;

struct Native {
    paths: AutomationPaths,
    calls: Mutex<Vec<Value>>,
    rows: Value,
    mode: &'static str,
}
#[async_trait]
impl WindowProvider for Native {
    async fn windows(&self) -> AutomationResult<Value> {
        Ok(json!([]))
    }
    async fn window(&self, _: &WindowLocator) -> AutomationResult<Value> {
        Ok(json!({}))
    }
}
#[async_trait]
impl AutomationProvider for Native {
    fn paths(&self) -> &AutomationPaths {
        &self.paths
    }
    async fn request(&self, v: Value) -> AutomationResult<Value> {
        self.calls.lock().unwrap().push(v.clone());
        if v["op"] == "workspaceCloseCapture" {
            return Ok(self.rows.clone());
        }
        Ok(Value::Array(v["targets"].as_array().unwrap().iter().map(|t|json!({"pid":t["pid"],"state":if v["action"]=="force" || self.mode=="closed" {"closed"}else {"failed"},"message":"fixture"})).collect()))
    }
}
fn native(mode: &'static str) -> Native {
    Native {
        paths: AutomationPaths::default(),
        calls: Mutex::new(vec![]),
        mode,
        rows: json!([
            {"name":"Fixture","executable":"/app/one.exe","windows":["one"],"blocked":null,"target":{"pid":50,"started":"a"}},
            {"name":"Fixture","executable":"/app/one.exe","windows":["two"],"blocked":null,"target":{"pid":51,"started":"b"}},
            {"name":"Protected","executable":"/app/protected.exe","windows":["system"],"blocked":"protected","target":{"pid":1,"started":"c"}}
        ]),
    }
}
#[tokio::test]
async fn selections_survive_capture_disappearance_and_database_restart() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("store.db");
    let store = Store::open(&path).unwrap();
    let mut closer = WorkspaceCloser::default();
    let mut native = native("closed");
    let first = closer.capture(&native, &store).await.unwrap();
    assert_eq!(first.apps.len(), 2);
    assert_eq!(first.apps[0].windows.len(), 2);
    closer
        .select(&store, &first.token, &first.apps[0].id, false)
        .unwrap();
    let rows = native.rows.clone();
    native.rows = json!([]);
    closer.capture(&native, &store).await.unwrap();
    drop(store);
    native.rows = rows;
    let store = Store::open(&path).unwrap();
    let mut closer = WorkspaceCloser::default();
    let next = closer.capture(&native, &store).await.unwrap();
    assert!(!next.apps[0].selected);
    closer
        .select(&store, &next.token, &next.apps[0].id, true)
        .unwrap();
    assert!(closer.capture(&native, &store).await.unwrap().apps[0].selected);
}
#[tokio::test]
async fn rejects_stale_unknown_protected_unselected_and_unearned_force() {
    let store = Store::memory().unwrap();
    let native = native("closed");
    let mut closer = WorkspaceCloser::default();
    let first = closer.capture(&native, &store).await.unwrap();
    let second = closer.capture(&native, &store).await.unwrap();
    assert!(closer
        .execute(
            &native,
            &first.token,
            &[first.apps[0].id.clone()],
            "graceful",
            false
        )
        .await
        .is_err());
    for (ids, action, confirmed) in [
        (vec!["invented".into()], "graceful", false),
        (vec![second.apps[1].id.clone()], "graceful", false),
        (vec![second.apps[0].id.clone()], "force", true),
        (vec![second.apps[0].id.clone()], "force", false),
    ] {
        assert!(closer
            .execute(&native, &second.token, &ids, action, confirmed)
            .await
            .is_err());
    }
    closer
        .select(&store, &second.token, &second.apps[0].id, false)
        .unwrap();
    assert!(closer
        .execute(
            &native,
            &second.token,
            &[second.apps[0].id.clone()],
            "graceful",
            false
        )
        .await
        .is_err());
    assert!(native
        .calls
        .lock()
        .unwrap()
        .iter()
        .all(|c| c["op"] == "workspaceCloseCapture"));
}
#[tokio::test]
async fn successful_and_denied_graceful_close_never_force_automatically() {
    for mode in ["closed", "failed"] {
        let store = Store::memory().unwrap();
        let native = native(mode);
        let mut closer = WorkspaceCloser::default();
        let capture = closer.capture(&native, &store).await.unwrap();
        let result = closer
            .execute(
                &native,
                &capture.token,
                &[capture.apps[0].id.clone()],
                "graceful",
                false,
            )
            .await
            .unwrap();
        assert_eq!(result.apps[0].state, mode);
        assert!(!result.apps[0].can_force);
        let calls = native.calls.lock().unwrap();
        assert!(calls.iter().all(|c| c["action"] != "force"));
        assert_eq!(
            calls.last().unwrap()["targets"].as_array().unwrap().len(),
            2
        );
    }
}
