use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Rect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}
impl Rect {
    pub fn valid(&self) -> bool {
        [self.x, self.y, self.width, self.height]
            .iter()
            .all(|n| n.is_finite())
            && self.width > 0.0
            && self.height > 0.0
    }
    pub fn center(&self) -> (f64, f64) {
        (self.x + self.width / 2.0, self.y + self.height / 2.0)
    }
}
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields, default)]
pub struct WindowLocator {
    pub application: String,
    pub title: String,
    pub class_name: String,
    pub pid: Option<u32>,
    pub handle: Option<String>,
}
impl WindowLocator {
    pub fn is_empty(&self) -> bool {
        self.application.is_empty()
            && self.title.is_empty()
            && self.pid.is_none()
            && self.handle.is_none()
    }
}
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields, default)]
pub struct Attributes {
    pub role: String,
    pub name: String,
    pub automation_id: String,
    pub class_name: String,
    pub framework_id: String,
    pub secure: bool,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub enum Locator {
    Accessibility {
        window: WindowLocator,
        #[serde(flatten)]
        attributes: Attributes,
        #[serde(default, rename = "ancestorPath")]
        ancestor_path: Vec<Attributes>,
    },
    Text {
        window: WindowLocator,
        text: String,
        #[serde(default)]
        ocr: bool,
        #[serde(default)]
        region: Option<Rect>,
    },
    Image {
        window: WindowLocator,
        #[serde(rename = "assetId")]
        asset_id: String,
        #[serde(default = "threshold")]
        threshold: f64,
        #[serde(default)]
        region: Option<Rect>,
        #[serde(default = "scales")]
        scales: Vec<f64>,
    },
    RelativeCoordinate {
        window: WindowLocator,
        x: f64,
        y: f64,
    },
    AbsoluteCoordinate {
        window: WindowLocator,
        x: f64,
        y: f64,
    },
    Window {
        window: WindowLocator,
    },
}
fn threshold() -> f64 {
    0.94
}
fn scales() -> Vec<f64> {
    vec![1.0]
}
impl Locator {
    pub fn window(&self) -> &WindowLocator {
        match self {
            Self::Accessibility { window, .. }
            | Self::Text { window, .. }
            | Self::Image { window, .. }
            | Self::RelativeCoordinate { window, .. }
            | Self::AbsoluteCoordinate { window, .. }
            | Self::Window { window } => window,
        }
    }
    pub fn priority(&self) -> u8 {
        match self {
            Self::Accessibility { attributes, .. } if !attributes.automation_id.is_empty() => 0,
            Self::Accessibility { .. } => 1,
            Self::Window { .. } => 0,
            Self::Text { ocr: false, .. } => 2,
            Self::Text { ocr: true, .. } => 3,
            Self::Image { .. } => 4,
            Self::RelativeCoordinate { .. } => 5,
            Self::AbsoluteCoordinate { .. } => 6,
        }
    }
    pub fn kind(&self) -> &'static str {
        match self {
            Self::Accessibility { .. } => "accessibility",
            Self::Text { ocr: false, .. } => "accessibleText",
            Self::Text { ocr: true, .. } => "ocr",
            Self::Image { .. } => "image",
            Self::RelativeCoordinate { .. } => "relativeCoordinate",
            Self::AbsoluteCoordinate { .. } => "absoluteCoordinate",
            Self::Window { .. } => "window",
        }
    }
}
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields, default)]
pub struct ActionConfig {
    pub locators: Vec<Locator>,
    pub text: String,
    pub secret_ref: String,
    pub key: String,
    pub keys: Vec<String>,
    pub option: String,
    pub menu_path: Vec<String>,
    pub delta: f64,
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    pub end_x: f64,
    pub end_y: f64,
    pub poll_interval_ms: Option<u64>,
    pub capture_on_failure: Option<bool>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AutomationError {
    pub code: String,
    pub message: String,
    pub permission: Option<String>,
    pub platform: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub details: Option<Box<Value>>,
}
impl AutomationError {
    pub fn new(code: &str, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
            permission: None,
            platform: std::env::consts::OS.into(),
            details: None,
        }
    }
}
impl std::fmt::Display for AutomationError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.code, self.message)
    }
}
impl std::error::Error for AutomationError {}
pub type AutomationResult<T> = std::result::Result<T, AutomationError>;
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocatorAttempt {
    pub index: usize,
    pub kind: String,
    pub duration_ms: u64,
    pub success: bool,
    pub error: Option<AutomationError>,
}
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Diagnostic {
    pub application: String,
    pub window: Value,
    pub locator_attempts: Vec<LocatorAttempt>,
    pub locator_used: Option<usize>,
    pub matched_element: Option<Value>,
    pub duration_ms: u64,
    pub screenshot: Option<String>,
    pub error: Option<AutomationError>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub focus: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pointer: Option<Value>,
}
#[derive(Debug, Clone)]
pub struct ResolvedTarget {
    pub window: WindowLocator,
    pub native_locator: Value,
    pub point: Option<(f64, f64)>,
    pub element: Value,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Asset {
    pub id: String,
    pub sha256: String,
    pub name: String,
    pub width: u32,
    pub height: u32,
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn locator_serialization_is_strict_and_accepts_picker_ancestry() {
        let value = serde_json::json!({"kind":"accessibility","window":{"application":"harness.exe"},"role":"Button","automationId":"go","ancestorPath":[{"role":"Window","secure":false}]});
        let locator: Locator = serde_json::from_value(value).unwrap();
        assert_eq!(locator.priority(), 0);
        assert_eq!(serde_json::to_value(locator).unwrap()["automationId"], "go");
    }
}
