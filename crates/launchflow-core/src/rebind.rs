use crate::{
    model::*,
    portable::{self, Document},
    Error, Result,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    collections::{BTreeMap, BTreeSet},
    path::Path,
};
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Mappings {
    #[serde(default)]
    pub applications: BTreeMap<String, String>,
    #[serde(default)]
    pub paths: BTreeMap<String, String>,
    #[serde(default)]
    pub secrets: BTreeMap<String, String>,
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Binding {
    pub kind: String,
    pub source: String,
    pub label: String,
    pub target: String,
    pub found: bool,
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Analysis {
    pub bindings: Vec<Binding>,
    pub warnings: Vec<String>,
    pub ready: bool,
    pub document: Document,
}
fn exists(p: &ApplicationProfile, os: &str) -> bool {
    // Bundle ID alone cannot prove availability without resolving NSWorkspace; require an app path.
    let path = if os == "windows" {
        &p.windows.executable
    } else {
        &p.macos.app_path
    };
    !path.is_empty() && Path::new(path).exists()
}
fn absolute(s: &str) -> bool {
    s.starts_with('/')
        || s.starts_with("\\\\")
        || (s.len() > 2
            && s.as_bytes()[0].is_ascii_alphabetic()
            && s.as_bytes()[1] == b':'
            && b"/\\".contains(&s.as_bytes()[2]))
}
fn remap_path(s: &str, mappings: &BTreeMap<String, String>) -> String {
    let mut entries: Vec<_> = mappings
        .iter()
        .filter(|(from, _)| !from.is_empty())
        .collect();
    entries.sort_by_key(|(from, _)| std::cmp::Reverse(from.len()));
    for (from, to) in entries {
        if s == from {
            return to.clone();
        }
        if let Some(tail) = s
            .strip_prefix(from.as_str())
            .filter(|tail| tail.starts_with(['/', '\\']))
        {
            return format!(
                "{}{}",
                to.trim_end_matches(['/', '\\']),
                tail.replace('\\', if to.contains('\\') { "\\" } else { "/" })
            );
        }
    }
    s.into()
}
fn walk_strings(value: &Value, out: &mut BTreeSet<String>) {
    match value {
        Value::String(s) => {
            out.insert(s.clone());
        }
        Value::Array(a) => {
            for v in a {
                walk_strings(v, out);
            }
        }
        Value::Object(o) => {
            for v in o.values() {
                walk_strings(v, out);
            }
        }
        _ => {}
    }
}
fn transform(value: &mut Value, f: &impl Fn(&str) -> String) {
    match value {
        Value::String(s) => *s = f(s),
        Value::Array(a) => {
            for v in a {
                transform(v, f);
            }
        }
        Value::Object(o) => {
            for v in o.values_mut() {
                transform(v, f);
            }
        }
        _ => {}
    }
}
pub fn analyze(
    original: &Document,
    mappings: &Mappings,
    known: &[ApplicationProfile],
    secret_ids: &BTreeSet<String>,
    asset_ids: &BTreeSet<String>,
    os: &str,
) -> Result<Analysis> {
    for (from, to) in &mappings.paths {
        if !absolute(from) || !absolute(to) || from.len() > 4096 || to.len() > 4096 {
            return Err(Error::Validation(
                "Path mappings require absolute paths".into(),
            ));
        }
    }
    for (from, to) in &mappings.secrets {
        if !crate::vault::valid_reference(from) || !crate::vault::valid_reference(to) {
            return Err(Error::Validation(
                "Secret mappings require references, never values".into(),
            ));
        }
    }
    let mut value = serde_json::to_value(original)?;
    transform(&mut value, &|s| {
        if absolute(s) {
            remap_path(s, &mappings.paths)
        } else {
            mappings.secrets.get(s).cloned().unwrap_or_else(|| s.into())
        }
    });
    let mut doc: Document = serde_json::from_value(value)?;
    let mut bindings = Vec::new();
    let mut apps = Vec::new();
    let mut app_ids = BTreeMap::new();
    let mut names = BTreeMap::new();
    for id in portable::references(&doc, "applicationId") {
        let foreign = doc.applications.iter().find(|p| p.id == id);
        let local =
            if let Some(target) = mappings.applications.get(&id) {
                Some(known.iter().find(|p| &p.id == target).ok_or_else(|| {
                    Error::Validation("Mapped application no longer exists".into())
                })?)
            } else {
                known.iter().find(|p| p.id == id).or_else(|| {
                    let matches: Vec<_> = known
                        .iter()
                        .filter(|p| {
                            foreign.is_some_and(|f| {
                                f.display_name.eq_ignore_ascii_case(&p.display_name)
                            }) && exists(p, os)
                        })
                        .collect();
                    if matches.len() == 1 {
                        Some(matches[0])
                    } else {
                        None
                    }
                })
            };
        let chosen = local.or(foreign);
        let found = chosen.is_some_and(|p| exists(p, os));
        bindings.push(Binding {
            kind: "application".into(),
            source: id.clone(),
            label: foreign
                .map(|p| p.display_name.clone())
                .unwrap_or_else(|| id.clone()),
            target: chosen.map(|p| p.id.clone()).unwrap_or_default(),
            found,
        });
        if let Some(p) = chosen {
            app_ids.insert(id, p.id.clone());
            if let Some(f) = foreign {
                let target = if os == "windows" {
                    &p.windows.process_name
                } else if !p.macos.bundle_id.is_empty() {
                    &p.macos.bundle_id
                } else {
                    &p.macos.process_name
                };
                for name in [
                    &f.windows.process_name,
                    &f.macos.bundle_id,
                    &f.macos.process_name,
                ] {
                    if !name.is_empty() {
                        names.insert(name.clone(), target.clone());
                    }
                }
            }
            if !apps.iter().any(|a: &ApplicationProfile| a.id == p.id) {
                apps.push(p.clone());
            }
        }
    }
    doc.applications = apps;
    fn rewrite(v: &mut Value, ids: &BTreeMap<String, String>, names: &BTreeMap<String, String>) {
        match v {
            Value::Object(o) => {
                for (key, map) in [("applicationId", ids), ("application", names)] {
                    if let Some(s) = o.get_mut(key) {
                        if let Some(replacement) = s.as_str().and_then(|s| map.get(s)) {
                            *s = Value::String(replacement.clone());
                        }
                    }
                }
                for v in o.values_mut() {
                    rewrite(v, ids, names);
                }
            }
            Value::Array(a) => {
                for v in a {
                    rewrite(v, ids, names);
                }
            }
            _ => {}
        }
    }
    let mut value = serde_json::to_value(&doc)?;
    rewrite(&mut value, &app_ids, &names);
    doc = serde_json::from_value(value)?;
    // Foreign platform bindings remain portable metadata and do not create false missing-path rows.
    let mut inspect = serde_json::to_value(&doc)?;
    if let Some(apps) = inspect["applications"].as_array_mut() {
        for app in apps {
            app[if os == "windows" { "macos" } else { "windows" }] = Value::Null;
        }
    }
    let mut strings = BTreeSet::new();
    walk_strings(&inspect, &mut strings);
    for source in strings {
        if absolute(&source) {
            let original = remap_path(
                &source,
                &mappings
                    .paths
                    .iter()
                    .map(|(a, b)| (b.clone(), a.clone()))
                    .collect(),
            );
            bindings.push(Binding {
                kind: "path".into(),
                source: original.clone(),
                label: original,
                target: source.clone(),
                found: Path::new(&source).exists(),
            });
        } else if crate::vault::valid_reference(&source) {
            let original = mappings
                .secrets
                .iter()
                .find(|(_, to)| *to == &source)
                .map(|(from, _)| from.clone())
                .unwrap_or_else(|| source.clone());
            let found = if let Some(id) = source.strip_prefix("vault:") {
                secret_ids.contains(id)
            } else {
                source.strip_prefix("env:").is_some_and(|key| {
                    key != "UNRESOLVED" && std::env::var_os(key).is_some_and(|s| !s.is_empty())
                })
            };
            bindings.push(Binding {
                kind: "secret".into(),
                source: original.clone(),
                label: original,
                target: source,
                found,
            });
        }
    }
    for id in portable::references(&doc, "assetId") {
        bindings.push(Binding {
            kind: "asset".into(),
            source: id.clone(),
            label: id.clone(),
            target: id.clone(),
            found: asset_ids.contains(&id),
        });
    }
    portable::validate(&doc)?;
    let mut warnings=vec!["Import does not execute workflows. All triggers are disabled, startup command permission is removed, and sensitive actions require confirmation.".into()];
    if portable::scenes(&doc).any(|s| s.workflow.nodes.iter().any(crate::policy::sensitive)) {
        warnings.push("Contains sensitive actions. Review commands, arguments, GUI targets and inputs before enabling execution.".into());
    }
    let ready = bindings.iter().all(|b| b.found);
    Ok(Analysis {
        bindings,
        warnings,
        ready,
        document: doc,
    })
}
pub fn prepare_import(mut doc: Document) -> Result<Document> {
    let ids: BTreeMap<String, String> = portable::scenes(&doc)
        .map(|s| (s.id.clone(), id()))
        .collect();
    for s in std::iter::once(&mut doc.scene).chain(&mut doc.subflows) {
        s.id = ids[&s.id].clone();
        s.version = 0;
        s.is_default = false;
        s.allow_commands_at_startup = false;
        s.sensitive_action_policy = crate::policy::SensitiveActionPolicy::AskEveryTime;
        s.created_at = now();
        s.updated_at = now();
        for t in &mut s.triggers {
            t.enabled = false;
        }
        for n in &mut s.workflow.nodes {
            if n.node_type == "flow.subflow" {
                if let Some(old) = n.config["sceneId"].as_str() {
                    n.config["sceneId"] = Value::String(
                        ids.get(old)
                            .ok_or_else(|| Error::Validation("Missing imported subflow".into()))?
                            .clone(),
                    );
                }
            }
        }
    }
    Ok(doc)
}
