use super::{assets::AssetStore, model::*, AutomationProvider};
use crate::{
    registry::{definition, field, NodeContext, NodeDefinition, NodeOutput, NodeRunner},
    Error, Result,
};
use async_trait::async_trait;
use serde_json::{json, Value};
use std::{
    sync::{Arc, OnceLock},
    time::{Duration, Instant},
};
use tokio::sync::Semaphore;
pub(crate) fn desktop_lock() -> &'static Semaphore {
    static LOCK: OnceLock<Semaphore> = OnceLock::new();
    LOCK.get_or_init(|| Semaphore::new(1))
}
pub const ACTIONS: &[(&str, &str)] = &[
    ("activateWindow", "激活窗口"),
    ("waitWindow", "等待窗口"),
    ("click", "点击元素"),
    ("doubleClick", "双击元素"),
    ("rightClick", "右键点击"),
    ("inputText", "输入文本"),
    ("inputSecret", "输入 Secret"),
    ("pressKey", "按键"),
    ("shortcut", "组合快捷键"),
    ("selectMenu", "选择菜单"),
    ("selectOption", "选择下拉选项"),
    ("scroll", "滚动"),
    ("drag", "拖动"),
    ("waitElement", "等待元素"),
    ("waitElementDisappear", "等待元素消失"),
    ("moveWindow", "移动窗口"),
    ("resizeWindow", "调整窗口大小"),
    ("maximize", "最大化窗口"),
    ("minimize", "最小化窗口"),
    ("screenshot", "窗口截图"),
];
pub fn runners() -> Vec<Arc<dyn NodeRunner>> {
    ACTIONS
        .iter()
        .map(|(kind, name)| Arc::new(GuiRunner { kind, name }) as Arc<dyn NodeRunner>)
        .collect()
}
pub struct GuiRunner {
    kind: &'static str,
    name: &'static str,
}
struct ElapsedDiagnostic {
    started: Instant,
    diagnostic: Arc<std::sync::Mutex<Diagnostic>>,
}
impl Drop for ElapsedDiagnostic {
    fn drop(&mut self) {
        if let Ok(mut d) = self.diagnostic.lock() {
            d.duration_ms = self.started.elapsed().as_millis() as u64;
        }
    }
}
pub fn validate_config(kind: &str, c: &ActionConfig) -> Result<()> {
    let invalid = |message: &str| Error::Validation(message.into());
    if c.locators.is_empty() || c.locators.len() > 8 {
        return Err(invalid("GUI actions require 1–8 ordered locators"));
    }
    if c.poll_interval_ms
        .is_some_and(|n| !(250..=5000).contains(&n))
    {
        return Err(invalid("Element polling must be 250–5000 ms"));
    }
    for locator in &c.locators {
        if locator.window().is_empty() {
            return Err(invalid(
                "GUI locator requires a target application or window",
            ));
        }
        match locator {
            Locator::Accessibility {
                attributes,
                ancestor_path,
                ..
            } => {
                if attributes == &Attributes::default() || ancestor_path.len() > 16 {
                    return Err(invalid(
                        "Accessibility locator requires attributes and at most 16 ancestors",
                    ));
                }
            }
            Locator::Text { text, region, .. } => {
                if text.trim().is_empty() {
                    return Err(invalid("Text locator requires text"));
                }
                if region
                    .as_ref()
                    .is_some_and(|r| !r.valid() || r.x < 0.0 || r.y < 0.0)
                {
                    return Err(invalid("Invalid OCR region"));
                }
            }
            Locator::Image {
                asset_id,
                threshold,
                scales,
                region,
                ..
            } => {
                if asset_id.len() != 64
                    || !asset_id.bytes().all(|c| c.is_ascii_hexdigit())
                    || !(0.5..=1.0).contains(threshold)
                    || scales.is_empty()
                    || scales.len() > 5
                    || scales.iter().any(|s| !(0.5..=2.0).contains(s))
                    || region
                        .as_ref()
                        .is_some_and(|r| !r.valid() || r.x < 0.0 || r.y < 0.0)
                {
                    return Err(invalid("Image locator needs an asset, threshold 0.5–1, bounded region and 1–5 scales (0.5–2)"));
                }
            }
            Locator::RelativeCoordinate { x, y, .. } => {
                if !(0.0..=1.0).contains(x) || !(0.0..=1.0).contains(y) {
                    return Err(invalid(
                        "Relative coordinates must be fractions from 0 to 1",
                    ));
                }
            }
            Locator::AbsoluteCoordinate { x, y, .. }
                if !x.is_finite()
                    || !y.is_finite()
                    || x.abs() > 100_000.0
                    || y.abs() > 100_000.0 =>
            {
                return Err(invalid("Invalid absolute coordinates"));
            }
            _ => {}
        }
    }
    if c.text.len() > 131072 || c.text.contains('\0') {
        return Err(invalid("Input text is oversized or contains NUL"));
    }
    if kind == "inputSecret" && !c.text.is_empty() {
        return Err(invalid(
            "Input Secret stores references only; remove inline text",
        ));
    }
    if kind == "inputSecret"
        && c.secret_ref != "unresolved"
        && !crate::vault::valid_reference(&c.secret_ref)
    {
        return Err(invalid(
            "Input Secret requires a vault:ID or env:NAME reference",
        ));
    }
    if kind == "shortcut" && (c.keys.is_empty() || c.keys.len() > 6) {
        return Err(invalid("Shortcut requires 1–6 key names"));
    }
    if kind == "pressKey" && c.key.is_empty() {
        return Err(invalid("Key is required"));
    }
    if kind == "selectOption" && c.option.is_empty() {
        return Err(invalid("Option text is required"));
    }
    if kind == "selectMenu" && (c.menu_path.is_empty() || c.menu_path.len() > 12) {
        return Err(invalid("Menu path requires 1–12 items"));
    }
    if kind == "resizeWindow"
        && (!(100.0..=16000.0).contains(&c.width) || !(80.0..=16000.0).contains(&c.height))
    {
        return Err(invalid("Window dimensions are outside supported limits"));
    }
    if kind == "scroll" && (!c.delta.is_finite() || c.delta.abs() > 100.0) {
        return Err(invalid("Scroll delta must be bounded"));
    }
    Ok(())
}
#[async_trait]
impl NodeRunner for GuiRunner {
    fn definition(&self) -> NodeDefinition {
        let mut fields = vec![field(
            "locators",
            "定位器与 Fallback",
            "locators",
            true,
            "优先使用 Accessibility；仅匹配唯一元素",
        )];
        let mut defaults = json!({"locators":[{"kind":"accessibility","window":{"application":"","title":""},"role":"Button","name":"","automationId":"","className":"","frameworkId":"","ancestorPath":[]}],"captureOnFailure":true,"pollIntervalMs":400});
        let extras: Vec<(&str, &str, &str, Value)> = match self.kind {
            "inputText" => vec![("text", "文本", "text", json!(""))],
            "inputSecret" => vec![("secretRef", "Secret 引用", "text", json!("env:UNRESOLVED"))],
            "pressKey" => vec![("key", "按键", "text", json!("Enter"))],
            "shortcut" => vec![("keys", "组合键", "arguments", json!(["Ctrl", "Enter"]))],
            "selectOption" => vec![("option", "选项", "text", json!(""))],
            "selectMenu" => vec![("menuPath", "菜单路径", "arguments", json!(["File"]))],
            "scroll" => vec![("delta", "滚动量（正数向下）", "number", json!(3))],
            "drag" => vec![
                ("endX", "结束屏幕 X", "number", json!(0)),
                ("endY", "结束屏幕 Y", "number", json!(0)),
            ],
            "moveWindow" => vec![
                ("x", "屏幕 X", "number", json!(100)),
                ("y", "屏幕 Y", "number", json!(100)),
            ],
            "resizeWindow" => vec![
                ("width", "宽度", "number", json!(900)),
                ("height", "高度", "number", json!(700)),
            ],
            _ => vec![],
        };
        for (key, label, kind, value) in extras {
            fields.push(field(key, label, kind, true, ""));
            defaults[key] = value;
        }
        if matches!(
            self.kind,
            "activateWindow"
                | "waitWindow"
                | "moveWindow"
                | "resizeWindow"
                | "maximize"
                | "minimize"
                | "screenshot"
                | "selectMenu"
        ) {
            defaults["locators"] =
                json!([{"kind":"window","window":{"application":"","title":""}}]);
        }
        definition(
            &format!("gui.{}", self.kind),
            self.name,
            "原生辅助功能优先；失败保留定位诊断",
            "gui",
            fields,
            defaults,
            self.kind.starts_with("wait"),
        )
    }
    fn validate(&self, config: &Value) -> Result<()> {
        let config: ActionConfig = serde_json::from_value(config.clone())?;
        validate_config(self.kind, &config)
    }
    async fn run(&self, config: &Value, ctx: &NodeContext) -> Result<NodeOutput> {
        self.validate(config)?;
        let c: ActionConfig = serde_json::from_value(config.clone())?;
        let provider = ctx.platform.automation();
        let started = Instant::now();
        let _elapsed = ElapsedDiagnostic {
            started,
            diagnostic: ctx.diagnostics.clone(),
        };
        loop {
            let waiting = self.kind.starts_with("wait");
            let guard = if waiting {
                None
            } else {
                Some(
                    desktop_lock()
                        .acquire()
                        .await
                        .map_err(|_| Error::Runtime("Desktop input service unavailable".into()))?,
                )
            };
            match resolve_action(provider.as_ref(), &c.locators, &ctx.diagnostics, self.kind).await
            {
                Ok(target) => {
                    if self.kind == "waitElementDisappear" {
                        drop(guard);
                        tokio::time::sleep(Duration::from_millis(
                            c.poll_interval_ms.unwrap_or(400),
                        ))
                        .await;
                        continue;
                    }
                    if self.kind == "screenshot" {
                        let (id, path) = AssetStore::new(provider.paths())
                            .diagnostic_path()
                            .map_err(failure)?;
                        provider
                            .request(json!({"op":"capture","window":target.window,"path":path}))
                            .await
                            .map_err(failure)?;
                        ctx.diagnostics.lock().unwrap().screenshot = Some(id);
                    } else if !waiting {
                        let mut action = serde_json::to_value(&c)?;
                        action["kind"] = json!(self.kind);
                        action.as_object_mut().unwrap().remove("locators");
                        if self.kind == "inputSecret" {
                            let secret =
                                crate::vault::read(&c.secret_ref, provider.as_ref()).await?;
                            action["text"] = json!(secret);
                        }
                        let performed = provider.request(json!({"op":"perform","window":target.window,"locator":target.native_locator,"point":target.point.map(|(x,y)|json!({"x":x,"y":y})),"action":action})).await.map_err(failure)?;
                        ctx.diagnostics.lock().unwrap().focus =
                            performed.get("focus").filter(|v| !v.is_null()).cloned();
                        ctx.diagnostics.lock().unwrap().pointer =
                            performed.get("pointer").filter(|v| !v.is_null()).cloned();
                    }
                    let mut d = ctx.diagnostics.lock().unwrap();
                    d.duration_ms = started.elapsed().as_millis() as u64;
                    d.error = None;
                    return Ok(NodeOutput {
                        message: format!("{}完成", self.name),
                        output: json!({"automation":&*d}),
                        ..Default::default()
                    });
                }
                Err(error) => {
                    ctx.diagnostics.lock().unwrap().error = Some(error.clone());
                    if self.kind == "waitElementDisappear" && error.code == "notFound" {
                        let mut d = ctx.diagnostics.lock().unwrap();
                        d.duration_ms = started.elapsed().as_millis() as u64;
                        d.error = None;
                        return Ok(NodeOutput {
                            message: "Element disappeared".into(),
                            output: json!({"automation":&*d}),
                            ..Default::default()
                        });
                    }
                    if waiting && error.code == "notFound" {
                        drop(guard);
                        tokio::time::sleep(Duration::from_millis(
                            c.poll_interval_ms.unwrap_or(400),
                        ))
                        .await;
                        continue;
                    }
                    return Err(failure(error));
                }
            }
        }
    }
    async fn failure_diagnostics(
        &self,
        config: &Value,
        ctx: &NodeContext,
        error: &Error,
    ) -> Option<Value> {
        let provider = ctx.platform.automation();
        let mut d = ctx.diagnostics.lock().ok()?.clone();
        let current = if let Error::Automation { diagnostic, .. } = error {
            diagnostic.error.clone()
        } else {
            None
        };
        d.error = current.or_else(|| {
            Some(AutomationError::new(
                if error.to_string().contains("timed out") {
                    "timeout"
                } else if error.to_string().contains("cancelled") {
                    "cancelled"
                } else {
                    "actionFailed"
                },
                error.to_string(),
            ))
        });
        if config["captureOnFailure"] != false && !error.to_string().contains("cancelled") {
            if let Ok(c) = serde_json::from_value::<ActionConfig>(config.clone()) {
                if let Some(locator) = c.locators.first() {
                    if let Ok((id, path)) = AssetStore::new(provider.paths()).diagnostic_path() {
                        if matches!(
                            tokio::time::timeout(
                                Duration::from_secs(2),
                                provider.request(
                                    json!({"op":"capture","window":locator.window(),"path":path})
                                )
                            )
                            .await,
                            Ok(Ok(_))
                        ) {
                            d.screenshot = Some(id);
                        }
                    }
                }
            }
        }
        Some(json!(d))
    }
}
fn failure(error: AutomationError) -> Error {
    Error::Automation {
        message: error.to_string(),
        diagnostic: Box::new(Diagnostic {
            error: Some(error),
            ..Default::default()
        }),
    }
}
pub async fn resolve(
    provider: &dyn AutomationProvider,
    locators: &[Locator],
    diagnostics: &std::sync::Mutex<Diagnostic>,
) -> AutomationResult<ResolvedTarget> {
    resolve_action(provider, locators, diagnostics, "highlight").await
}
pub async fn resolve_action(
    provider: &dyn AutomationProvider,
    locators: &[Locator],
    diagnostics: &std::sync::Mutex<Diagnostic>,
    kind: &str,
) -> AutomationResult<ResolvedTarget> {
    let mut ordered: Vec<_> = locators.iter().enumerate().collect();
    ordered.sort_by_key(|(_, l)| l.priority());
    let mut final_error = AutomationError::new("notFound", "No locator matched");
    for (index, locator) in ordered {
        let started = Instant::now();
        let result = resolve_one(provider, locator, kind == "inputSecret").await;
        let attempt = LocatorAttempt {
            index,
            kind: locator.kind().into(),
            duration_ms: started.elapsed().as_millis() as u64,
            success: result.is_ok(),
            error: result.as_ref().err().cloned(),
        };
        let mut d = diagnostics.lock().unwrap();
        if d.locator_attempts.len() >= 64 {
            d.locator_attempts.drain(0..1);
        }
        d.locator_attempts.push(attempt);
        match result {
            Ok(target) => {
                d.application = target.element["window"]["application"]
                    .as_str()
                    .unwrap_or(&target.window.application)
                    .into();
                d.window = target
                    .element
                    .get("window")
                    .cloned()
                    .unwrap_or_else(|| json!(target.window));
                d.locator_used = Some(index);
                d.matched_element = Some(target.element.clone());
                return Ok(target);
            }
            Err(error) => {
                let stop = matches!(
                    error.code.as_str(),
                    "permissionDenied" | "nativeTimeout" | "workerUnavailable"
                );
                final_error = error;
                if stop {
                    break;
                }
            }
        }
    }
    Err(final_error)
}
async fn resolve_one(
    provider: &dyn AutomationProvider,
    locator: &Locator,
    secure_input: bool,
) -> AutomationResult<ResolvedTarget> {
    let window = locator.window().clone();
    let mut native_locator = Value::Null;
    let mut point = None;
    let element = match locator {
        Locator::Accessibility { .. } | Locator::Text { ocr: false, .. } => {
            let value = serde_json::to_value(locator).unwrap();
            let e = provider
                .request(
                    json!({"op":"find","window":window,"locator":value,"secureInput":secure_input}),
                )
                .await?;
            native_locator = value;
            native_locator["runtimeId"] = e["runtimeId"].clone();
            e
        }
        Locator::Window { .. } => {
            let w = provider.window(&window).await?;
            json!({"window":w,"bounds":w["bounds"],"role":"Window"})
        }
        Locator::RelativeCoordinate { x, y, .. } | Locator::AbsoluteCoordinate { x, y, .. } => {
            let w = provider.window(&window).await?;
            let rect: Rect = serde_json::from_value(w["bounds"].clone())
                .map_err(|_| AutomationError::new("invalidBounds", "Window has invalid bounds"))?;
            let (px, py) = if matches!(locator, Locator::RelativeCoordinate { .. }) {
                (rect.x + x * rect.width, rect.y + y * rect.height)
            } else {
                (*x, *y)
            };
            if px < rect.x || py < rect.y || px >= rect.x + rect.width || py >= rect.y + rect.height
            {
                return Err(AutomationError::new(
                    "invalidCoordinates",
                    "Coordinates are outside the target window",
                ));
            }
            point = Some((px, py));
            json!({"window":w,"bounds":{"x":px,"y":py,"width":1,"height":1},"role":"Coordinate"})
        }
        Locator::Text {
            ocr: true,
            text,
            region,
            ..
        } => {
            let (_, path) = AssetStore::new(provider.paths()).diagnostic_path()?;
            let _cleanup = super::assets::TemporaryImage(path.clone());
            let result = provider
                .request(json!({"op":"ocr","window":window,"region":region,"path":path}))
                .await;
            let _ = std::fs::remove_file(&path);
            let result = result?;
            let words = result["words"]
                .as_array()
                .ok_or_else(|| AutomationError::new("ocrUnavailable", "OCR returned no words"))?;
            let wanted = text
                .split_whitespace()
                .map(str::to_lowercase)
                .collect::<Vec<_>>();
            let mut matches = vec![];
            for start in 0..words.len() {
                if wanted.iter().enumerate().all(|(i, w)| {
                    words
                        .get(start + i)
                        .and_then(|v| v["text"].as_str())
                        .is_some_and(|s| s.to_lowercase() == *w)
                }) {
                    matches.push(start);
                }
            }
            if matches.len() != 1 {
                return Err(AutomationError::new(
                    if matches.is_empty() {
                        "notFound"
                    } else {
                        "ambiguous"
                    },
                    "OCR text must match one bounded region",
                ));
            }
            let mut rect: Rect = serde_json::from_value(words[matches[0]]["bounds"].clone())
                .map_err(|_| {
                    AutomationError::new("invalidBounds", "OCR returned invalid bounds")
                })?;
            for word in words
                .iter()
                .skip(matches[0] + 1)
                .take(wanted.len().saturating_sub(1))
            {
                let b: Rect = serde_json::from_value(word["bounds"].clone()).unwrap_or_default();
                let right = (rect.x + rect.width).max(b.x + b.width);
                let bottom = (rect.y + rect.height).max(b.y + b.height);
                rect.x = rect.x.min(b.x);
                rect.y = rect.y.min(b.y);
                rect.width = right - rect.x;
                rect.height = bottom - rect.y;
            }
            point = Some(rect.center());
            json!({"window":provider.window(&window).await?,"bounds":rect,"role":"OCRText","name":text,"confidence":words[matches[0]]["confidence"],"confidenceSource":result["confidenceSource"]})
        }
        Locator::Image {
            asset_id,
            threshold,
            region,
            scales,
            ..
        } => {
            let store = AssetStore::new(provider.paths());
            let template = store.asset_path(asset_id)?;
            let (_, path) = store.diagnostic_path()?;
            let _cleanup = super::assets::TemporaryImage(path.clone());
            let capture = provider
                .request(json!({"op":"capture","window":window,"region":region,"path":path}))
                .await?;
            let matched =
                super::vision::match_image(path.clone(), template, *threshold, scales.clone())
                    .await;
            let _ = std::fs::remove_file(path);
            let (mut bounds, score) = matched?;
            let scale = capture["scale"].as_f64().unwrap_or(1.0).max(0.1);
            bounds.x /= scale;
            bounds.y /= scale;
            bounds.width /= scale;
            bounds.height /= scale;
            bounds.x += capture["bounds"]["x"].as_f64().unwrap_or(0.0);
            bounds.y += capture["bounds"]["y"].as_f64().unwrap_or(0.0);
            point = Some(bounds.center());
            json!({"window":provider.window(&window).await?,"bounds":bounds,"role":"Image","similarity":score,"assetId":asset_id})
        }
    };
    Ok(ResolvedTarget {
        window,
        native_locator,
        point,
        element,
    })
}
