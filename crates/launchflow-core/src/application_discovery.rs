use crate::{automation::AutomationProvider, model::*, Error, Result};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::collections::BTreeMap;

pub fn identity(profile: &ApplicationProfile, os: &str) -> String {
    if os == "windows" {
        let path = profile
            .windows
            .executable
            .trim()
            .replace('/', "\\")
            .trim_start_matches("\\\\?\\")
            .to_lowercase();
        let system = format!(
            "{}\\system32\\",
            std::env::var("WINDIR")
                .unwrap_or_else(|_| "C:\\Windows".into())
                .replace('/', "\\")
                .to_lowercase()
        );
        let builtins = [
            ("notepad.exe", "microsoft.windowsnotepad_"),
            ("calc.exe", "microsoft.windowscalculator_"),
            ("mspaint.exe", "microsoft.paint_"),
            ("snippingtool.exe", "microsoft.screensketch_"),
        ];
        if let Some(file) = path.strip_prefix(&system) {
            if let Some((_, package)) = builtins.iter().find(|(exe, _)| *exe == file) {
                return format!("builtin:{package}");
            }
        }
        if path.ends_with("\\explorer.exe") {
            if let Some(app) = profile
                .launch_arguments
                .first()
                .filter(|s| s.to_lowercase().starts_with("shell:appsfolder\\"))
            {
                let app = app.to_lowercase();
                if let Some((_, package)) = builtins
                    .iter()
                    .find(|(_, package)| app.starts_with(&format!("shell:appsfolder\\{package}")))
                {
                    return format!("builtin:{package}");
                }
                return app.to_lowercase();
            }
        }
        path
    } else if !profile.macos.bundle_id.is_empty() {
        format!("bundle:{}", profile.macos.bundle_id)
    } else {
        profile.macos.app_path.clone()
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Candidate {
    pub key: String,
    pub profile: ApplicationProfile,
    pub categories: Vec<String>,
    pub existing_id: Option<String>,
    pub unavailable: Option<String>,
}
#[derive(Serialize)]
pub struct Capture {
    pub apps: Vec<Candidate>,
    pub warnings: Vec<String>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct NativeCandidate {
    name: String,
    executable: String,
    arguments: Vec<String>,
    process_name: String,
    category: String,
    unavailable: String,
}

pub async fn capture(
    provider: &dyn AutomationProvider,
    os: &str,
    source: &str,
    known: &[ApplicationProfile],
) -> Result<Capture> {
    if !["workspace", "system"].contains(&source) {
        return Err(Error::Validation(
            "Unknown application capture source".into(),
        ));
    }
    let mut found = Vec::new();
    let warnings;
    if os == "windows" {
        let raw = provider
            .request(json!({"op":"applicationDiscover","source":source}))
            .await
            .map_err(|e| Error::Runtime(e.message))?;
        warnings = serde_json::from_value(raw["warnings"].clone())?;
        for row in serde_json::from_value::<Vec<NativeCandidate>>(raw["apps"].clone())? {
            found.push((
                ApplicationProfile {
                    schema_version: 1,
                    id: id(),
                    display_name: row.name,
                    windows: WindowsBinding {
                        executable: row.executable,
                        process_name: row.process_name,
                        ..Default::default()
                    },
                    macos: MacosBinding::default(),
                    launch_arguments: row.arguments,
                    ready_detection: None,
                },
                row.category,
                row.unavailable,
            ));
        }
    } else if source == "workspace" {
        warnings = vec![];
        for window in crate::workspace::capture(provider, os, known)
            .await?
            .windows
        {
            let unavailable = if window.application.macos.app_path.is_empty()
                && window.application.macos.bundle_id.is_empty()
            {
                "无法读取应用路径，请手动添加"
            } else {
                ""
            };
            found.push((window.application, "工作区应用".into(), unavailable.into()));
        }
    } else {
        return Err(Error::Validation(
            "系统默认应用捕获目前支持 Windows。".into(),
        ));
    }
    let mut apps: BTreeMap<String, Candidate> = BTreeMap::new();
    for (profile, category, unavailable) in found {
        let mut key = identity(&profile, os);
        if key.is_empty() {
            key = format!("unavailable:{}", profile.display_name);
        }
        let existing = known.iter().find(|p| identity(p, os) == key);
        let candidate = apps.entry(key.clone()).or_insert_with(|| Candidate {
            key,
            profile,
            categories: vec![],
            existing_id: existing.map(|p| p.id.clone()),
            unavailable: if unavailable.is_empty() {
                None
            } else {
                Some(unavailable)
            },
        });
        if !candidate.categories.contains(&category) {
            candidate.categories.push(category);
        }
    }
    let mut apps: Vec<_> = apps.into_values().collect();
    apps.sort_by(|a, b| a.profile.display_name.cmp(&b.profile.display_name));
    Ok(Capture { apps, warnings })
}
