use crate::{Error, Result};
use serde::Serialize;
use serde_json::Value;

/// Reject recognizable credential literals at the persistence
/// boundary instead of silently storing them in a draft, scene, or application profile.
/// Arbitrary opaque text cannot reliably be classified; use secret references.
pub fn check_storage_values(value: &impl Serialize) -> Result<()> {
    fn reference(value: &Value) -> bool {
        value.as_str().is_some_and(|s| {
            crate::vault::valid_reference(s) || (s.starts_with("${") && s.ends_with('}'))
        })
    }
    fn unsafe_value(value: &Value) -> bool {
        match value {
            Value::String(text) => {
                let text = text.to_ascii_lowercase();
                [
                    "password=",
                    "password:",
                    "passwd=",
                    "--password",
                    "--passwd",
                    "token=",
                    "token:",
                    "--token",
                    "api_key=",
                    "apikey=",
                    "api-key=",
                    "--api-key",
                    "authorization:",
                    "bearer ",
                    "-----begin private key",
                    "-----begin rsa private key",
                ]
                .iter()
                .any(|pattern| text.contains(pattern))
            }
            Value::Array(items) => items.iter().enumerate().any(|(i, v)| {
                if v.as_str().is_some_and(|s| {
                    ["--password", "--passwd", "--token", "--api-key"].contains(&s)
                }) && items.get(i + 1).is_some_and(reference)
                {
                    false
                } else {
                    unsafe_value(v)
                }
            }),
            Value::Object(map) => map.iter().any(|(key, value)| {
                let key = key.to_ascii_lowercase().replace(['_', '-'], "");
                ([
                    "password",
                    "passwd",
                    "secret",
                    "token",
                    "apikey",
                    "authorization",
                ]
                .contains(&key.as_str())
                    && !value.is_null()
                    && value != "")
                    && !reference(value)
                    || unsafe_value(value)
            }),
            _ => false,
        }
    }
    if unsafe_value(&serde_json::to_value(value)?) {
        return Err(Error::Validation("Credential-like values cannot be saved. Use Secret Reference parameters instead of passwords, tokens and private keys.".into()));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn rejects_recognizable_credentials_without_echoing_them() {
        for value in [
            json!({"arguments":["--password","dont-store-me"]}),
            json!({"target":"https://localhost/?token=abc"}),
            json!({"api_key":"abc"}),
        ] {
            let error = check_storage_values(&value).unwrap_err().to_string();
            assert!(!error.contains("dont-store-me"));
            assert!(!error.contains("abc"));
        }
        assert!(check_storage_values(
            &json!({"arguments":["D:/workspace/project","--port","8080"]})
        )
        .is_ok());
    }
}
