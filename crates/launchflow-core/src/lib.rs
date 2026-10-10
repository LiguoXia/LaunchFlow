pub mod application_icons;
pub mod application_log;
pub mod automation;
pub mod diagnostics;
pub mod engine;
pub mod model;
pub mod parameters;
pub mod platform;
pub mod policy;
pub mod portable;
pub mod rebind;
pub mod registry;
pub mod safety;
pub mod storage;
pub mod templates;
pub mod triggers;
pub mod validation;
pub mod vault;
pub mod workflow_nodes;
pub mod workspace;
pub mod workspace_close;

pub type Result<T> = std::result::Result<T, Error>;

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("等待解锁 Windows 桌面后继续；本步骤尚未执行。")]
    DesktopUnavailable,
    #[error("{0}")]
    ApplicationLaunchReview(String),
    #[error("GUI automation failed: {message}")]
    Automation {
        message: String,
        diagnostic: Box<automation::Diagnostic>,
    },
    #[error("Subflow failed: {message}")]
    Subflow { run_id: String, message: String },
    #[error("{0}")]
    Validation(String),
    #[error("{0}")]
    Runtime(String),
    #[error("Storage error: {0}")]
    Storage(#[from] rusqlite::Error),
    #[error("Data error: {0}")]
    Json(#[from] serde_json::Error),
    #[error("System error: {0}")]
    Io(#[from] std::io::Error),
}
