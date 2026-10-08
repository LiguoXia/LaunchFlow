//! Versioned, non-executing scene exchange. Parsing and package verification never write files.
use crate::{model::*, registry::NodeRegistry, Error, Result};
use serde::{
    de::{self, DeserializeSeed, MapAccess, SeqAccess, Visitor},
    Deserialize, Serialize,
};
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet},
    io::{Cursor, Read, Write},
    path::Path,
};
pub const FORMAT_VERSION: u32 = 2;
const DOCUMENT_LIMIT: usize = 1024 * 1024;
const PACKAGE_LIMIT: usize = 64 * 1024 * 1024;
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Document {
    pub schema_version: u32,
    pub scene: Scene,
    #[serde(default)]
    pub subflows: Vec<Scene>,
    #[serde(default)]
    pub applications: Vec<ApplicationProfile>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Manifest {
    package_version: u32,
    schema_version: u32,
    files: BTreeMap<String, String>,
}
#[derive(Debug, Clone)]
pub struct ImportSource {
    pub document: Document,
    pub assets: BTreeMap<String, Vec<u8>>,
    pub migrated: bool,
}

// Bound expansion while visiting, before aliases or nested collections can allocate arbitrarily.
struct Seed<'a> {
    budget: &'a mut usize,
    depth: usize,
}
impl<'de> DeserializeSeed<'de> for Seed<'_> {
    type Value = Value;
    fn deserialize<D: de::Deserializer<'de>>(self, d: D) -> std::result::Result<Value, D::Error> {
        if self.depth > 48 || *self.budget < 64 {
            return Err(de::Error::custom("Document expansion limit exceeded"));
        }
        *self.budget -= 64;
        d.deserialize_any(self)
    }
}
impl<'de> Visitor<'de> for Seed<'_> {
    type Value = Value;
    fn expecting(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
        f.write_str("a bounded scene document")
    }
    fn visit_bool<E: de::Error>(self, v: bool) -> std::result::Result<Value, E> {
        Ok(v.into())
    }
    fn visit_i64<E: de::Error>(self, v: i64) -> std::result::Result<Value, E> {
        Ok(v.into())
    }
    fn visit_u64<E: de::Error>(self, v: u64) -> std::result::Result<Value, E> {
        Ok(v.into())
    }
    fn visit_f64<E: de::Error>(self, v: f64) -> std::result::Result<Value, E> {
        serde_json::Number::from_f64(v)
            .map(Value::Number)
            .ok_or_else(|| E::custom("Non-finite number"))
    }
    fn visit_unit<E: de::Error>(self) -> std::result::Result<Value, E> {
        Ok(Value::Null)
    }
    fn visit_str<E: de::Error>(self, v: &str) -> std::result::Result<Value, E> {
        if v.len() > 131072 || v.len() > *self.budget {
            return Err(E::custom("String expansion limit"));
        }
        *self.budget -= v.len();
        Ok(v.into())
    }
    fn visit_seq<A: SeqAccess<'de>>(self, mut a: A) -> std::result::Result<Value, A::Error> {
        let mut items = Vec::new();
        while let Some(v) = a.next_element_seed(Seed {
            budget: self.budget,
            depth: self.depth + 1,
        })? {
            items.push(v);
        }
        Ok(Value::Array(items))
    }
    fn visit_map<A: MapAccess<'de>>(self, mut a: A) -> std::result::Result<Value, A::Error> {
        let mut items = Map::new();
        while let Some(k) = a.next_key::<String>()? {
            if k.len() > 256 || items.contains_key(&k) {
                return Err(de::Error::custom("Invalid or duplicate key"));
            }
            let v = a.next_value_seed(Seed {
                budget: self.budget,
                depth: self.depth + 1,
            })?;
            items.insert(k, v);
        }
        Ok(Value::Object(items))
    }
}
pub fn parse(text: &str) -> Result<ImportSource> {
    if text.len() > DOCUMENT_LIMIT {
        return Err(invalid("Scene YAML exceeds 1 MiB"));
    }
    let mut budget = 4 * 1024 * 1024;
    let value=Seed{budget:&mut budget,depth:0}.deserialize(serde_yaml_ng::Deserializer::from_str(text)).map_err(|_|invalid("Invalid YAML: use one document with unique keys, finite values, no custom tags, and bounded nesting"))?;
    let version = value
        .get("schemaVersion")
        .and_then(Value::as_u64)
        .ok_or_else(|| invalid("schemaVersion is required"))?;
    if version != 1 && version != u64::from(FORMAT_VERSION) {
        return Err(invalid(
            "Unsupported document schemaVersion; update LaunchFlow before importing",
        ));
    }
    let migrated = version == 1;
    let document = if migrated {
        Document {
            schema_version: FORMAT_VERSION,
            scene: serde_json::from_value(value)
                .map_err(|_| invalid("Invalid legacy scene schema"))?,
            subflows: vec![],
            applications: vec![],
        }
    } else {
        serde_json::from_value(value)
            .map_err(|_| invalid("Invalid scene document schema or unknown fields"))?
    };
    validate(&document)?;
    Ok(ImportSource {
        document,
        assets: BTreeMap::new(),
        migrated,
    })
}
fn invalid(message: &str) -> Error {
    Error::Validation(message.into())
}
pub fn scenes(d: &Document) -> impl Iterator<Item = &Scene> {
    std::iter::once(&d.scene).chain(&d.subflows)
}
pub fn validate(d: &Document) -> Result<()> {
    if d.schema_version != FORMAT_VERSION || d.subflows.len() > 64 || d.applications.len() > 256 {
        return Err(invalid("Invalid document limits or version"));
    }
    crate::safety::check_storage_values(d)?;
    let registry = NodeRegistry::builtins();
    let mut ids = BTreeSet::new();
    for s in scenes(d) {
        if !ids.insert(&s.id) {
            return Err(invalid("Duplicate scene IDs"));
        }
        let issues = crate::validation::validate_scene(s, &registry, &d.applications, "", false);
        if !issues.is_empty() {
            return Err(invalid(
                "Scene schema or node configuration failed validation",
            ));
        }
        crate::triggers::TriggerRegistry::default().validate(s)?;
    }
    let mut apps = BTreeSet::new();
    for p in &d.applications {
        crate::validation::validate_profile(p)?;
        if !apps.insert(&p.id) {
            return Err(invalid("Duplicate application IDs"));
        }
    }
    fn visit(d: &Document, s: &Scene, stack: &mut BTreeSet<String>) -> Result<()> {
        if stack.len() >= 16 || !stack.insert(s.id.clone()) {
            return Err(invalid("Circular or excessively nested subflow"));
        }
        for n in s
            .workflow
            .nodes
            .iter()
            .filter(|n| n.node_type == "flow.subflow")
        {
            let id = n.config["sceneId"].as_str().unwrap_or("");
            let child = scenes(d)
                .find(|s| s.id == id)
                .ok_or_else(|| invalid("Package is missing a subflow dependency"))?;
            visit(d, child, stack)?;
        }
        stack.remove(&s.id);
        Ok(())
    }
    for s in scenes(d) {
        visit(d, s, &mut BTreeSet::new())?;
    }
    Ok(())
}
pub fn references(d: &Document, key: &str) -> BTreeSet<String> {
    fn walk(v: &Value, key: &str, out: &mut BTreeSet<String>) {
        match v {
            Value::Object(o) => {
                if let Some(s) = o.get(key).and_then(Value::as_str) {
                    out.insert(s.into());
                }
                for v in o.values() {
                    walk(v, key, out);
                }
            }
            Value::Array(a) => {
                for v in a {
                    walk(v, key, out);
                }
            }
            _ => {}
        }
    }
    let mut result = BTreeSet::new();
    walk(
        &serde_json::to_value(d).expect("document serializes"),
        key,
        &mut result,
    );
    result
}
pub fn yaml(d: &Document) -> Result<String> {
    validate(d)?;
    serde_yaml_ng::to_string(d).map_err(|_| invalid("Could not encode scene YAML"))
}
pub fn read(path: &Path) -> Result<ImportSource> {
    let bytes = read_bounded(path, PACKAGE_LIMIT)?;
    if !bytes.starts_with(b"PK") {
        return parse(std::str::from_utf8(&bytes).map_err(|_| invalid("YAML must use UTF-8"))?);
    }
    let mut archive = zip::ZipArchive::new(Cursor::new(&bytes))
        .map_err(|_| invalid("Invalid LaunchFlow package"))?;
    if archive.len() > 258 {
        return Err(invalid("Package contains too many files"));
    }
    let mut files = BTreeMap::new();
    let mut total = 0;
    for i in 0..archive.len() {
        let entry = archive
            .by_index(i)
            .map_err(|_| invalid("Unreadable package entry"))?;
        let name = entry.name().to_owned();
        let safe = name == "manifest.json"
            || name == "scene.yaml"
            || name
                .strip_prefix("assets/")
                .and_then(|s| s.strip_suffix(".png"))
                .is_some_and(asset_id);
        if !safe
            || files.contains_key(&name)
            || entry.unix_mode().is_some_and(|m| m & 0o170000 == 0o120000)
        {
            return Err(invalid(
                "Package contains an unsafe, duplicate or unsupported entry",
            ));
        }
        let limit = if name.starts_with("assets/") {
            8 * 1024 * 1024
        } else {
            DOCUMENT_LIMIT
        };
        if entry.size() > limit as u64 {
            return Err(invalid("Package entry is oversized"));
        }
        let mut content = Vec::new();
        entry.take(limit as u64 + 1).read_to_end(&mut content)?;
        total += content.len();
        if content.len() > limit || total > PACKAGE_LIMIT {
            return Err(invalid("Package expansion limit exceeded"));
        }
        files.insert(name, content);
    }
    let manifest: Manifest = serde_json::from_slice(
        files
            .get("manifest.json")
            .ok_or_else(|| invalid("Missing manifest.json"))?,
    )
    .map_err(|_| invalid("Invalid package manifest"))?;
    if manifest.package_version != 1
        || manifest.schema_version != FORMAT_VERSION
        || manifest.files.len() + 1 != files.len()
    {
        return Err(invalid("Unsupported or incomplete package manifest"));
    }
    for (name, hash) in &manifest.files {
        let content = files
            .get(name)
            .ok_or_else(|| invalid("Manifest file missing"))?;
        if hash != &digest(content) {
            return Err(invalid("Package integrity check failed"));
        }
    }
    let mut source = parse(
        std::str::from_utf8(
            files
                .get("scene.yaml")
                .ok_or_else(|| invalid("Missing scene.yaml"))?,
        )
        .map_err(|_| invalid("YAML must use UTF-8"))?,
    )?;
    for (name, content) in files {
        if let Some(id) = name
            .strip_prefix("assets/")
            .and_then(|s| s.strip_suffix(".png"))
        {
            validate_asset(id, &content)?;
            source.assets.insert(id.into(), content);
        }
    }
    if references(&source.document, "assetId")
        .iter()
        .any(|id| !source.assets.contains_key(id))
    {
        return Err(invalid("Package is missing a referenced image asset"));
    }
    Ok(source)
}
fn asset_id(id: &str) -> bool {
    id.len() == 64
        && id
            .bytes()
            .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
}
pub fn validate_asset(id: &str, bytes: &[u8]) -> Result<()> {
    if !asset_id(id) || bytes.len() > 8 * 1024 * 1024 || digest(bytes) != id {
        return Err(invalid("Invalid image asset hash or size"));
    }
    let reader = image::ImageReader::with_format(Cursor::new(bytes), image::ImageFormat::Png);
    let (w, h) = reader
        .into_dimensions()
        .map_err(|_| invalid("Invalid PNG asset"))?;
    if w == 0 || h == 0 || u64::from(w) * u64::from(h) > 16_000_000 {
        return Err(invalid("Invalid PNG dimensions"));
    }
    image::load_from_memory_with_format(bytes, image::ImageFormat::Png)
        .map_err(|_| invalid("Corrupt PNG asset"))?;
    Ok(())
}
pub fn package(d: &Document, assets: &BTreeMap<String, Vec<u8>>) -> Result<Vec<u8>> {
    let mut files = BTreeMap::from([("scene.yaml".to_owned(), yaml(d)?.into_bytes())]);
    for id in references(d, "assetId") {
        let content = assets
            .get(&id)
            .ok_or_else(|| invalid("Missing image asset"))?;
        validate_asset(&id, content)?;
        files.insert(format!("assets/{id}.png"), content.clone());
    }
    let manifest = Manifest {
        package_version: 1,
        schema_version: FORMAT_VERSION,
        files: files.iter().map(|(n, b)| (n.clone(), digest(b))).collect(),
    };
    files.insert(
        "manifest.json".into(),
        serde_json::to_vec_pretty(&manifest)?,
    );
    if files.values().map(Vec::len).sum::<usize>() > PACKAGE_LIMIT {
        return Err(invalid("Package exceeds 64 MiB"));
    }
    let mut zip = zip::ZipWriter::new(Cursor::new(Vec::new()));
    for (name, bytes) in files {
        zip.start_file(
            name,
            zip::write::SimpleFileOptions::default()
                .compression_method(zip::CompressionMethod::Deflated),
        )
        .map_err(|_| invalid("Could not create package"))?;
        zip.write_all(&bytes)?;
    }
    Ok(zip
        .finish()
        .map_err(|_| invalid("Could not finish package"))?
        .into_inner())
}
pub fn digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
pub fn read_bounded(path: &Path, limit: usize) -> Result<Vec<u8>> {
    let f = std::fs::File::open(path)?;
    if f.metadata()?.len() > limit as u64 {
        return Err(invalid("File exceeds size limit"));
    }
    let mut bytes = Vec::new();
    f.take(limit as u64 + 1).read_to_end(&mut bytes)?;
    if bytes.len() > limit {
        return Err(invalid("File exceeds size limit"));
    }
    Ok(bytes)
}
