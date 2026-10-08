//! Secret values are read only inside the executor; the desktop API exposes metadata and writes.
use crate::{automation::AutomationProvider, Error, Result};
use serde_json::json;
pub fn valid_reference(reference: &str) -> bool {
    if let Some(key) = reference.strip_prefix("vault:") {
        valid_id(key)
    } else if let Some(key) = reference.strip_prefix("env:") {
        !key.is_empty()
            && key.len() <= 128
            && key.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'_')
    } else {
        false
    }
}
pub fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 64
        && id
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || b"_.-".contains(&c))
}
pub async fn read(reference: &str, provider: &dyn AutomationProvider) -> Result<String> {
    if !valid_reference(reference) {
        return Err(Error::Validation(
            "Use a vault:ID or env:NAME secret reference".into(),
        ));
    }
    let value = if let Some(key) = reference.strip_prefix("env:") {
        if key == "UNRESOLVED" {
            return Err(Error::Validation(
                "Bind the secret reference before execution".into(),
            ));
        }
        std::env::var(key).map_err(|_| {
            Error::Validation("Secret reference is unavailable on this device".into())
        })?
    } else {
        provider
            .request(json!({"op":"vault","action":"read","id":&reference[6..]}))
            .await
            .map_err(|e| Error::Runtime(format!("{}: {}", e.code, e.message)))?["value"]
            .as_str()
            .ok_or_else(|| Error::Runtime("Invalid vault response".into()))?
            .to_owned()
    };
    if value.is_empty() {
        return Err(Error::Validation("Secret reference is empty".into()));
    }
    Ok(value)
}
