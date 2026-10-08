use async_trait::async_trait;
use launchflow_core::{
    engine::Engine, model::*, platform::PlatformAdapter, registry::NodeRegistry, storage::Store,
    Error, Result,
};
use serde_json::json;
use std::{
    sync::{
        atomic::{AtomicU32, Ordering},
        Arc,
    },
    time::Duration,
};

fn profile() -> ApplicationProfile {
    ApplicationProfile {
        schema_version: 1,
        id: "launch-fixture".into(),
        display_name: "Launch fixture".into(),
        windows: WindowsBinding::default(),
        macos: MacosBinding::default(),
        launch_arguments: vec![],
        ready_detection: None,
    }
}

#[test]
fn legacy_profiles_default_to_normal_launch_and_elevation_persists() {
    let mut p = profile();
    let mut legacy = serde_json::to_value(&p).unwrap();
    legacy["windows"]
        .as_object_mut()
        .unwrap()
        .remove("runAsAdministrator");
    legacy["windows"]
        .as_object_mut()
        .unwrap()
        .remove("usePreauthorizedTask");
    assert!(
        !serde_json::from_value::<ApplicationProfile>(legacy.clone())
            .unwrap()
            .windows
            .use_preauthorized_task
    );
    assert!(
        !serde_json::from_value::<ApplicationProfile>(legacy)
            .unwrap()
            .windows
            .run_as_administrator
    );
    p.windows.run_as_administrator = true;
    p.windows.use_preauthorized_task = true;
    let store = Store::memory().unwrap();
    store.save_profile(&p).unwrap();
    assert!(store.profiles().unwrap()[0].windows.run_as_administrator);
    assert!(store.profiles().unwrap()[0].windows.use_preauthorized_task);
}

struct LaunchResult {
    calls: AtomicU32,
    ready_calls: AtomicU32,
    mode: &'static str,
}
#[async_trait]
impl PlatformAdapter for LaunchResult {
    fn os(&self) -> &'static str {
        "windows"
    }
    async fn launch(&self, _: &ApplicationProfile, _: &[String]) -> Result<()> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        match self.mode {
            "timeout" => {
                tokio::time::sleep(Duration::from_secs(5)).await;
                Ok(())
            }
            "ordinary-error" => Err(Error::Runtime("ordinary launch error".into())),
            _ => Err(Error::ApplicationLaunchReview(
                "已取消 Windows 管理员授权".into(),
            )),
        }
    }
    async fn process_exists(&self, _: &str) -> Result<bool> {
        self.ready_calls.fetch_add(1, Ordering::SeqCst);
        Ok(true)
    }
    async fn open_target(&self, _: &str) -> Result<()> {
        unreachable!()
    }
}
async fn run_launch(mode: &'static str) -> (Run, Arc<LaunchResult>) {
    let adapter = Arc::new(LaunchResult {
        calls: AtomicU32::new(0),
        ready_calls: AtomicU32::new(0),
        mode,
    });
    let e = Engine::new(
        Arc::new(Store::memory().unwrap()),
        Arc::new(NodeRegistry::builtins()),
        adapter.clone(),
    );
    let mut p = profile();
    p.ready_detection = Some(ReadyDetection::Process {
        process_name: "test.exe".into(),
    });
    e.store.save_profile(&p).unwrap();
    let mut launch = Node::new(
        "application.launch",
        "Launch",
        json!({"applicationId":p.id,"arguments":[],"alreadyRunning":"newInstance"}),
    );
    launch.timeout_ms = 60;
    launch.retry_policy.max_retries = 2;
    launch.retry_policy.delay_ms = 10;
    let downstream = Node::new("system.delay", "Downstream", json!({"durationMs":1}));
    let mut s = Scene::new("Launch consent");
    s.workflow.edges = vec![Edge {
        id: id(),
        from: launch.id.clone(),
        to: downstream.id.clone(),
        outlet: success_outlet(),
    }];
    s.workflow.nodes = vec![launch, downstream];
    let s = e.store.save_scene(s).unwrap();
    let started = e.start(&s.id, "manual").unwrap();
    let run = tokio::time::timeout(Duration::from_secs(3), async {
        loop {
            let run = e.store.run(&started.id).unwrap();
            if !run.status.is_active() {
                break run;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    (run, adapter)
}
#[tokio::test]
async fn cancelled_consent_does_not_retry_or_run_readiness_and_downstream() {
    let (run, adapter) = run_launch("cancel").await;
    assert_eq!(run.status, RunStatus::Failed);
    assert_eq!(adapter.calls.load(Ordering::SeqCst), 1);
    assert_eq!(adapter.ready_calls.load(Ordering::SeqCst), 0);
    assert_eq!(run.node_runs[0].retry_count, 0);
    assert!(run.error.unwrap().contains("已取消"));
    assert!(run.node_runs[1].started_at.is_none());
}
#[tokio::test]
async fn uncertain_launch_timeout_does_not_retry() {
    let (run, adapter) = run_launch("timeout").await;
    assert_eq!(run.status, RunStatus::Failed);
    assert_eq!(adapter.calls.load(Ordering::SeqCst), 1);
    assert_eq!(adapter.ready_calls.load(Ordering::SeqCst), 0);
    assert!(run.error.unwrap().contains("不自动重试"));
    assert!(run.node_runs[1].started_at.is_none());
}
#[tokio::test]
async fn ordinary_launch_errors_retain_configured_retry_policy() {
    let (run, adapter) = run_launch("ordinary-error").await;
    assert_eq!(run.status, RunStatus::Failed);
    assert_eq!(adapter.calls.load(Ordering::SeqCst), 3);
    assert_eq!(run.node_runs[0].retry_count, 2);
}

#[cfg(windows)]
mod windows {
    use super::*;
    use launchflow_core::{automation::AutomationPaths, platform::native_platform_with_automation};
    use std::{
        path::Path,
        process::{Command, Stdio},
    };
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    fn adapter() -> Arc<dyn PlatformAdapter> {
        native_platform_with_automation(AutomationPaths {
            worker: env!("CARGO_BIN_EXE_launchflow-fixture").into(),
            ..AutomationPaths::default()
        })
    }
    fn with_broker(marker: &Path, mode: &str) -> ApplicationProfile {
        let mut p = profile();
        p.windows.run_as_administrator = true;
        p.windows.executable = "C:\\unused-test.exe".into();
        p.launch_arguments = vec![marker.to_string_lossy().into_owned(), mode.into()];
        p
    }
    async fn marker_json(marker: &Path) -> serde_json::Value {
        tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                if let Ok(bytes) = std::fs::read(marker) {
                    if let Ok(value) = serde_json::from_slice(&bytes) {
                        break value;
                    }
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap()
    }
    #[tokio::test]
    async fn explicit_elevation_sends_literal_combined_arguments_to_broker() {
        let dir = tempfile::tempdir().unwrap();
        let marker = dir.path().join("request.json");
        let p = with_broker(&marker, "ok");
        adapter()
            .launch(&p, &["中文 空格 & $(literal)".into(), "".into()])
            .await
            .unwrap();
        let request = marker_json(&marker).await["request"].clone();
        assert_eq!(request["op"], "launchApplication");
        assert_eq!(request["elevate"], true);
        assert_eq!(request["arguments"][2], "中文 空格 & $(literal)");
        assert_eq!(request["arguments"][3], "");
    }
    #[tokio::test]
    async fn preauthorized_launch_uses_only_fixed_task_and_never_falls_back_to_uac() {
        let dir = tempfile::tempdir().unwrap();
        let marker = dir.path().join("task.json");
        let mut p = with_broker(&marker, "ok");
        p.windows.use_preauthorized_task = true;
        adapter().launch(&p, &["node-extra".into()]).await.unwrap();
        let request = marker_json(&marker).await["request"].clone();
        assert_eq!(request["op"], "applicationAuthorizationRun");
        assert_eq!(request["profileId"], p.id);
        assert!(request["elevate"].is_null());
        assert_eq!(request["arguments"][2], "node-extra");
        p.launch_arguments[1] = "cancel".into();
        assert!(matches!(
            adapter().launch(&p, &[]).await,
            Err(Error::ApplicationLaunchReview(_))
        ));
        assert_eq!(
            marker_json(&marker).await["request"]["op"],
            "applicationAuthorizationRun"
        );
    }
    #[tokio::test]
    async fn native_missing_authorization_fails_without_prompt_or_implicit_registration() {
        use launchflow_core::platform::{native_platform, ApplicationAuthorizationAction};
        let mut p = profile();
        p.id = format!("never-authorized-{}", id());
        p.windows.use_preauthorized_task = true;
        p.windows.executable = env!("CARGO_BIN_EXE_launchflow-fixture").into();
        let adapter = native_platform();
        assert_eq!(
            adapter
                .application_authorization(&p, ApplicationAuthorizationAction::Status)
                .await
                .unwrap()["state"],
            "notAuthorized"
        );
        assert!(matches!(
            adapter.launch(&p, &[]).await,
            Err(Error::ApplicationLaunchReview(_))
        ));
        assert_eq!(
            adapter
                .application_authorization(&p, ApplicationAuthorizationAction::Revoke)
                .await
                .unwrap()["state"],
            "notAuthorized"
        );
    }
    #[tokio::test]
    async fn denied_and_uncertain_broker_responses_require_manual_review() {
        let dir = tempfile::tempdir().unwrap();
        for mode in ["cancel", "invalid", "oversize"] {
            let p = with_broker(&dir.path().join(mode), mode);
            let error = adapter().launch(&p, &[]).await.unwrap_err();
            assert!(matches!(error, Error::ApplicationLaunchReview(_)));
            if mode == "cancel" {
                assert!(error.to_string().contains("已取消"));
            }
        }
    }
    #[tokio::test]
    async fn cancelling_launch_kills_waiting_broker() {
        let dir = tempfile::tempdir().unwrap();
        let marker = dir.path().join("waiting.json");
        let p = with_broker(&marker, "wait");
        let task = tokio::spawn(async move { adapter().launch(&p, &[]).await });
        let pid = marker_json(&marker).await["pid"].as_u64().unwrap() as u32;
        task.abort();
        let _ = task.await;
        tokio::time::timeout(Duration::from_secs(3), async {
            loop {
                let system = sysinfo::System::new_all();
                if system.process(sysinfo::Pid::from_u32(pid)).is_none() {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        })
        .await
        .expect("cancelled broker exited");
    }
    #[tokio::test]
    async fn require_administrator_manifest_falls_back_but_missing_exe_does_not() {
        let dir = tempfile::tempdir().unwrap();
        let source = dir.path().join("Elevated.cs");
        let manifest = dir.path().join("elevated.manifest");
        let executable = dir.path().join("Elevated.exe");
        std::fs::write(&source, "class Elevated { static void Main() {} }").unwrap();
        std::fs::write(&manifest, r#"<assembly xmlns="urn:schemas-microsoft-com:asm.v1" manifestVersion="1.0"><trustInfo xmlns="urn:schemas-microsoft-com:asm.v3"><security><requestedPrivileges><requestedExecutionLevel level="requireAdministrator" uiAccess="false"/></requestedPrivileges></security></trustInfo></assembly>"#).unwrap();
        let csc = Path::new(&std::env::var("WINDIR").unwrap())
            .join("Microsoft.NET/Framework64/v4.0.30319/csc.exe");
        assert!(Command::new(csc)
            .arg("/nologo")
            .arg("/target:winexe")
            .arg(format!("/win32manifest:{}", manifest.display()))
            .arg(format!("/out:{}", executable.display()))
            .arg(source)
            .status()
            .unwrap()
            .success());
        let error = match Command::new(&executable).spawn() {
            Err(error) => error,
            Ok(mut child) => {
                child.wait().unwrap();
                eprintln!("740 fallback requires an unelevated test host; already-elevated hosts cannot exercise this case");
                return;
            }
        };
        assert_eq!(error.raw_os_error(), Some(740));
        let marker = dir.path().join("fallback.json");
        let mut p = with_broker(&marker, "ok");
        p.windows.run_as_administrator = false;
        p.windows.executable = executable.to_string_lossy().into_owned();
        adapter().launch(&p, &[]).await.unwrap(); // Fake broker: no actual UAC prompt.
        assert_eq!(marker_json(&marker).await["request"]["elevate"], true);
        std::fs::remove_file(&marker).unwrap();
        p.windows.executable = dir
            .path()
            .join("missing.exe")
            .to_string_lossy()
            .into_owned();
        assert!(matches!(adapter().launch(&p, &[]).await, Err(Error::Io(_))));
        assert!(!marker.exists());
    }
    #[tokio::test]
    async fn native_shell_dispatch_preserves_argv_without_elevating() {
        let dir = tempfile::tempdir().unwrap();
        let marker = dir.path().join("中文 args.json");
        let executable = dir.path().join("普通 app.exe");
        std::fs::copy(env!("CARGO_BIN_EXE_launchflow-fixture"), &executable).unwrap();
        let expected = [
            "",
            "中文 空格",
            r#"a\"b"#,
            "trailing\\",
            "& | $(literal) ; %PATH%",
            "two\"\"quotes",
        ];
        let arguments = [
            vec![
                "save-arguments".to_owned(),
                marker.to_string_lossy().into_owned(),
            ],
            expected.iter().map(|s| s.to_string()).collect(),
        ]
        .concat();
        let mut child = tokio::process::Command::new(AutomationPaths::default().worker)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .kill_on_drop(true)
            .creation_flags(0x0800_0000)
            .spawn()
            .unwrap();
        let mut stdin = child.stdin.take().unwrap();
        stdin.write_all(format!("{}\n", json!({"op":"launchApplication","executable":executable,"arguments":arguments,"elevate":false})).as_bytes()).await.unwrap();
        let mut output = String::new();
        tokio::time::timeout(
            Duration::from_secs(10),
            child.stdout.take().unwrap().read_to_string(&mut output),
        )
        .await
        .unwrap()
        .unwrap();
        assert!(child.wait().await.unwrap().success());
        drop(stdin);
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&output).unwrap()["result"]["launched"],
            true,
            "{output}"
        );
        assert_eq!(marker_json(&marker).await, json!(expected));
    }
}
