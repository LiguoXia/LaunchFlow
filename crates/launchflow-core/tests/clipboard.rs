use async_trait::async_trait;
use launchflow_core::{
    automation::{
        AutomationError, AutomationPaths, AutomationProvider, AutomationResult, Diagnostic,
        WindowLocator, WindowProvider,
    },
    model::ApplicationProfile,
    platform::PlatformAdapter,
    registry::{NodeContext, NodeRegistry},
    Result,
};
use serde_json::{json, Value};
use std::sync::{Arc, Mutex};

struct MockClipboard {
    requests: Arc<Mutex<Vec<Value>>>,
    ready: bool,
    fail: bool,
    paths: AutomationPaths,
}
#[async_trait]
impl WindowProvider for MockClipboard {
    async fn windows(&self) -> AutomationResult<Value> {
        panic!("Copy must not enumerate windows");
    }
    async fn window(&self, _: &WindowLocator) -> AutomationResult<Value> {
        panic!("Copy needs no target window");
    }
}
#[async_trait]
impl AutomationProvider for MockClipboard {
    fn paths(&self) -> &AutomationPaths {
        &self.paths
    }
    async fn request(&self, request: Value) -> AutomationResult<Value> {
        self.requests.lock().unwrap().push(request);
        if self.fail {
            Err(AutomationError::new("clipboardBusy", "Clipboard is busy"))
        } else {
            Ok(json!({"copied":true}))
        }
    }
}
#[async_trait]
impl PlatformAdapter for MockClipboard {
    fn os(&self) -> &'static str {
        "windows"
    }
    fn desktop_ready(&self) -> bool {
        self.ready
    }
    fn automation(&self) -> Arc<dyn AutomationProvider> {
        Arc::new(Self {
            requests: self.requests.clone(),
            ready: self.ready,
            fail: self.fail,
            paths: self.paths.clone(),
        })
    }
    async fn launch(&self, _: &ApplicationProfile, _: &[String]) -> Result<()> {
        panic!("Copy must not launch apps");
    }
    async fn open_target(&self, _: &str) -> Result<()> {
        panic!("Copy must not open targets");
    }
}
fn context(ready: bool, fail: bool) -> (NodeContext, Arc<Mutex<Vec<Value>>>) {
    let requests = Arc::new(Mutex::new(vec![]));
    (
        NodeContext {
            diagnostics: Arc::new(Mutex::new(Diagnostic::default())),
            platform: Arc::new(MockClipboard {
                requests: requests.clone(),
                ready,
                fail,
                paths: AutomationPaths::default(),
            }),
            profiles: vec![],
            subflows: None,
        },
        requests,
    )
}
#[test]
fn copy_has_one_multiline_text_field_and_validates_without_a_locator() {
    let runner = NodeRegistry::builtins()
        .runner("clipboard.copyText")
        .unwrap();
    let definition = runner.definition();
    assert_eq!(definition.fields.len(), 1);
    assert_eq!(definition.fields[0].kind, "textarea");
    runner
        .validate(&json!({"text":"  中文\n第二行 🧪\r\n"}))
        .unwrap();
    for invalid in [
        json!({}),
        json!({"text":3}),
        json!({"text":""}),
        json!({"text":"a\0b"}),
        json!({"text":"x".repeat(131073)}),
    ] {
        assert!(runner.validate(&invalid).is_err());
    }
}
#[tokio::test]
async fn copy_preserves_text_and_does_not_echo_it_in_execution_output() {
    let runner = NodeRegistry::builtins()
        .runner("clipboard.copyText")
        .unwrap();
    let (ctx, requests) = context(true, false);
    let text = "  中文\n第二行 🧪\r\n引号 \" 与 $()";
    let output = runner.run(&json!({"text":text}), &ctx).await.unwrap();
    assert_eq!(
        requests.lock().unwrap().as_slice(),
        &[json!({"op":"clipboardCopyText","text":text})]
    );
    assert_eq!(
        output.output,
        json!({"copied":true,"characters":text.chars().count()})
    );
    assert!(!format!("{}{}{}", output.message, output.stdout, output.output).contains(text));
    let (ctx, _) = context(true, true);
    assert!(runner.run(&json!({"text":text}), &ctx).await.is_err());
    let (ctx, requests) = context(false, false);
    assert!(runner.run(&json!({"text":text}), &ctx).await.is_err());
    assert!(requests.lock().unwrap().is_empty());
}
