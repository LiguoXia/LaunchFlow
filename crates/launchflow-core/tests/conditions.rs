use chrono::{Datelike, Local};
use launchflow_core::{
    platform::native_platform,
    registry::{NodeContext, NodeRegistry},
};
use serde_json::json;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
#[tokio::test]
async fn native_conditions_detect_file_directory_environment_process_time_weekday_power_monitors_and_http(
) {
    let platform = native_platform();
    let ctx = NodeContext {
        diagnostics: Default::default(),
        platform: platform.clone(),
        profiles: vec![],
        subflows: None,
    };
    let runner = NodeRegistry::builtins().runner("flow.condition").unwrap();
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("present");
    std::fs::write(&file, "fixture").unwrap();
    let process = std::env::current_exe()
        .unwrap()
        .file_name()
        .unwrap()
        .to_string_lossy()
        .into_owned();
    let clock = Local::now();
    let start = (clock - chrono::Duration::minutes(1))
        .format("%H:%M")
        .to_string();
    let end = (clock + chrono::Duration::minutes(1))
        .format("%H:%M")
        .to_string();
    for config in [
        json!({"kind":"os","value":platform.os()}),
        json!({"kind":"file","value":file}),
        json!({"kind":"directory","value":dir.path()}),
        json!({"kind":"environment","value":"PATH"}),
        json!({"kind":"process","value":process}),
        json!({"kind":"time","start":start,"end":end}),
        json!({"kind":"weekday","weekdays":[clock.weekday().number_from_monday()]}),
        json!({"kind":"power","value":platform.power_state().await.unwrap()}),
        json!({"kind":"monitors","count":platform.monitor_count().await.unwrap()}),
        json!({"kind":"command","program":env!("CARGO_BIN_EXE_launchflow-fixture"),"arguments":["fail"],"exitCode":7}),
    ] {
        assert_eq!(
            runner.run(&config, &ctx).await.unwrap().outlet.as_deref(),
            Some("true"),
            "{config}"
        );
    }
    assert_eq!(
        platform.monitor_signature().await.unwrap(),
        platform.monitor_signature().await.unwrap()
    );
    let window = runner
        .run(
            &json!({"kind":"window","value":"LaunchFlow-window-not-present-very-specific-271828"}),
            &ctx,
        )
        .await;
    match window {
        Ok(result) => assert_eq!(result.outlet.as_deref(), Some("false")),
        Err(error)
            if cfg!(target_os = "macos")
                && error.to_string().contains("Screen Recording permission") =>
        {
            eprintln!("Window-title detection requires a separate macOS permission check: {error}")
        }
        Err(error) => panic!("Native window detection failed: {error}"),
    }
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.unwrap();
        let mut request = [0; 2048];
        assert!(socket.read(&mut request).await.unwrap() > 0);
        socket
            .write_all(b"HTTP/1.1 204 No Content\r\nConnection: close\r\n\r\n")
            .await
            .unwrap();
    });
    assert_eq!(
        runner
            .run(
                &json!({"kind":"http","url":format!("http://{address}"),"expectedStatus":204}),
                &ctx
            )
            .await
            .unwrap()
            .outlet
            .as_deref(),
        Some("true")
    );
    server.await.unwrap();
}
