use async_trait::async_trait;
use base64::{engine::general_purpose::STANDARD, Engine as _};
use launchflow_core::{
    application_icons::{load, IconSource},
    automation::*,
};
use serde_json::{json, Value};
use std::sync::atomic::{AtomicUsize, Ordering};

struct Icons {
    paths: AutomationPaths,
    calls: AtomicUsize,
}
#[async_trait]
impl WindowProvider for Icons {
    async fn windows(&self) -> AutomationResult<Value> {
        unreachable!()
    }
    async fn window(&self, _: &WindowLocator) -> AutomationResult<Value> {
        unreachable!()
    }
}
#[async_trait]
impl AutomationProvider for Icons {
    fn paths(&self) -> &AutomationPaths {
        &self.paths
    }
    async fn request(&self, request: Value) -> AutomationResult<Value> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        Ok(Value::Array(request["sources"].as_array().unwrap().iter().map(|s| {
            if s["path"].as_str().unwrap().ends_with("missing.exe") { Value::Null }
            else { json!({"path":s["path"], "png":STANDARD.encode(include_bytes!("../../../src-tauri/icons/32x32.png"))}) }
        }).collect()))
    }
}

#[tokio::test]
async fn persistent_cache_refreshes_changed_files_and_recovers_corruption() {
    let dir = tempfile::tempdir().unwrap();
    let exe = dir.path().join("app.exe");
    std::fs::write(&exe, "version one").unwrap();
    let source = IconSource {
        path: exe.to_string_lossy().into(),
        bundle_id: String::new(),
    };
    let provider = Icons {
        paths: AutomationPaths {
            data: dir.path().join("cache"),
            ..Default::default()
        },
        calls: AtomicUsize::new(0),
    };
    let first = load(&provider, vec![source.clone()]).await;
    assert!(first[0]
        .as_ref()
        .unwrap()
        .starts_with("data:image/png;base64,"));
    assert_eq!(first, load(&provider, vec![source.clone()]).await);
    assert_eq!(provider.calls.load(Ordering::SeqCst), 1);
    std::fs::write(&exe, "version two with changed length").unwrap();
    load(&provider, vec![source.clone()]).await;
    assert_eq!(provider.calls.load(Ordering::SeqCst), 2);
    let cached = std::fs::read_dir(provider.paths.data.join("application-icons-v1"))
        .unwrap()
        .next()
        .unwrap()
        .unwrap()
        .path();
    std::fs::write(cached, "invalid cache").unwrap();
    assert_eq!(first, load(&provider, vec![source]).await);
    assert_eq!(provider.calls.load(Ordering::SeqCst), 3);
}

#[tokio::test]
async fn missing_icons_and_nonlocal_sources_do_not_fail_the_batch() {
    let dir = tempfile::tempdir().unwrap();
    let provider = Icons {
        paths: AutomationPaths {
            data: dir.path().into(),
            ..Default::default()
        },
        calls: AtomicUsize::new(0),
    };
    let sources = [
        "relative.exe".into(),
        "https://example.invalid/app.exe".into(),
        dir.path()
            .join("missing.exe")
            .to_string_lossy()
            .into_owned(),
    ]
    .into_iter()
    .map(|path| IconSource {
        path,
        bundle_id: String::new(),
    })
    .collect();
    assert_eq!(load(&provider, sources).await, vec![None, None, None]);
    assert_eq!(provider.calls.load(Ordering::SeqCst), 1);
}
