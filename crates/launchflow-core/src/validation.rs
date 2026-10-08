use crate::{model::*, parameters, registry::NodeRegistry, Error, Result};
use serde_json::Value;
use std::collections::{HashMap, HashSet, VecDeque};

pub fn graph_order(workflow: &Workflow) -> Result<Vec<String>> {
    let mut degree = HashMap::new();
    for n in &workflow.nodes {
        if n.id.is_empty() || degree.insert(n.id.as_str(), 0usize).is_some() {
            return Err(Error::Validation(
                "Node IDs must be nonempty and unique".into(),
            ));
        }
    }
    let mut ids = HashSet::new();
    let mut pairs = HashSet::new();
    for e in &workflow.edges {
        if !degree.contains_key(e.from.as_str()) || !degree.contains_key(e.to.as_str()) {
            return Err(Error::Validation("Edge references a missing node".into()));
        }
        if e.id.is_empty() || !ids.insert(&e.id) || !pairs.insert((&e.from, &e.to, &e.outlet)) {
            return Err(Error::Validation("Invalid or duplicate edge".into()));
        }
        *degree.get_mut(e.to.as_str()).expect("checked") += 1;
    }
    let mut ready: VecDeque<_> = workflow
        .nodes
        .iter()
        .filter(|n| degree[n.id.as_str()] == 0)
        .map(|n| n.id.as_str())
        .collect();
    let mut order = vec![];
    while let Some(id) = ready.pop_front() {
        order.push(id.to_string());
        for e in workflow.edges.iter().filter(|e| e.from == id) {
            let d = degree.get_mut(e.to.as_str()).expect("checked");
            *d -= 1;
            if *d == 0 {
                ready.push_back(&e.to);
            }
        }
    }
    if order.len() != workflow.nodes.len() {
        return Err(Error::Validation("Circular dependency detected".into()));
    }
    Ok(order)
}
pub fn ancestors(workflow: &Workflow, node: &str) -> HashSet<String> {
    let mut set = HashSet::new();
    let mut pending = vec![node.to_string()];
    while let Some(id) = pending.pop() {
        for e in workflow.edges.iter().filter(|e| e.to == id) {
            if set.insert(e.from.clone()) {
                pending.push(e.from.clone());
            }
        }
    }
    set
}
fn validate_references(value: &Value, scene: &Scene, node: &Node) -> Result<()> {
    match value {
        Value::String(s) => {
            for key in parameters::references(s)? {
                if scene.parameters.iter().any(|p| p.name == key)
                    || ["run.id", "run.startTime"].contains(&key)
                {
                    continue;
                }
                if let Some((id, tail)) = key
                    .strip_prefix("node.")
                    .and_then(|p| p.split_once(".output"))
                {
                    if (tail.is_empty() || tail.starts_with('.'))
                        && ancestors(&scene.workflow, &node.id).contains(id)
                    {
                        continue;
                    }
                }
                return Err(Error::Validation(format!(
                    "Unknown variable or non-upstream output reference: {key}"
                )));
            }
        }
        Value::Array(a) => {
            for v in a {
                validate_references(v, scene, node)?;
            }
        }
        Value::Object(o) => {
            for v in o.values() {
                validate_references(v, scene, node)?;
            }
        }
        _ => {}
    }
    Ok(())
}
/// Deferred values get representative values for structural validation; actual
/// values are fully validated again before invoking the runner.
fn structural(value: &Value, sample: Option<&Value>, key: &str) -> Value {
    match value {
        Value::String(s) if s.contains("${") => sample
            .filter(|v| !v.is_null() && *v != "")
            .cloned()
            .unwrap_or_else(|| {
                if key == "target" || key == "url" {
                    Value::String("https://example.com".into())
                } else {
                    Value::String("reference".into())
                }
            }),
        Value::Array(a) => Value::Array(a.iter().map(|v| structural(v, None, "")).collect()),
        Value::Object(o) => Value::Object(
            o.iter()
                .map(|(k, v)| (k.clone(), structural(v, sample.and_then(|s| s.get(k)), k)))
                .collect(),
        ),
        _ => value.clone(),
    }
}
pub fn validate_scene(
    scene: &Scene,
    registry: &NodeRegistry,
    profiles: &[ApplicationProfile],
    _os: &str,
    for_run: bool,
) -> Vec<ValidationIssue> {
    let mut issues = vec![];
    let mut add = |node_id, message| issues.push(ValidationIssue { node_id, message });
    if scene.schema_version != SCHEMA_VERSION {
        add(None, "Unsupported scene schema version".into());
    }
    if scene.id.is_empty() || scene.name.trim().is_empty() || scene.name.len() > 200 {
        add(None, "Scene ID and name are required (name max 200)".into());
    }
    if scene.workflow.nodes.len() > 256 || scene.workflow.edges.len() > 4096 {
        add(None, "Workflow exceeds 256 nodes or 4096 edges".into());
    }
    if for_run && scene.workflow.nodes.is_empty() {
        add(None, "Add at least one node before running".into());
    }
    if !(1..=32).contains(&scene.max_parallel) {
        add(None, "Parallel limit must be 1–32".into());
    }
    if let Err(e) = graph_order(&scene.workflow) {
        add(None, e.to_string());
    }
    if let Err(e) = parameters::validate_definitions(&scene.parameters) {
        add(None, e.to_string());
    }
    for n in &scene.workflow.nodes {
        let mut issue = |message| add(Some(n.id.clone()), message);
        if n.name.trim().is_empty() {
            issue("Node name is required".into());
        }
        if !(1..=86_400_000).contains(&n.timeout_ms) {
            issue("Timeout must be 1 ms–24 hours".into());
        }
        if n.retry_policy.max_retries > 20 || n.retry_policy.delay_ms > 3_600_000 {
            issue("Retry is limited to 20 retries and a one-hour delay".into());
        }
        if n.platform_constraint
            .iter()
            .any(|p| !["windows", "macos"].contains(&p.as_str()))
        {
            issue("Unknown platform constraint".into());
        }
        if !n.inputs.is_empty() || !n.outputs.is_empty() {
            issue("Use config references and runtime outputs; custom input/output declarations are unsupported".into());
        }
        if let Err(e) = validate_references(&n.config, scene, n) {
            issue(e.to_string());
        }
        match registry.runner(&n.node_type) {
            Ok(r) => {
                if let Err(e) =
                    r.validate(&structural(&n.config, Some(&r.definition().defaults), ""))
                {
                    issue(e.to_string());
                }
            }
            Err(e) => issue(e.to_string()),
        }
        if n.node_type == "flow.subflow"
            && n.config
                .get("sceneId")
                .and_then(Value::as_str)
                .is_some_and(|s| s.contains("${"))
        {
            issue("Subflow sceneId must be a fixed scene reference".into());
        }
        // Check binding paths and OS constraints only when a branch executes.
        if for_run && n.enabled && n.node_type == "application.launch" {
            if let Some(id) = n
                .config
                .get("applicationId")
                .and_then(Value::as_str)
                .filter(|s| !s.contains("${"))
            {
                if !profiles.iter().any(|p| p.id == id) {
                    issue(
                        "Application profile is missing; bind it in the application library".into(),
                    );
                }
            }
        }
        if n.failure_policy == FailurePolicy::FailureBranch
            && !scene
                .workflow
                .edges
                .iter()
                .any(|e| e.from == n.id && e.outlet == "failure")
        {
            issue("Failure Branch requires an outgoing failure edge".into());
        }
        for edge in scene.workflow.edges.iter().filter(|e| e.from == n.id) {
            let allowed = if edge.outlet == "failure" {
                n.failure_policy == FailurePolicy::FailureBranch
            } else if n.node_type == "flow.condition" {
                ["true", "false"].contains(&edge.outlet.as_str())
            } else {
                edge.outlet == "success"
            };
            if !allowed {
                issue(format!("Invalid edge outlet: {}", edge.outlet));
            }
        }
    }
    issues
}
pub fn validate_profile(p: &ApplicationProfile) -> Result<()> {
    if p.schema_version != 1 || p.id.trim().is_empty() || p.display_name.trim().is_empty() {
        return Err(Error::Validation(
            "Application ID/name/schema are invalid".into(),
        ));
    }
    if p.launch_arguments
        .iter()
        .any(|s| s.contains("${") || s.contains('\0'))
    {
        return Err(Error::Validation(
            "Invalid or unsupported application argument".into(),
        ));
    }
    match &p.ready_detection {
        Some(ReadyDetection::Process { process_name }) if process_name.trim().is_empty() => Err(
            Error::Validation("Readiness process name is required".into()),
        ),
        Some(ReadyDetection::Port { host, port }) if host.trim().is_empty() || *port == 0 => Err(
            Error::Validation("Readiness host and port are required".into()),
        ),
        _ => Ok(()),
    }
}
