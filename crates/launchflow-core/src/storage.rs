use crate::{model::*, Error, Result};
use rusqlite::{params, Connection, OptionalExtension};
use std::{
    path::Path,
    sync::{Mutex, MutexGuard},
};

pub struct Store {
    connection: Mutex<Connection>,
}
impl Store {
    pub fn open(path: impl AsRef<Path>) -> Result<Self> {
        Self::from_connection(Connection::open(path)?)
    }
    pub fn memory() -> Result<Self> {
        Self::from_connection(Connection::open_in_memory()?)
    }
    fn from_connection(connection: Connection) -> Result<Self> {
        connection.busy_timeout(std::time::Duration::from_secs(5))?;
        connection.execute_batch("PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL;")?;
        let version: u32 = connection.query_row("PRAGMA user_version", [], |r| r.get(0))?;
        if version > 3 {
            return Err(Error::Validation(
                "Database was created by a newer LaunchFlow version".into(),
            ));
        }
        if version == 0 {
            connection.execute_batch("BEGIN IMMEDIATE;
                CREATE TABLE scenes(id TEXT PRIMARY KEY, name TEXT NOT NULL, version INTEGER NOT NULL,
                    is_default INTEGER NOT NULL DEFAULT 0, document TEXT NOT NULL, updated_at TEXT NOT NULL);
                CREATE UNIQUE INDEX one_default_scene ON scenes(is_default) WHERE is_default=1;
                CREATE TABLE scene_versions(scene_id TEXT NOT NULL REFERENCES scenes(id) ON DELETE CASCADE,
                    version INTEGER NOT NULL, document TEXT NOT NULL, PRIMARY KEY(scene_id,version));
                CREATE TABLE drafts(scene_id TEXT PRIMARY KEY REFERENCES scenes(id) ON DELETE CASCADE, document TEXT NOT NULL);
                CREATE TABLE application_profiles(id TEXT PRIMARY KEY, document TEXT NOT NULL);
                CREATE TABLE runs(id TEXT PRIMARY KEY, scene_id TEXT NOT NULL, scene_version INTEGER NOT NULL,
                    status TEXT NOT NULL, started_at TEXT NOT NULL, document TEXT NOT NULL);
                CREATE INDEX run_date ON runs(started_at DESC);
                CREATE TABLE settings(id INTEGER PRIMARY KEY CHECK(id=1), document TEXT NOT NULL);
                PRAGMA user_version=1; COMMIT;")?;
        }
        if version < 2 {
            connection.execute_batch("BEGIN IMMEDIATE;
                CREATE TABLE IF NOT EXISTS trigger_firings(trigger_key TEXT PRIMARY KEY, occurrence TEXT NOT NULL);
                PRAGMA user_version=2; COMMIT;")?;
        }
        if version < 3 {
            connection.execute_batch("BEGIN IMMEDIATE; CREATE TABLE workspace_close_preferences(key TEXT PRIMARY KEY, value TEXT NOT NULL); PRAGMA user_version=3; COMMIT;")?;
        }
        Ok(Self {
            connection: Mutex::new(connection),
        })
    }
    fn lock(&self) -> Result<MutexGuard<'_, Connection>> {
        self.connection
            .lock()
            .map_err(|_| Error::Runtime("Database lock unavailable".into()))
    }
    pub fn claim_trigger(&self, key: &str, occurrence: &str) -> Result<bool> {
        Ok(self.lock()?.execute("INSERT INTO trigger_firings(trigger_key,occurrence) VALUES(?1,?2)
            ON CONFLICT(trigger_key) DO UPDATE SET occurrence=excluded.occurrence WHERE occurrence != excluded.occurrence", params![key, occurrence])? > 0)
    }
    pub fn scenes(&self) -> Result<Vec<Scene>> {
        let conn = self.lock()?;
        let mut stmt = conn.prepare(
            "SELECT document,is_default FROM scenes ORDER BY is_default DESC,updated_at DESC",
        )?;
        let rows = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, bool>(1)?)))?;
        rows.map(|row| {
            let (json, is_default) = row?;
            let mut scene: Scene = serde_json::from_str(&json)?;
            scene.is_default = is_default;
            Ok(scene)
        })
        .collect()
    }
    pub fn scene(&self, id: &str) -> Result<Scene> {
        self.scenes()?
            .into_iter()
            .find(|s| s.id == id)
            .ok_or_else(|| Error::Validation("Scene not found".into()))
    }
    pub fn save_scene(&self, mut scene: Scene) -> Result<Scene> {
        crate::safety::check_storage_values(&scene)?;
        if scene.schema_version != SCHEMA_VERSION
            || scene.name.trim().is_empty()
            || scene.name.len() > 200
        {
            return Err(Error::Validation(
                "Invalid scene name or schema version".into(),
            ));
        }
        let mut conn = self.lock()?;
        let tx = conn.transaction()?;
        let existing: Option<(u32, bool)> = tx
            .query_row(
                "SELECT version,is_default FROM scenes WHERE id=?1",
                [&scene.id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()?;
        if let Some((version, default)) = existing {
            if scene.version != version {
                return Err(Error::Validation(
                    "Scene changed since you opened it. Reload before saving.".into(),
                ));
            }
            scene.version = version + 1;
            scene.is_default = default;
        } else {
            scene.version = 1;
            scene.is_default = false;
            scene.created_at = now();
        }
        scene.updated_at = now();
        let json = serde_json::to_string(&scene)?;
        tx.execute("INSERT INTO scenes(id,name,version,is_default,document,updated_at) VALUES(?1,?2,?3,?4,?5,?6)
            ON CONFLICT(id) DO UPDATE SET name=excluded.name,version=excluded.version,document=excluded.document,updated_at=excluded.updated_at",
            params![scene.id, scene.name.trim(), scene.version, scene.is_default, json, scene.updated_at])?;
        tx.execute(
            "INSERT INTO scene_versions(scene_id,version,document) VALUES(?1,?2,?3)",
            params![scene.id, scene.version, json],
        )?;
        tx.execute("DELETE FROM drafts WHERE scene_id=?1", [&scene.id])?;
        tx.commit()?;
        Ok(scene)
    }
    pub fn set_default(&self, scene_id: Option<&str>) -> Result<()> {
        let mut conn = self.lock()?;
        let tx = conn.transaction()?;
        tx.execute("UPDATE scenes SET is_default=0 WHERE is_default=1", [])?;
        if let Some(id) = scene_id {
            if tx.execute("UPDATE scenes SET is_default=1 WHERE id=?1", [id])? == 0 {
                return Err(Error::Validation("Scene not found".into()));
            }
        }
        tx.commit()?;
        Ok(())
    }
    pub fn rename_scene(&self, scene_id: &str, name: &str, expected_version: u32) -> Result<Scene> {
        let name = name.trim();
        if name.is_empty() || name.len() > 200 {
            return Err(Error::Validation(
                "场景名称不能为空或过长，请缩短后重试。".into(),
            ));
        }
        crate::safety::check_storage_values(&name)?;
        let mut conn = self.lock()?;
        let tx = conn.transaction()?;
        let (document, is_default): (String, bool) = tx
            .query_row(
                "SELECT document,is_default FROM scenes WHERE id=?1",
                [scene_id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()?
            .ok_or_else(|| Error::Validation("Scene not found".into()))?;
        let mut scene: Scene = serde_json::from_str(&document)?;
        scene.is_default = is_default;
        if scene.version != expected_version {
            return Err(Error::Validation("场景已更新，请刷新后重试改名。".into()));
        }
        if scene.name == name {
            return Ok(scene);
        }
        scene.name = name.into();
        scene.version += 1;
        scene.updated_at = now();
        let json = serde_json::to_string(&scene)?;
        tx.execute(
            "UPDATE scenes SET name=?2,version=?3,document=?4,updated_at=?5 WHERE id=?1",
            params![scene.id, scene.name, scene.version, json, scene.updated_at],
        )?;
        tx.execute(
            "INSERT INTO scene_versions(scene_id,version,document) VALUES(?1,?2,?3)",
            params![scene.id, scene.version, json],
        )?;
        let draft: Option<String> = tx
            .query_row(
                "SELECT document FROM drafts WHERE scene_id=?1",
                [scene_id],
                |r| r.get(0),
            )
            .optional()?;
        if let Some(document) = draft {
            let mut draft: Scene = serde_json::from_str(&document)?;
            // Preserve unfinished workflow edits while moving their base revision forward.
            // An already stale draft stays stale so the editor can detect that conflict.
            if draft.version == expected_version {
                draft.name = scene.name.clone();
                draft.version = scene.version;
                draft.updated_at = scene.updated_at.clone();
                tx.execute(
                    "UPDATE drafts SET document=?2 WHERE scene_id=?1",
                    params![scene_id, serde_json::to_string(&draft)?],
                )?;
            }
        }
        tx.commit()?;
        Ok(scene)
    }
    pub fn delete_scene(&self, id: &str) -> Result<()> {
        self.lock()?
            .execute("DELETE FROM scenes WHERE id=?1", [id])?;
        Ok(())
    }
    pub fn save_draft(&self, scene: &Scene) -> Result<()> {
        crate::safety::check_storage_values(scene)?;
        self.lock()?.execute("INSERT INTO drafts(scene_id,document) VALUES(?1,?2) ON CONFLICT(scene_id) DO UPDATE SET document=excluded.document",
            params![scene.id, serde_json::to_string(scene)?])?;
        Ok(())
    }
    pub fn draft(&self, scene_id: &str) -> Result<Option<Scene>> {
        let json: Option<String> = self
            .lock()?
            .query_row(
                "SELECT document FROM drafts WHERE scene_id=?1",
                [scene_id],
                |r| r.get(0),
            )
            .optional()?;
        json.map(|j| serde_json::from_str(&j).map_err(Error::from))
            .transpose()
    }
    pub fn delete_draft(&self, scene_id: &str) -> Result<()> {
        self.lock()?
            .execute("DELETE FROM drafts WHERE scene_id=?1", [scene_id])?;
        Ok(())
    }
    pub fn profiles(&self) -> Result<Vec<ApplicationProfile>> {
        let conn = self.lock()?;
        let mut stmt = conn.prepare("SELECT document FROM application_profiles ORDER BY id")?;
        let rows = stmt.query_map([], |r| r.get::<_, String>(0))?;
        rows.map(|row| Ok(serde_json::from_str(&row?)?)).collect()
    }
    /// Creation from a workspace or import is atomic and cannot overwrite an existing scene.
    pub fn create_scene_with_profiles(
        &self,
        mut scene: Scene,
        profiles: &[ApplicationProfile],
    ) -> Result<Scene> {
        scene = self
            .create_scenes_with_profiles(vec![scene], profiles)?
            .remove(0);
        Ok(scene)
    }
    pub fn create_scenes_with_profiles(
        &self,
        mut scenes: Vec<Scene>,
        profiles: &[ApplicationProfile],
    ) -> Result<Vec<Scene>> {
        for scene in &mut scenes {
            crate::safety::check_storage_values(scene)?;
            if scene.name.trim().is_empty()
                || scene.schema_version != SCHEMA_VERSION
                || scene.version != 0
            {
                return Err(Error::Validation("Invalid new scene".into()));
            }
            scene.version = 1;
            scene.is_default = false;
            scene.updated_at = now();
        }
        for p in profiles {
            crate::safety::check_storage_values(p)?;
            crate::validation::validate_profile(p)?;
        }
        let mut conn = self.lock()?;
        let tx = conn.transaction()?;
        for p in profiles {
            tx.execute(
                "INSERT OR IGNORE INTO application_profiles(id,document) VALUES(?1,?2)",
                params![p.id, serde_json::to_string(p)?],
            )?;
        }
        for scene in &scenes {
            let document = serde_json::to_string(scene)?;
            tx.execute("INSERT INTO scenes(id,name,version,is_default,document,updated_at) VALUES(?1,?2,1,0,?3,?4)",params![scene.id,scene.name,document,scene.updated_at])?;
            tx.execute(
                "INSERT INTO scene_versions(scene_id,version,document) VALUES(?1,1,?2)",
                params![scene.id, document],
            )?;
        }
        tx.commit()?;
        Ok(scenes)
    }
    pub fn save_profile(&self, profile: &ApplicationProfile) -> Result<()> {
        crate::safety::check_storage_values(profile)?;
        if profile.schema_version != 1
            || profile.id.trim().is_empty()
            || profile.display_name.trim().is_empty()
        {
            return Err(Error::Validation(
                "Application ID, name and schemaVersion are required".into(),
            ));
        }
        self.lock()?.execute("INSERT INTO application_profiles(id,document) VALUES(?1,?2) ON CONFLICT(id) DO UPDATE SET document=excluded.document",
            params![profile.id, serde_json::to_string(profile)?])?;
        Ok(())
    }
    pub fn delete_profile(&self, id: &str) -> Result<()> {
        fn references(value: &serde_json::Value, id: &str) -> bool {
            match value {
                serde_json::Value::Object(fields) => {
                    fields.get("applicationId").and_then(|v| v.as_str()) == Some(id)
                        || fields.values().any(|v| references(v, id))
                }
                serde_json::Value::Array(values) => values.iter().any(|v| references(v, id)),
                _ => false,
            }
        }
        if self
            .scenes()?
            .iter()
            .any(|s| s.workflow.nodes.iter().any(|n| references(&n.config, id)))
        {
            return Err(Error::Validation(
                "This application is used by a scene. Remove its nodes first.".into(),
            ));
        }
        self.lock()?
            .execute("DELETE FROM application_profiles WHERE id=?1", [id])?;
        Ok(())
    }
    pub fn save_run(&self, run: &Run) -> Result<()> {
        let status = serde_json::to_string(&run.status)?;
        self.lock()?.execute("INSERT INTO runs(id,scene_id,scene_version,status,started_at,document) VALUES(?1,?2,?3,?4,?5,?6)
            ON CONFLICT(id) DO UPDATE SET status=excluded.status,document=excluded.document",
            params![run.id, run.scene_id, run.scene_version, status, run.started_at, serde_json::to_string(run)?])?;
        Ok(())
    }
    pub fn runs(&self) -> Result<Vec<Run>> {
        let conn = self.lock()?;
        let mut stmt =
            conn.prepare("SELECT document FROM runs ORDER BY started_at DESC LIMIT 300")?;
        let rows = stmt.query_map([], |r| r.get::<_, String>(0))?;
        rows.map(|row| Ok(serde_json::from_str(&row?)?)).collect()
    }
    pub fn run(&self, id: &str) -> Result<Run> {
        let json: String =
            self.lock()?
                .query_row("SELECT document FROM runs WHERE id=?1", [id], |r| r.get(0))?;
        Ok(serde_json::from_str(&json)?)
    }
    pub fn delete_run(&self, id: &str) -> Result<()> {
        if self.run(id)?.status.is_active() {
            return Err(Error::Validation("Cannot delete an active run".into()));
        }
        self.lock()?.execute("DELETE FROM runs WHERE id=?1", [id])?;
        Ok(())
    }
    pub fn recover_interrupted(&self) -> Result<usize> {
        let active: Vec<Run> = {
            let conn = self.lock()?;
            let mut stmt = conn.prepare(
                "SELECT document FROM runs WHERE status IN ('\"running\"','\"paused\"','\"queued\"')",
            )?;
            let rows = stmt.query_map([], |r| r.get::<_, String>(0))?;
            rows.map(|r| Ok(serde_json::from_str(&r?)?))
                .collect::<Result<_>>()?
        };
        let count = active.len();
        for mut run in active {
            run.status = RunStatus::Interrupted;
            run.ended_at = Some(now());
            run.error = Some(
                "LaunchFlow exited before this run completed. Review before restarting.".into(),
            );
            run.revision += 1;
            for node in &mut run.node_runs {
                if node.status.is_active()
                    || matches!(node.status, NodeStatus::Pending | NodeStatus::Queued)
                {
                    node.status = NodeStatus::Cancelled;
                    node.ended_at = Some(now());
                }
            }
            self.save_run(&run)?;
        }
        Ok(count)
    }
    pub fn settings(&self) -> Result<Settings> {
        let json: Option<String> = self
            .lock()?
            .query_row("SELECT document FROM settings WHERE id=1", [], |r| r.get(0))
            .optional()?;
        match json {
            Some(j) => Ok(serde_json::from_str(&j)?),
            None => Ok(Settings::default()),
        }
    }
    pub fn workspace_close_value(&self, key: &str) -> Result<Option<String>> {
        Ok(self
            .lock()?
            .query_row(
                "SELECT value FROM workspace_close_preferences WHERE key=?1",
                [key],
                |r| r.get(0),
            )
            .optional()?)
    }
    pub fn set_workspace_close_value(&self, key: &str, value: &str) -> Result<()> {
        self.lock()?.execute("INSERT INTO workspace_close_preferences(key,value) VALUES(?1,?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value",params![key,value])?;
        Ok(())
    }
    pub fn save_settings(&self, settings: &Settings) -> Result<()> {
        if settings.schema_version != 1
            || !["system", "light", "dark"].contains(&settings.theme.as_str())
            || settings.retention_days > 3650
            || settings.startup_delay_seconds > 3600
        {
            return Err(Error::Validation("Invalid settings".into()));
        }
        self.lock()?.execute("INSERT INTO settings(id,document) VALUES(1,?1) ON CONFLICT(id) DO UPDATE SET document=excluded.document", [serde_json::to_string(settings)?])?;
        Ok(())
    }
    pub fn cleanup(&self) -> Result<usize> {
        if self.settings()?.retention_days == 0 {
            return Ok(0);
        }
        let cutoff = (chrono::Utc::now()
            - chrono::Duration::days(self.settings()?.retention_days as i64))
        .to_rfc3339();
        Ok(self.lock()?.execute(
            "DELETE FROM runs WHERE started_at<?1 AND status NOT IN ('\"running\"','\"paused\"','\"queued\"')",
            [cutoff],
        )?)
    }
    pub fn schema_version(&self) -> Result<u32> {
        Ok(self
            .lock()?
            .query_row("PRAGMA user_version", [], |r| r.get(0))?)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn default_is_unique_and_transactional() {
        let store = Store::memory().unwrap();
        let a = store.save_scene(Scene::new("A")).unwrap();
        let b = store.save_scene(Scene::new("B")).unwrap();
        store.set_default(Some(&a.id)).unwrap();
        store.set_default(Some(&b.id)).unwrap();
        assert_eq!(
            store
                .scenes()
                .unwrap()
                .iter()
                .filter(|s| s.is_default)
                .count(),
            1
        );
        assert!(store.set_default(Some("missing")).is_err());
        assert!(store.scene(&b.id).unwrap().is_default);
    }
    #[test]
    fn rename_preserves_workflow_default_draft_and_run_snapshot() {
        let store = Store::memory().unwrap();
        let mut original = Scene::new("Old");
        original.workflow.nodes.push(Node::new(
            "system.delay",
            "Saved step",
            serde_json::json!({"durationMs":1}),
        ));
        let original = store.save_scene(original).unwrap();
        store.set_default(Some(&original.id)).unwrap();
        let mut draft = original.clone();
        draft.workflow.nodes[0].name = "Unfinished edit".into();
        store.save_draft(&draft).unwrap();
        let run = Run::new(original.clone(), "manual");
        store.save_run(&run).unwrap();
        let renamed = store
            .rename_scene(&original.id, "  New name  ", original.version)
            .unwrap();
        assert_eq!(renamed.name, "New name");
        assert_eq!(renamed.version, original.version + 1);
        assert_eq!(renamed.created_at, original.created_at);
        assert!(renamed.is_default);
        assert_eq!(renamed.workflow.nodes[0].name, "Saved step");
        let recovered = store.draft(&original.id).unwrap().unwrap();
        assert_eq!(recovered.name, renamed.name);
        assert_eq!(recovered.version, renamed.version);
        assert_eq!(recovered.workflow.nodes[0].name, "Unfinished edit");
        assert_eq!(store.run(&run.id).unwrap().scene_snapshot.name, "Old");
        assert_eq!(
            store
                .lock()
                .unwrap()
                .query_row(
                    "SELECT COUNT(*) FROM scene_versions WHERE scene_id=?1",
                    [&original.id],
                    |r| r.get::<_, u32>(0)
                )
                .unwrap(),
            2
        );
        assert_eq!(
            store
                .rename_scene(&original.id, "New name", renamed.version)
                .unwrap()
                .version,
            renamed.version
        );
    }
    #[test]
    fn rename_rejects_stale_and_invalid_names_without_changing_data() {
        let store = Store::memory().unwrap();
        let original = store.save_scene(Scene::new("Old")).unwrap();
        store.save_draft(&original).unwrap();
        for name in [
            " ".to_string(),
            "中".repeat(67),
            "password=literal".to_string(),
        ] {
            assert!(store
                .rename_scene(&original.id, &name, original.version)
                .is_err());
        }
        assert!(store.rename_scene("missing", "New", 1).is_err());
        assert!(store.rename_scene(&original.id, "New", 0).is_err());
        assert_eq!(store.scene(&original.id).unwrap().name, "Old");
        assert_eq!(store.draft(&original.id).unwrap().unwrap().name, "Old");
        // A genuinely old draft must not become valid after a metadata rename.
        let current = store.save_scene(original.clone()).unwrap();
        store.save_draft(&original).unwrap();
        let renamed = store
            .rename_scene(&original.id, "New", current.version)
            .unwrap();
        assert_eq!(
            store.draft(&original.id).unwrap().unwrap().version,
            original.version
        );
        assert_eq!(renamed.version, current.version + 1);
    }
    #[test]
    fn versions_conflicts_and_drafts() {
        let store = Store::memory().unwrap();
        let a = store.save_scene(Scene::new("A")).unwrap();
        store.save_draft(&a).unwrap();
        assert!(store.draft(&a.id).unwrap().is_some());
        let b = store.save_scene(a.clone()).unwrap();
        assert_eq!(b.version, 2);
        assert!(store.save_scene(a).is_err());
        assert!(store.draft(&b.id).unwrap().is_none());
    }
    #[test]
    fn recovers_without_replaying_and_keeps_history_after_deletion() {
        let store = Store::memory().unwrap();
        let scene = store.save_scene(Scene::new("A")).unwrap();
        let run = Run::new(scene.clone(), "manual");
        store.save_run(&run).unwrap();
        assert_eq!(store.recover_interrupted().unwrap(), 1);
        assert_eq!(store.run(&run.id).unwrap().status, RunStatus::Interrupted);
        store.delete_scene(&scene.id).unwrap();
        assert_eq!(store.runs().unwrap().len(), 1);
        assert_eq!(store.recover_interrupted().unwrap(), 0);
    }
    #[test]
    fn migration_is_idempotent_and_rejects_future_schema() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("test.db");
        Store::open(&path).unwrap();
        Store::open(&path).unwrap();
        Connection::open(&path)
            .unwrap()
            .execute_batch("PRAGMA user_version=99")
            .unwrap();
        assert!(Store::open(&path).is_err());
    }
}
