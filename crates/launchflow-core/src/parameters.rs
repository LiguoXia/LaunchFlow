//! Small, explicit template language. No evaluation, shell expansion or arbitrary expressions.
use crate::{model::*, Error, Result};
use serde_json::Value;
use std::collections::{BTreeMap, HashSet};

pub type Values = BTreeMap<String, Value>;
pub fn validate_definitions(parameters: &[Parameter]) -> Result<()> {
    let mut names = HashSet::new();
    for p in parameters {
        if p.name.is_empty()
            || p.name.len() > 64
            || !p
                .name
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '_')
            || p.name.as_bytes()[0].is_ascii_digit()
            || !names.insert(&p.name)
            || ["run", "node"].contains(&p.name.as_str())
        {
            return Err(Error::Validation(
                "Parameter names must be unique identifiers (1–64 characters)".into(),
            ));
        }
        if ![
            "string",
            "number",
            "boolean",
            "select",
            "file",
            "directory",
            "secretReference",
        ]
        .contains(&p.kind.as_str())
        {
            return Err(Error::Validation(format!(
                "Unsupported parameter type: {}",
                p.kind
            )));
        }
        if p.kind == "select" && p.options.is_empty() {
            return Err(Error::Validation(format!(
                "{} needs select options",
                p.name
            )));
        }
        if let Some(pattern) = &p.validation.pattern {
            if pattern.len() > 512 || regex::Regex::new(pattern).is_err() {
                return Err(Error::Validation(format!(
                    "Invalid validation pattern for {}",
                    p.name
                )));
            }
        }
        if p.validation
            .min
            .zip(p.validation.max)
            .is_some_and(|(a, b)| a > b)
        {
            return Err(Error::Validation(
                "Parameter minimum exceeds maximum".into(),
            ));
        }
        if !p.default_value.is_null() {
            validate_value(p, &p.default_value)?;
        }
    }
    Ok(())
}
fn validate_value(p: &Parameter, value: &Value) -> Result<()> {
    let valid = match p.kind.as_str() {
        "number" => value.is_number(),
        "boolean" => value.is_boolean(),
        "select" => value
            .as_str()
            .is_some_and(|s| p.options.iter().any(|o| o == s)),
        "secretReference" => value.as_str().is_some_and(crate::vault::valid_reference),
        _ => value.is_string(),
    };
    if !valid {
        return Err(Error::Validation(format!(
            "Invalid value type or option for parameter {}",
            p.name
        )));
    }
    let measure = value
        .as_f64()
        .or_else(|| value.as_str().map(|s| s.chars().count() as f64));
    if measure.is_some_and(|n| {
        p.validation.min.is_some_and(|m| n < m) || p.validation.max.is_some_and(|m| n > m)
    }) {
        return Err(Error::Validation(format!(
            "Parameter {} is outside its validation bounds",
            p.name
        )));
    }
    if let (Some(pattern), Some(s)) = (&p.validation.pattern, value.as_str()) {
        if !regex::Regex::new(pattern)
            .map_err(|_| Error::Validation("Invalid parameter pattern".into()))?
            .is_match(s)
        {
            return Err(Error::Validation(format!(
                "Parameter {} does not match its pattern",
                p.name
            )));
        }
    }
    Ok(())
}
pub fn bind(parameters: &[Parameter], supplied: &Values) -> Result<Values> {
    validate_definitions(parameters)?;
    if supplied
        .keys()
        .any(|k| !parameters.iter().any(|p| &p.name == k))
    {
        return Err(Error::Validation("Unknown parameter supplied".into()));
    }
    let mut values = Values::new();
    for p in parameters {
        let value = supplied.get(&p.name).unwrap_or(&p.default_value);
        if value.is_null() || (p.required && value.as_str() == Some("")) {
            if p.required {
                return Err(Error::Validation(format!(
                    "Missing required parameter: {}",
                    p.name
                )));
            }
            values.insert(p.name.clone(), Value::Null);
        } else {
            validate_value(p, value)?;
            values.insert(p.name.clone(), value.clone());
        }
    }
    crate::safety::check_storage_values(&values)?;
    Ok(values)
}
pub async fn runtime_values(
    parameters: &[Parameter],
    snapshot: &Values,
    provider: &dyn crate::automation::AutomationProvider,
) -> Result<(Values, Vec<String>)> {
    let mut values = snapshot.clone();
    let mut secrets = vec![];
    for p in parameters.iter().filter(|p| p.kind == "secretReference") {
        if let Some(reference) = values.get(&p.name).and_then(Value::as_str) {
            let secret = crate::vault::read(reference, provider).await?;
            secrets.push(secret.clone());
            values.insert(p.name.clone(), Value::String(secret));
        }
    }
    Ok((values, secrets))
}
pub fn references(text: &str) -> Result<Vec<&str>> {
    let mut rest = text;
    let mut found = vec![];
    while let Some(start) = rest.find("${") {
        rest = &rest[start + 2..];
        let end = rest
            .find('}')
            .ok_or_else(|| Error::Validation("Unclosed variable reference".into()))?;
        let key = &rest[..end];
        if key.is_empty()
            || key
                .chars()
                .any(|c| !(c.is_ascii_alphanumeric() || ['_', '.', '-'].contains(&c)))
        {
            return Err(Error::Validation("Invalid variable reference".into()));
        }
        found.push(key);
        rest = &rest[end + 1..];
    }
    Ok(found)
}
pub fn resolve(value: &Value, parameters: &Values, run: &Run) -> Result<Value> {
    fn lookup(key: &str, parameters: &Values, run: &Run) -> Result<Value> {
        if let Some(v) = parameters.get(key) {
            return Ok(v.clone());
        }
        match key {
            "run.id" => return Ok(Value::String(run.id.clone())),
            "run.startTime" => return Ok(Value::String(run.started_at.clone())),
            _ => {}
        }
        if let Some(path) = key.strip_prefix("node.") {
            if let Some((id, tail)) = path.split_once(".output") {
                if let Some(node) = run
                    .node_runs
                    .iter()
                    .find(|n| n.node_id == id && n.outlet.is_some())
                {
                    let mut value = &node.output;
                    if !tail.is_empty() {
                        if !tail.starts_with('.') {
                            return Err(Error::Validation("Invalid output reference".into()));
                        }
                        for part in tail[1..].split('.') {
                            value = value.get(part).ok_or_else(|| {
                                Error::Validation(format!("Output field unavailable: {key}"))
                            })?;
                        }
                    }
                    return Ok(value.clone());
                }
            }
        }
        Err(Error::Validation(format!("Variable is unavailable: {key}")))
    }
    Ok(match value {
        Value::String(text) => {
            let refs = references(text)?;
            if refs.len() == 1 && text == &format!("${{{}}}", refs[0]) {
                lookup(refs[0], parameters, run)?
            } else {
                let mut output = String::new();
                let mut rest = text.as_str();
                for key in refs {
                    let start = rest.find("${").expect("parsed");
                    output.push_str(&rest[..start]);
                    let v = lookup(key, parameters, run)?;
                    match v {
                        Value::String(s) => output.push_str(&s),
                        Value::Object(_) | Value::Array(_) => return Err(Error::Validation(
                            "Object outputs require an exact variable reference or a field path"
                                .into(),
                        )),
                        _ => output.push_str(&v.to_string()),
                    }
                    rest = &rest[start + key.len() + 3..];
                }
                output.push_str(rest);
                Value::String(output)
            }
        }
        Value::Array(a) => Value::Array(
            a.iter()
                .map(|v| resolve(v, parameters, run))
                .collect::<Result<_>>()?,
        ),
        Value::Object(o) => Value::Object(
            o.iter()
                .map(|(k, v)| Ok((k.clone(), resolve(v, parameters, run)?)))
                .collect::<Result<_>>()?,
        ),
        _ => value.clone(),
    })
}
pub fn scrub(text: &str, secrets: &[String]) -> String {
    let mut safe = text.to_string();
    for s in secrets {
        if !s.is_empty() {
            safe = safe.replace(s, "[secret redacted]");
        }
    }
    crate::registry::redact(&safe)
}
pub fn scrub_value(value: &mut Value, secrets: &[String]) {
    match value {
        Value::String(s) => *s = scrub(s, secrets),
        Value::Array(a) => a.iter_mut().for_each(|v| scrub_value(v, secrets)),
        Value::Object(o) => o.values_mut().for_each(|v| scrub_value(v, secrets)),
        _ => {}
    }
}
