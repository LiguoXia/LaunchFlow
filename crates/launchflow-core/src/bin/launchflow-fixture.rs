//! A small non-GUI process used by integration tests; never installed in the desktop bundle.
#![cfg_attr(target_os = "windows", windows_subsystem = "windows")]
fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args.first().map(String::as_str) {
        None => {
            // Test-only stand-in for the unelevated launch broker; never shows UAC.
            let mut line = String::new();
            std::io::stdin().read_line(&mut line).unwrap();
            let request: serde_json::Value = serde_json::from_str(&line).unwrap();
            let arguments = request["arguments"].as_array().unwrap();
            let marker = arguments[0].as_str().unwrap();
            std::fs::write(
                marker,
                serde_json::to_vec(&serde_json::json!({
                    "request": request, "pid": std::process::id()
                }))
                .unwrap(),
            )
            .unwrap();
            match arguments[1].as_str().unwrap() {
                "wait" => std::thread::sleep(std::time::Duration::from_secs(30)),
                "invalid" => println!("invalid response"),
                "oversize" => println!("{}", "x".repeat(70_000)),
                "cancel" => println!(
                    "{}",
                    serde_json::json!({"ok":false,"error":{"code":"uacCancelled","message":"已取消 Windows 管理员授权，应用未启动。"}})
                ),
                _ => println!(
                    "{}",
                    serde_json::json!({"ok":true,"result":{"launched":true}})
                ),
            }
        }
        Some("save-arguments") => {
            std::fs::write(&args[1], serde_json::to_vec(&args[2..]).unwrap()).unwrap();
        }
        Some("sensitive") => {
            println!("password=do-not-persist");
        }
        Some("echo") => {
            for arg in args.iter().skip(1) {
                println!("{arg}");
            }
        }
        Some("fail") => {
            eprintln!("Intentional fixture failure");
            std::process::exit(7);
        }
        Some("fork-sleep") => {
            let mut child = std::process::Command::new(std::env::current_exe().unwrap())
                .args(["sleep", "10000", &args[1]])
                .stdin(std::process::Stdio::null())
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .spawn()
                .unwrap();
            let _ = child.wait();
        }
        Some("fail-once") => {
            if !std::path::Path::new(&args[1]).exists() {
                std::fs::write(&args[1], "first attempt").unwrap();
                std::process::exit(9);
            }
            println!("recovered");
        }
        Some("append") => {
            use std::io::Write;
            let mut f = std::fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(&args[1])
                .unwrap();
            writeln!(f, "side effect").unwrap();
        }
        Some("sleep") => {
            if let Some(marker) = args.get(2) {
                std::fs::write(marker, std::process::id().to_string()).expect("write marker");
            }
            std::thread::sleep(std::time::Duration::from_millis(
                args.get(1).and_then(|s| s.parse().ok()).unwrap_or(1000),
            ));
        }
        Some("serve") => {
            let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("listen");
            std::fs::write(&args[1], listener.local_addr().unwrap().port().to_string())
                .expect("write port");
            listener.set_nonblocking(true).unwrap();
            std::thread::sleep(std::time::Duration::from_secs(2));
        }
        Some("serve-fixed") => {
            let port: u16 = args[1].parse().unwrap();
            std::fs::write(&args[2], std::process::id().to_string()).unwrap();
            std::thread::sleep(std::time::Duration::from_millis(
                args.get(4).and_then(|s| s.parse().ok()).unwrap_or(0),
            ));
            let _listener =
                std::net::TcpListener::bind(("127.0.0.1", port)).expect("fixture port available");
            std::thread::sleep(std::time::Duration::from_millis(
                args.get(3).and_then(|s| s.parse().ok()).unwrap_or(10000),
            ));
        }
        _ => std::process::exit(2),
    }
}
