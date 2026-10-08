use launchflow_core::{
    automation::{assets::AssetStore, model::*, runner::validate_config, AutomationPaths},
    registry::NodeRegistry,
};
use serde_json::json;
#[test]
fn gui_registry_locator_validation_and_secret_drafts() {
    let registry = NodeRegistry::builtins();
    assert_eq!(
        registry
            .definitions()
            .iter()
            .filter(|d| d.category == "gui")
            .count(),
        20
    );
    let config = json!({"locators":[{"kind":"accessibility","window":{"application":"harness.exe"},"role":"Button","automationId":"start"}]});
    let c: ActionConfig = serde_json::from_value(config.clone()).unwrap();
    validate_config("click", &c).unwrap();
    let mut bad = config.clone();
    bad["locators"][0]["wrongProperty"] = json!(true);
    assert!(serde_json::from_value::<ActionConfig>(bad).is_err());
    let mut secret = c.clone();
    secret.secret_ref = "unresolved".into();
    validate_config("inputSecret", &secret).unwrap();
    secret.text = "must not persist inline secrets".into();
    assert!(validate_config("inputSecret", &secret).is_err());
    secret.text.clear();
    secret.secret_ref = "literal-value".into();
    assert!(validate_config("inputSecret", &secret).is_err());
    let invalid:ActionConfig=serde_json::from_value(json!({"locators":[{"kind":"relativeCoordinate","window":{"title":"Harness"},"x":3,"y":0.5}]})).unwrap();
    assert!(validate_config("click", &invalid).is_err());
}
#[test]
fn image_assets_are_content_addressed_and_exported_without_inline_data() {
    let dir = tempfile::tempdir().unwrap();
    let paths = AutomationPaths {
        data: dir.path().join("data"),
        ..Default::default()
    };
    let store = AssetStore::new(&paths);
    let image = dir.path().join("sample.png");
    image::RgbImage::from_pixel(12, 12, image::Rgb([20, 80, 140]))
        .save(&image)
        .unwrap();
    let asset = store.import(&image).unwrap();
    assert_eq!(asset.id.len(), 64);
    assert!(store.asset_path("../escape").is_err());
    assert_eq!(store.import(&image).unwrap().id, asset.id);
    let mut scene = launchflow_core::model::Scene::new("Assets");
    scene.workflow.nodes.push(launchflow_core::model::Node::new(
        "gui.click",
        "Image",
        json!({"locators":[{"kind":"image","window":{"title":"Harness"},"assetId":asset.id}]}),
    ));
    let archive = dir.path().join("workflow.zip");
    store.export(&scene, &archive).unwrap();
    let mut zip = zip::ZipArchive::new(std::fs::File::open(archive).unwrap()).unwrap();
    assert_eq!(zip.len(), 3);
    assert!(zip.by_name(&format!("assets/{}.png", asset.id)).is_ok());
    assert!(zip.by_name("scene.json").is_ok());
}
#[tokio::test]
async fn image_matching_detects_real_pixels_and_obeys_threshold() {
    let dir = tempfile::tempdir().unwrap();
    let mut template = image::RgbImage::new(24, 20);
    for (x, y, p) in template.enumerate_pixels_mut() {
        *p = image::Rgb([(x * 9) as u8, (y * 11) as u8, ((x + y) * 5) as u8]);
    }
    let mut screen = image::RgbImage::from_pixel(110, 90, image::Rgb([240, 245, 250]));
    image::imageops::replace(&mut screen, &template, 37, 29);
    let p = dir.path().join("screen.png");
    let t = dir.path().join("template.png");
    screen.save(&p).unwrap();
    template.save(&t).unwrap();
    let (rect, score) = launchflow_core::automation::vision::match_image(p, t, 0.99, vec![1.0])
        .await
        .unwrap();
    assert_eq!((rect.x, rect.y), (37.0, 29.0));
    assert!(score >= 0.999);
}
