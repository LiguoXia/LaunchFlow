use super::*;
use base64::Engine;
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeSet,
    io::{Cursor, Write},
    path::{Path, PathBuf},
};

pub struct AssetStore {
    root: PathBuf,
}
impl AssetStore {
    pub fn new(paths: &AutomationPaths) -> Self {
        Self {
            root: paths.data.clone(),
        }
    }
    fn valid_id(id: &str) -> bool {
        id.len() == 64 && id.bytes().all(|b| b.is_ascii_hexdigit())
    }
    pub fn asset_path(&self, id: &str) -> AutomationResult<PathBuf> {
        if !Self::valid_id(id) {
            return Err(AutomationError::new(
                "invalidAsset",
                "Invalid content asset ID",
            ));
        }
        let path = self.root.join("assets").join(format!("{id}.png"));
        if !path.is_file() {
            return Err(AutomationError::new(
                "missingAsset",
                "Workflow image asset is missing",
            ));
        }
        Ok(path)
    }
    pub fn import(&self, path: &Path) -> AutomationResult<Asset> {
        if std::fs::metadata(path).map_err(io_error)?.len() > 8 * 1024 * 1024 {
            return Err(AutomationError::new(
                "invalidAsset",
                "Images must be at most 8 MiB",
            ));
        }
        let bytes = std::fs::read(path).map_err(|_| {
            AutomationError::new("invalidAsset", "Could not read the selected image")
        })?;
        if bytes.len() > 8 * 1024 * 1024 {
            return Err(AutomationError::new(
                "invalidAsset",
                "Images must be at most 8 MiB",
            ));
        }
        let reader = image::ImageReader::new(Cursor::new(&bytes))
            .with_guessed_format()
            .map_err(io_error)?;
        if !matches!(
            reader.format(),
            Some(image::ImageFormat::Png | image::ImageFormat::Jpeg)
        ) {
            return Err(AutomationError::new(
                "invalidAsset",
                "Use a valid PNG or JPEG image",
            ));
        }
        let (width, height) = reader
            .into_dimensions()
            .map_err(|_| AutomationError::new("invalidAsset", "Invalid image dimensions"))?;
        if width == 0 || height == 0 || u64::from(width) * u64::from(height) > 16_000_000 {
            return Err(AutomationError::new(
                "invalidAsset",
                "Image exceeds 16 megapixels",
            ));
        }
        let image = image::load_from_memory(&bytes)
            .map_err(|_| AutomationError::new("invalidAsset", "Use a valid PNG or JPEG image"))?;
        let mut png = Cursor::new(Vec::new());
        image
            .write_to(&mut png, image::ImageFormat::Png)
            .map_err(|_| AutomationError::new("invalidAsset", "Could not encode image"))?;
        let hash = format!("{:x}", Sha256::digest(png.get_ref()));
        let folder = self.root.join("assets");
        std::fs::create_dir_all(&folder).map_err(io_error)?;
        std::fs::write(folder.join(format!("{hash}.png")), png.into_inner()).map_err(io_error)?;
        Ok(Asset {
            id: hash.clone(),
            sha256: hash,
            name: path
                .file_name()
                .unwrap_or_default()
                .to_string_lossy()
                .into(),
            width,
            height,
        })
    }
    pub fn diagnostic_path(&self) -> AutomationResult<(String, PathBuf)> {
        let folder = self.root.join("diagnostics");
        std::fs::create_dir_all(&folder).map_err(io_error)?;
        let id = uuid::Uuid::new_v4().to_string();
        Ok((id.clone(), folder.join(format!("{id}.png"))))
    }
    pub fn image_data(&self, id: &str, asset: bool) -> AutomationResult<String> {
        let path = if asset {
            self.asset_path(id)?
        } else {
            uuid::Uuid::parse_str(id)
                .map_err(|_| AutomationError::new("invalidImage", "Invalid diagnostic ID"))?;
            self.root.join("diagnostics").join(format!("{id}.png"))
        };
        let bytes = std::fs::read(path).map_err(io_error)?;
        if bytes.len() > 24 * 1024 * 1024 {
            return Err(AutomationError::new(
                "imageTooLarge",
                "Image is too large to preview",
            ));
        }
        Ok(format!(
            "data:image/png;base64,{}",
            base64::engine::general_purpose::STANDARD.encode(bytes)
        ))
    }
    pub fn export(&self, scene: &crate::model::Scene, destination: &Path) -> AutomationResult<()> {
        fn refs(v: &Value, ids: &mut BTreeSet<String>) {
            match v {
                Value::Object(o) => {
                    if let Some(id) = o.get("assetId").and_then(Value::as_str) {
                        ids.insert(id.into());
                    }
                    for v in o.values() {
                        refs(v, ids);
                    }
                }
                Value::Array(a) => {
                    for v in a {
                        refs(v, ids);
                    }
                }
                _ => {}
            }
        }
        let value = serde_json::to_value(scene)
            .map_err(|_| AutomationError::new("exportFailed", "Scene encoding failed"))?;
        let mut ids = BTreeSet::new();
        refs(&value, &mut ids);
        let mut files = Vec::new();
        for id in ids {
            let bytes = std::fs::read(self.asset_path(&id)?).map_err(io_error)?;
            files.push((id, bytes));
        }
        let file = std::fs::File::create(destination).map_err(io_error)?;
        let mut zip = zip::ZipWriter::new(file);
        let options = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Deflated);
        zip.start_file("scene.json", options).map_err(zip_error)?;
        zip.write_all(&serde_json::to_vec_pretty(scene).unwrap())
            .map_err(io_error)?;
        zip.start_file("assets.json", options).map_err(zip_error)?;
        zip.write_all(&serde_json::to_vec_pretty(&files.iter().map(|(id,_)|serde_json::json!({"id":id,"sha256":id,"path":format!("assets/{id}.png")})).collect::<Vec<_>>()).unwrap()).map_err(io_error)?;
        for (id, bytes) in files {
            zip.start_file(format!("assets/{id}.png"), options)
                .map_err(zip_error)?;
            zip.write_all(&bytes).map_err(io_error)?;
        }
        zip.finish().map_err(zip_error)?;
        Ok(())
    }
}
fn io_error(_: std::io::Error) -> AutomationError {
    AutomationError::new("assetStorage", "Could not access automation asset storage")
}
fn zip_error(_: zip::result::ZipError) -> AutomationError {
    AutomationError::new("exportFailed", "Could not write workflow asset archive")
}

/// Remove masked temporary OCR/template captures even when a future is cancelled.
pub struct TemporaryImage(pub PathBuf);
impl Drop for TemporaryImage {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}
