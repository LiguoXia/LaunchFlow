use launchflow_core::{model::*, storage::Store};
use rusqlite::{params, Connection};
use serde_json::json;
#[test]
fn phase1_database_documents_defaults_history_and_drafts_survive_v2() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("phase1.db");
    let (scene_id, run_id) = {
        let store = Store::open(&path).unwrap();
        let mut s = Scene::new("Phase 1 saved scene");
        s.workflow.nodes = vec![Node::new("system.delay", "old", json!({"durationMs":1}))];
        let s = store.save_scene(s).unwrap();
        store.set_default(Some(&s.id)).unwrap();
        store.save_draft(&s).unwrap();
        let mut r = Run::new(s.clone(), "manual");
        r.status = RunStatus::Failed;
        r.node_runs[0].status = NodeStatus::Succeeded;
        store.save_run(&r).unwrap();
        (s.id, r.id)
    };
    {
        let conn = Connection::open(&path).unwrap();
        for table in ["scenes", "scene_versions", "drafts"] {
            let json: String = conn
                .query_row(&format!("SELECT document FROM {table}"), [], |r| r.get(0))
                .unwrap();
            let mut v: serde_json::Value = serde_json::from_str(&json).unwrap();
            for key in [
                "parameters",
                "triggers",
                "concurrentRunPolicy",
                "maxParallel",
            ] {
                v.as_object_mut().unwrap().remove(key);
            }
            v["workflow"].as_object_mut().unwrap().remove("annotations");
            conn.execute(&format!("UPDATE {table} SET document=?1"), [v.to_string()])
                .unwrap();
        }
        conn.execute_batch("DROP TABLE trigger_firings; DROP TABLE workspace_close_preferences; PRAGMA user_version=1;")
            .unwrap();
        let mut v: serde_json::Value = serde_json::from_str(
            &conn
                .query_row::<String, _, _>("SELECT document FROM runs", [], |r| r.get(0))
                .unwrap(),
        )
        .unwrap();
        for key in [
            "parameterSnapshot",
            "subflowSnapshots",
            "profilesSnapshot",
            "parentRunId",
            "resumedFrom",
        ] {
            v.as_object_mut().unwrap().remove(key);
        }
        for n in v["nodeRuns"].as_array_mut().unwrap() {
            for key in ["output", "outlet", "reusedFrom"] {
                n.as_object_mut().unwrap().remove(key);
            }
        }
        conn.execute(
            "UPDATE runs SET document=?1 WHERE id=?2",
            params![v.to_string(), run_id],
        )
        .unwrap();
    }
    let store = Store::open(&path).unwrap();
    let s = store.scene(&scene_id).unwrap();
    assert!(s.is_default);
    assert_eq!(s.max_parallel, 8);
    assert!(s.parameters.is_empty());
    assert!(store.draft(&scene_id).unwrap().is_some());
    assert_eq!(
        store.run(&run_id).unwrap().node_runs[0].status,
        NodeStatus::Succeeded
    );
    assert!(store.claim_trigger("test", "occurrence").unwrap());
    assert!(!store.claim_trigger("test", "occurrence").unwrap());
    drop(store);
    Store::open(&path).unwrap();
    assert_eq!(
        Connection::open(&path)
            .unwrap()
            .query_row::<u32, _, _>("PRAGMA user_version", [], |r| r.get(0))
            .unwrap(),
        3
    );
}
