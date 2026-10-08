use super::*;
use image::imageops::FilterType;
use std::{
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
};
struct Cancel(Arc<AtomicBool>);
impl Drop for Cancel {
    fn drop(&mut self) {
        self.0.store(true, Ordering::Relaxed);
    }
}
pub async fn match_image(
    screen: PathBuf,
    template: PathBuf,
    threshold: f64,
    scales: Vec<f64>,
) -> AutomationResult<(Rect, f64)> {
    let cancelled = Arc::new(AtomicBool::new(false));
    let _guard = Cancel(cancelled.clone());
    tokio::task::spawn_blocking(move || {
        let image = image::open(screen)
            .map_err(|_| AutomationError::new("captureFailed", "Could not decode captured window"))?
            .to_rgb8();
        let template = image::open(template)
            .map_err(|_| AutomationError::new("invalidAsset", "Could not decode template"))?;
        let mut best = (0.0_f64, Rect::default());
        for scale in scales {
            let width = (template.width() as f64 * scale).round() as u32;
            let height = (template.height() as f64 * scale).round() as u32;
            if width < 4 || height < 4 || width > image.width() || height > image.height() {
                continue;
            }
            let pattern = template
                .resize_exact(width, height, FilterType::Triangle)
                .to_rgb8();
            let mut samples = Vec::new();
            for sy in 0..12 {
                for sx in 0..12 {
                    let x = sx * (width - 1) / 11;
                    let y = sy * (height - 1) / 11;
                    samples.push((x, y, *pattern.get_pixel(x, y)));
                }
            }
            let mean = samples
                .iter()
                .flat_map(|(_, _, p)| p.0)
                .map(f64::from)
                .sum::<f64>()
                / (samples.len() * 3) as f64;
            let variance = samples
                .iter()
                .flat_map(|(_, _, p)| p.0)
                .map(|v| (f64::from(v) - mean).powi(2))
                .sum::<f64>()
                / (samples.len() * 3) as f64;
            if variance < 25.0 {
                return Err(AutomationError::new(
                    "invalidAsset",
                    "Template has too little visual detail",
                ));
            }
            for y in 0..=image.height() - height {
                if cancelled.load(Ordering::Relaxed) {
                    return Err(AutomationError::new(
                        "cancelled",
                        "Image matching cancelled",
                    ));
                }
                for x in 0..=image.width() - width {
                    let mut difference = 0u64;
                    let cutoff =
                        ((1.0 - best.0.max(threshold)) * 255.0 * (samples.len() * 3) as f64) as u64;
                    for (sx, sy, p) in &samples {
                        let actual = image.get_pixel(x + sx, y + sy);
                        for channel in 0..3 {
                            difference += actual[channel].abs_diff(p[channel]) as u64;
                        }
                        if difference > cutoff {
                            break;
                        }
                    }
                    let score = 1.0 - difference as f64 / (255.0 * (samples.len() * 3) as f64);
                    if difference <= cutoff && score > best.0 {
                        best = (
                            score,
                            Rect {
                                x: x as f64,
                                y: y as f64,
                                width: width as f64,
                                height: height as f64,
                            },
                        );
                    }
                }
            }
        }
        if best.0 < threshold {
            Err(AutomationError::new(
                "notFound",
                "No image matched the configured similarity threshold",
            ))
        } else {
            // The sparse scan proposes a location; verify every template pixel before action.
            let pattern = template
                .resize_exact(
                    best.1.width as u32,
                    best.1.height as u32,
                    FilterType::Triangle,
                )
                .to_rgb8();
            let mut difference = 0u64;
            for (x, y, pixel) in pattern.enumerate_pixels() {
                if x == 0 && cancelled.load(Ordering::Relaxed) {
                    return Err(AutomationError::new(
                        "cancelled",
                        "Image matching cancelled",
                    ));
                }
                let actual = image.get_pixel(best.1.x as u32 + x, best.1.y as u32 + y);
                for channel in 0..3 {
                    difference += actual[channel].abs_diff(pixel[channel]) as u64;
                }
            }
            let score = 1.0 - difference as f64 / (255.0 * 3.0 * best.1.width * best.1.height);
            if score < threshold {
                Err(AutomationError::new(
                    "notFound",
                    "Candidate failed full-pixel template verification",
                ))
            } else {
                Ok((best.1, score))
            }
        }
    })
    .await
    .map_err(|_| AutomationError::new("visionFailure", "Image matcher stopped"))?
}
