//! Disposable device-local icons, separate from profiles and portable workflow documents.
use crate::automation::AutomationProvider;
use base64::{engine::general_purpose::STANDARD, Engine as _};
use serde::{Deserialize, Serialize};
use serde_json::json;
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::Cursor,
    path::Path,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IconSource {
    #[serde(default)]
    pub path: String,
    #[serde(default)]
    pub bundle_id: String,
}

#[derive(Deserialize, Serialize)]
struct CachedIcon {
    path: String,
    fingerprint: String,
    png: String,
}

fn fingerprint(path: &str) -> Option<String> {
    let meta = fs::metadata(path).ok()?;
    Some(format!(
        "{}:{}",
        meta.len(),
        meta.modified()
            .ok()?
            .duration_since(UNIX_EPOCH)
            .ok()?
            .as_nanos()
    ))
}

fn valid_png(png: &str) -> bool {
    if png.len() > 90_000 {
        return false;
    }
    let Ok(bytes) = STANDARD.decode(png) else {
        return false;
    };
    image::ImageReader::with_format(Cursor::new(bytes), image::ImageFormat::Png)
        .into_dimensions()
        .is_ok_and(|(w, h)| w > 0 && h > 0 && w <= 128 && h <= 128)
}

fn cache_key(source: &IconSource) -> String {
    let path = if cfg!(windows) {
        source.path.replace('/', "\\").to_lowercase()
    } else {
        source.path.clone()
    };
    format!(
        "{:x}",
        Sha256::digest(format!("v1\0{path}\0{}", source.bundle_id))
    )
}

fn cached(directory: &Path, source: &IconSource) -> Option<String> {
    let file = directory.join(cache_key(source));
    let meta = fs::metadata(&file).ok()?;
    if meta.len() > 100_000 || meta.modified().ok()?.elapsed().ok()? > Duration::from_secs(86400) {
        return None;
    }
    let record: CachedIcon = serde_json::from_slice(&fs::read(file).ok()?).ok()?;
    if fingerprint(&record.path)? != record.fingerprint || !valid_png(&record.png) {
        return None;
    }
    Some(record.png)
}

fn prune(directory: &Path) {
    let Ok(entries) = fs::read_dir(directory) else {
        return;
    };
    let mut files: Vec<_> = entries
        .flatten()
        .filter(|e| {
            let name = e.file_name();
            let name = name.to_string_lossy();
            name.len() == 64 && name.bytes().all(|b| b.is_ascii_hexdigit())
        })
        .collect();
    files.sort_by_key(|e| {
        e.metadata()
            .and_then(|m| m.modified())
            .unwrap_or(SystemTime::UNIX_EPOCH)
    });
    let remove = files.len().saturating_sub(256);
    for file in files.into_iter().take(remove) {
        let _ = fs::remove_file(file.path());
    }
}

/// A caller-side mutex serializes batches; native failures degrade only the missing icons.
pub async fn load(
    provider: &dyn AutomationProvider,
    sources: Vec<IconSource>,
) -> Vec<Option<String>> {
    let directory = provider.paths().data.join("application-icons-v1");
    let mut result = vec![None; sources.len()];
    let mut missing = Vec::new();
    for (index, source) in sources.iter().enumerate() {
        // Do not resolve URLs, relative paths or UNC/device paths as shell resources.
        let local = if cfg!(windows) {
            let b = source.path.as_bytes();
            let app = source
                .path
                .strip_prefix("shell:AppsFolder\\")
                .is_some_and(|id| {
                    !id.is_empty()
                        && id.contains('!')
                        && id
                            .bytes()
                            .all(|c| c.is_ascii_alphanumeric() || b"._!-".contains(&c))
                });
            app || (b.len() >= 3
                && b[0].is_ascii_alphabetic()
                && b[1] == b':'
                && (b[2] == b'\\' || b[2] == b'/'))
        } else {
            source.path.starts_with('/') || (source.path.is_empty() && !source.bundle_id.is_empty())
        };
        if !local || source.path.len() > 4096 || source.bundle_id.len() > 255 {
            continue;
        }
        if let Some(png) = cached(&directory, source) {
            result[index] = Some(format!("data:image/png;base64,{png}"));
        } else {
            missing.push(index);
        }
    }
    if missing.is_empty() {
        return result;
    }
    let request: Vec<_> = missing.iter().map(|&i| &sources[i]).collect();
    if let Ok(value) = provider
        .request(json!({"op":"applicationIcons", "sources":request}))
        .await
    {
        let _ = fs::create_dir_all(&directory);
        for (offset, &index) in missing.iter().enumerate() {
            let Some(png) = value[offset]["png"].as_str().filter(|png| valid_png(png)) else {
                continue;
            };
            result[index] = Some(format!("data:image/png;base64,{png}"));
            if let Some(path) = value[offset]["path"].as_str() {
                if let Some(fingerprint) = fingerprint(path) {
                    let record = CachedIcon {
                        path: path.into(),
                        fingerprint,
                        png: png.into(),
                    };
                    if let Ok(bytes) = serde_json::to_vec(&record) {
                        let _ = fs::write(directory.join(cache_key(&sources[index])), bytes);
                    }
                }
            }
        }
        prune(&directory);
    }
    result
}
