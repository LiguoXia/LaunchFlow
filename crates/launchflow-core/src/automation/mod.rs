//! Platform-neutral GUI services. Native implementation details live in bundled workers.
pub mod assets;
pub mod bridge;
pub mod model;
pub mod runner;
pub mod sessions;
pub mod vision;
use async_trait::async_trait;
pub use model::*;
use serde_json::Value;
use std::{path::PathBuf, sync::Arc};

#[async_trait]
pub trait WindowProvider: Send + Sync {
    async fn windows(&self) -> AutomationResult<Value>;
    async fn window(&self, locator: &WindowLocator) -> AutomationResult<Value>;
}
#[async_trait]
pub trait AutomationProvider: WindowProvider {
    async fn request(&self, request: Value) -> AutomationResult<Value>;
    fn paths(&self) -> &AutomationPaths;
}
#[derive(Debug, Clone)]
pub struct AutomationPaths {
    pub worker: PathBuf,
    pub data: PathBuf,
    pub harness: PathBuf,
}
impl Default for AutomationPaths {
    fn default() -> Self {
        let source = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../native/bin");
        let folder = if cfg!(debug_assertions) {
            source
        } else {
            std::env::current_exe()
                .unwrap_or_default()
                .parent()
                .unwrap_or(std::path::Path::new("."))
                .join("native")
        };
        let suffix = if cfg!(windows) { ".exe" } else { "" };
        Self {
            worker: folder.join(format!("launchflow-automation{suffix}")),
            harness: folder.join(format!("launchflow-harness{suffix}")),
            data: std::env::temp_dir().join("launchflow-automation"),
        }
    }
}
pub fn native(paths: AutomationPaths) -> Arc<dyn AutomationProvider> {
    Arc::new(bridge::NativeAutomation::new(paths))
}
