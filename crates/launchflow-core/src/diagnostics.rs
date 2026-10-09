//! Diagnostic bundles use an allowlist, not best-effort redaction of arbitrary user content.
use crate::{model::*, portable::digest, registry::NodeRegistry, Result};
use serde_json::{json, Value};
use std::io::{Cursor, Write};
pub(crate) fn timestamp(s: &str) -> Option<String> {
    chrono::DateTime::parse_from_rfc3339(s)
        .ok()
        .map(|d| d.to_rfc3339())
}
pub(crate) fn category(error: &str) -> &'static str {
    let s = error.to_ascii_lowercase();
    if s.contains("permission") || s.contains("denied") || s.contains("approval") {
        "permission"
    } else if s.contains("timeout") || s.contains("timed out") {
        "timeout"
    } else if s.contains("secret") || s.contains("vault") {
        "secretReference"
    } else if s.contains("notfound") || s.contains("not found") || s.contains("missing") {
        "missingResource"
    } else if s.contains("cancel") {
        "cancelled"
    } else {
        "runtime"
    }
}
// Only structural GUI diagnostics are exported. Never copy locator contents, native
// messages, window identifiers, user input or screenshots from persisted run output.
pub(crate) fn automation(output: &Value) -> Value {
    let a = &output["automation"];
    if !a.is_object() {
        return Value::Null;
    }
    let code = |v: &Value| -> Value {
        let allowed = [
            "focusDenied",
            "notFound",
            "ambiguous",
            "invalidLocator",
            "invalidAction",
            "permissionDenied",
            "staleElement",
            "notVisible",
            "unsupported",
            "nativeFailure",
            "nativeTimeout",
            "workerUnavailable",
            "timeout",
            "cancelled",
            "actionFailed",
            "secureTargetRequired",
            "secureInputRequired",
            "windowOperationFailed",
            "impreciseClickTarget",
            "invalidCoordinates",
            "targetObscured",
            "impreciseTextTarget",
            "textNotApplied",
        ];
        v.as_str()
            .map(|s| json!(if allowed.contains(&s) { s } else { "unknown" }))
            .unwrap_or(Value::Null)
    };
    let f = a["error"]
        .get("details")
        .filter(|v| v.is_object())
        .unwrap_or(&a["focus"]);
    let mut focus = serde_json::Map::new();
    if let Some(stage) = f["stage"].as_str().filter(|s| {
        [
            "foregroundConfirmed",
            "foregroundWait",
            "windowUnavailable",
            "restoreTimeout",
            "foregroundTimeout",
            "beforeInput",
        ]
        .contains(s)
    }) {
        focus.insert("stage".into(), json!(stage));
    }
    for key in [
        "restoreRequested",
        "activationRequested",
        "requestAccepted",
        "foregroundMatched",
        "targetPresent",
        "foregroundGrantAccepted",
    ] {
        if let Some(value) = f[key].as_bool() {
            focus.insert(key.into(), json!(value));
        }
    }
    if let Some(ms) = f["elapsedMs"].as_u64() {
        focus.insert("elapsedMs".into(), json!(ms));
    }
    let p = a["error"]["details"]
        .get("pointer")
        .filter(|v| v.is_object())
        .unwrap_or(&a["pointer"]);
    let mut pointer = serde_json::Map::new();
    for (key, allowed) in [
        (
            "route",
            vec!["sendInput", "invoke", "toggle", "selectionItem"],
        ),
        (
            "targetRole",
            vec![
                "Window",
                "Pane",
                "Custom",
                "Group",
                "Coordinate",
                "Button",
                "Edit",
                "Text",
                "ListItem",
                "MenuItem",
                "CheckBox",
                "RadioButton",
                "TabItem",
                "Document",
                "Image",
            ],
        ),
        (
            "positionSource",
            vec!["explicitPoint", "elementBounds", "semantic"],
        ),
        (
            "stage",
            vec![
                "targetValidation",
                "pointerMoved",
                "inputDispatched",
                "invoked",
            ],
        ),
    ] {
        if let Some(value) = p[key].as_str().filter(|v| allowed.contains(v)) {
            pointer.insert(key.into(), json!(value));
        }
    }
    if let Some(value) = p["hitTestMatched"].as_bool() {
        pointer.insert("hitTestMatched".into(), json!(value));
    }
    if let Some(value) = p["inputEventsSent"].as_u64().filter(|v| *v <= 4) {
        pointer.insert("inputEventsSent".into(), json!(value));
    }
    let attempts: Vec<_> = a["locatorAttempts"].as_array().into_iter().flatten().take(32).map(|attempt| {
        let kind = attempt["kind"].as_str().filter(|s| ["accessibility", "window", "image", "ocr", "relativeCoordinate"].contains(s)).unwrap_or("unknown");
        json!({"kind":kind,"success":attempt["success"].as_bool(),"durationMs":attempt["durationMs"].as_u64(),"errorCode":code(&attempt["error"]["code"])})
    }).collect();
    json!({"errorCode":code(&a["error"]["code"]),"durationMs":a["durationMs"].as_u64(),"focus":focus,"pointer":pointer,"locatorAttempts":attempts})
}
pub fn bundle(version: &str, schema: u32, permissions: &Value, runs: &[Run]) -> Result<Vec<u8>> {
    bundle_with_application_log(version, schema, permissions, runs, &json!([]))
}
pub fn bundle_with_application_log(
    version: &str,
    schema: u32,
    permissions: &Value,
    runs: &[Run],
    application_log: &Value,
) -> Result<Vec<u8>> {
    let kinds: std::collections::BTreeSet<_> = NodeRegistry::builtins()
        .definitions()
        .into_iter()
        .map(|d| d.node_type)
        .collect();
    let mut permission_state = serde_json::Map::new();
    for key in [
        "accessibility",
        "screenRecording",
        "automation",
        "inputMonitoring",
        "administrator",
    ] {
        let status = permissions[key]
            .as_str()
            .filter(|s| ["granted", "denied", "notRequired", "onDemand"].contains(s))
            .unwrap_or("unknown");
        permission_state.insert(key.into(), json!(status));
    }
    let metadata:Vec<_>=runs.iter().map(|r|{
        let nodes:Vec<_>=r.node_runs.iter().map(|n|{
            let kind=r.scene_snapshot.workflow.nodes.iter().find(|node|node.id==n.node_id).map(|node|node.node_type.as_str()).filter(|kind|kinds.contains(*kind)).unwrap_or("unknown");
            json!({"node":&digest(n.node_id.as_bytes())[..16],"kind":kind,"status":n.status,"startedAt":n.started_at.as_deref().and_then(timestamp),"endedAt":n.ended_at.as_deref().and_then(timestamp),"durationMs":n.duration_ms,"retryCount":n.retry_count,"errorCategory":n.error.as_deref().map(category),"automation":automation(&n.output),"stdoutOmitted":!n.stdout.is_empty(),"stderrOmitted":!n.stderr.is_empty()})
        }).collect();
        json!({"run":&digest(r.id.as_bytes())[..16],"scene":&digest(r.scene_id.as_bytes())[..16],"sceneVersion":r.scene_version,"status":r.status,"startedAt":timestamp(&r.started_at),"endedAt":r.ended_at.as_deref().and_then(timestamp),"durationMs":r.duration_ms,"errorCategory":r.error.as_deref().map(category),"nodes":nodes})
    }).collect();
    let manifest = json!({"formatVersion":1,"appVersion":version,"os":std::env::consts::OS,"architecture":std::env::consts::ARCH,"databaseSchemaVersion":schema,"permissions":permission_state,"exportedAt":now(),"privacy":"Allowlisted metadata only. Names, paths, arguments, environment, input, secret references/values, screenshots, raw output and free-text errors are omitted."});
    let mut zip = zip::ZipWriter::new(Cursor::new(Vec::new()));
    for (name, content) in [
        (
            "application-log.json",
            serde_json::to_vec_pretty(&crate::application_log::sanitize_entries(application_log))?,
        ),
        ("manifest.json", serde_json::to_vec_pretty(&manifest)?),
        ("runs.json", serde_json::to_vec_pretty(&metadata)?),
        (
            "sanitized-logs.json",
            serde_json::to_vec_pretty(
                &json!({"events":metadata.iter().map(|r|json!({"run":r["run"],"status":r["status"],"errorCategory":r["errorCategory"]})).collect::<Vec<_>>()}),
            )?,
        ),
        (
            "error-traces.json",
            serde_json::to_vec_pretty(
                &metadata
                    .iter()
                    .filter(|r| {
                        r["errorCategory"] != Value::Null
                            || r["nodes"].as_array().is_some_and(|ns| {
                                ns.iter().any(|n| n["errorCategory"] != Value::Null)
                            })
                    })
                    .collect::<Vec<_>>(),
            )?,
        ),
    ] {
        zip.start_file(
            name,
            zip::write::SimpleFileOptions::default()
                .compression_method(zip::CompressionMethod::Deflated),
        )
        .map_err(|_| crate::Error::Runtime("Could not create diagnostics".into()))?;
        zip.write_all(&content)?;
    }
    Ok(zip
        .finish()
        .map_err(|_| crate::Error::Runtime("Could not finish diagnostics".into()))?
        .into_inner())
}
