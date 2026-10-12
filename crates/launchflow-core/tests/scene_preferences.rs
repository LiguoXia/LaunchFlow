use launchflow_core::{model::*, storage::Store};
use rusqlite::{params, Connection};

#[test]
fn preferences_survive_restart_without_changing_scene_versions_drafts_or_runs() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("scenes.db");
    let store = Store::open(&path).unwrap();
    let a = store.save_scene(Scene::new("A")).unwrap();
    let b = store.save_scene(Scene::new("B")).unwrap();
    store.set_default(Some(&a.id)).unwrap();
    let mut draft = a.clone();
    draft.description = "Unfinished changes".into();
    store.save_draft(&draft).unwrap();
    let run = Run::new(a.clone(), "manual");
    store.save_run(&run).unwrap();
    store.set_scene_quick_launch(&a.id, true).unwrap();
    store.set_scene_quick_launch(&b.id, true).unwrap();
    let order = vec![b.id.clone(), a.id.clone()];
    let saved = store.reorder_scenes(&order).unwrap();
    assert_eq!(saved.order, order);
    assert_eq!(saved.quick_launch_ids, order);
    assert_eq!(store.scene(&a.id).unwrap().version, a.version);
    assert_eq!(store.scene(&a.id).unwrap().updated_at, a.updated_at);
    assert!(store.scene(&a.id).unwrap().is_default);
    assert_eq!(
        store.draft(&a.id).unwrap().unwrap().description,
        draft.description
    );
    assert_eq!(store.run(&run.id).unwrap().scene_snapshot.name, "A");
    let renamed = store.rename_scene(&a.id, "Renamed", a.version).unwrap();
    store.save_scene(renamed).unwrap();
    assert_eq!(store.scene_preferences().unwrap(), saved);
    drop(store);
    let store = Store::open(&path).unwrap();
    assert_eq!(store.scene_preferences().unwrap(), saved);
    assert_eq!(
        store
            .scenes()
            .unwrap()
            .iter()
            .map(|s| s.id.clone())
            .collect::<Vec<_>>(),
        order
    );
    store.set_scene_quick_launch(&a.id, false).unwrap();
    assert_eq!(
        store.scene_preferences().unwrap().quick_launch_ids,
        vec![b.id.clone()]
    );
    store.delete_scene(&b.id).unwrap();
    assert!(store
        .scene_preferences()
        .unwrap()
        .quick_launch_ids
        .is_empty());
    assert_eq!(store.scene_preferences().unwrap().order, vec![a.id]);
}

#[test]
fn invalid_orders_roll_back_and_creation_appends_without_inheriting_quick_launch() {
    let store = Store::memory().unwrap();
    let a = store.save_scene(Scene::new("A")).unwrap();
    let b = store.save_scene(Scene::new("B")).unwrap();
    store.set_scene_quick_launch(&a.id, true).unwrap();
    let before = store.scene_preferences().unwrap();
    for invalid in [
        vec![],
        vec![a.id.clone()],
        vec![a.id.clone(), a.id.clone()],
        vec![a.id.clone(), "missing".into()],
    ] {
        assert!(store.reorder_scenes(&invalid).is_err());
        assert_eq!(store.scene_preferences().unwrap(), before);
    }
    assert!(store.set_scene_quick_launch("missing", true).is_err());
    let mut copy = a.clone();
    copy.id = id();
    copy.version = 0;
    let copy = store.save_scene(copy).unwrap();
    let imported = store
        .create_scenes_with_profiles(vec![Scene::new("Import"), Scene::new("Child")], &[])
        .unwrap();
    let preferences = store.scene_preferences().unwrap();
    assert_eq!(
        preferences.order,
        vec![
            a.id.clone(),
            b.id,
            copy.id,
            imported[0].id.clone(),
            imported[1].id.clone()
        ]
    );
    assert_eq!(preferences.quick_launch_ids, vec![a.id]);
    assert!(store.reorder_scenes(&before.order).is_err());
    assert_eq!(store.scene_preferences().unwrap(), preferences);
}

#[test]
fn v3_migration_keeps_the_previous_scene_list_order_and_starts_with_no_shortcuts() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("v3.db");
    let store = Store::open(&path).unwrap();
    let a = store.save_scene(Scene::new("A")).unwrap();
    let b = store.save_scene(Scene::new("B")).unwrap();
    store.set_default(Some(&a.id)).unwrap();
    store.save_draft(&a).unwrap();
    drop(store);
    let conn = Connection::open(&path).unwrap();
    conn.execute(
        "UPDATE scenes SET updated_at=?2 WHERE id=?1",
        params![a.id, "2026-01-01"],
    )
    .unwrap();
    conn.execute(
        "UPDATE scenes SET updated_at=?2 WHERE id=?1",
        params![b.id, "2026-02-01"],
    )
    .unwrap();
    conn.execute_batch("DROP TABLE scene_preferences; PRAGMA user_version=3;")
        .unwrap();
    drop(conn);
    let store = Store::open(&path).unwrap();
    assert_eq!(store.schema_version().unwrap(), 4);
    let migrated = store.scene_preferences().unwrap();
    assert_eq!(migrated.order, vec![b.id, a.id.clone()]);
    assert!(migrated.quick_launch_ids.is_empty());
    assert!(store.scene(&a.id).unwrap().is_default);
    assert_eq!(store.draft(&a.id).unwrap().unwrap().version, a.version);
    drop(store);
    assert_eq!(
        Store::open(&path).unwrap().scene_preferences().unwrap(),
        migrated
    );
}
