use super::*;
use serde_json::json;
use std::{process::Stdio, time::Duration};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    process::Command,
};

pub struct NativeAutomation {
    paths: AutomationPaths,
}
impl NativeAutomation {
    pub fn new(paths: AutomationPaths) -> Self {
        Self { paths }
    }
}
pub fn command(paths: &AutomationPaths) -> AutomationResult<Command> {
    if !paths.worker.is_file() {
        return Err(AutomationError::new(
            "workerUnavailable",
            "Bundled native automation worker is missing. Rebuild or reinstall LaunchFlow.",
        ));
    }
    let mut command = Command::new(&paths.worker);
    command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    #[cfg(windows)]
    command.creation_flags(0x0800_0000);
    Ok(command)
}
#[async_trait]
impl WindowProvider for NativeAutomation {
    async fn windows(&self) -> AutomationResult<Value> {
        self.request(json!({"op":"windows"})).await
    }
    async fn window(&self, locator: &WindowLocator) -> AutomationResult<Value> {
        self.request(json!({"op":"window","window":locator})).await
    }
}
#[async_trait]
impl AutomationProvider for NativeAutomation {
    fn paths(&self) -> &AutomationPaths {
        &self.paths
    }
    async fn request(&self, request: Value) -> AutomationResult<Value> {
        let closing = request["op"] == "workspaceClose" && request["action"] != "status";
        let configuring_login = request["op"] == "configureAutologon";
        let deadline = Duration::from_secs(if configuring_login {
            660
        } else if closing {
            180
        } else {
            15
        });
        let input = serde_json::to_vec(&request).map_err(|_| {
            AutomationError::new("invalidRequest", "Native request could not be encoded")
        })?;
        if input.len() > 1_048_576 {
            return Err(AutomationError::new(
                "invalidRequest",
                "Native request exceeds 1 MiB",
            ));
        }
        let future = async {
            let mut child = command(&self.paths)?.spawn().map_err(|_| {
                AutomationError::new("workerUnavailable", "Could not start native worker")
            })?;
            #[cfg(windows)]
            // The interactive configuration dialog must survive a broker response and UAC;
            // it watches this broker and closes when its parent disappears. No password is sent here.
            let _scope = if configuring_login {
                None
            } else {
                Some(
                    crate::platform::windows::CommandScope::attach(&child).map_err(|_| {
                        AutomationError::new(
                            "workerUnavailable",
                            "Could not manage native worker lifetime",
                        )
                    })?,
                )
            };
            // The worker waits for stdin. Hand off our foreground permission to this exact
            // process before it tries to activate a recorded window; never grant ASFW_ANY.
            #[cfg(windows)]
            let foreground_granted = if request["op"] == "perform" {
                child.id().map(|pid| unsafe {
                    windows_sys::Win32::UI::WindowsAndMessaging::AllowSetForegroundWindow(pid) != 0
                })
            } else {
                None
            };
            #[cfg(not(windows))]
            let foreground_granted: Option<bool> = None;
            let mut stdin = child.stdin.take().ok_or_else(|| {
                AutomationError::new("workerUnavailable", "Native input pipe unavailable")
            })?;
            stdin
                .write_all(&input)
                .await
                .map_err(|_| AutomationError::new("workerUnavailable", "Native worker stopped"))?;
            stdin
                .write_all(b"\n")
                .await
                .map_err(|_| AutomationError::new("workerUnavailable", "Native worker stopped"))?;
            drop(stdin);
            let stdout = child.stdout.take().ok_or_else(|| {
                AutomationError::new("workerUnavailable", "Native output pipe unavailable")
            })?;
            let mut output = Vec::new();
            stdout
                .take(8 * 1024 * 1024 + 1)
                .read_to_end(&mut output)
                .await
                .map_err(|_| AutomationError::new("nativeFailure", "Native output failed"))?;
            if output.len() > 8 * 1024 * 1024 {
                return Err(AutomationError::new(
                    "responseTooLarge",
                    "Accessibility result exceeds 8 MiB",
                ));
            }
            child
                .wait()
                .await
                .map_err(|_| AutomationError::new("nativeFailure", "Native worker failed"))?;
            let mut response: Value = serde_json::from_slice(&output).map_err(|_| {
                AutomationError::new("nativeFailure", "Native worker returned invalid data")
            })?;
            if let Some(granted) = foreground_granted {
                let focus = if response["ok"] == true {
                    &mut response["result"]["focus"]
                } else {
                    &mut response["error"]["details"]
                };
                if let Some(fields) = focus.as_object_mut() {
                    fields.insert("foregroundGrantAccepted".into(), json!(granted));
                }
            }
            if response["ok"] == true {
                Ok(response["result"].clone())
            } else {
                Err(
                    serde_json::from_value(response["error"].clone()).unwrap_or_else(|_| {
                        AutomationError::new("nativeFailure", "Native operation failed")
                    }),
                )
            }
        };
        tokio::time::timeout(deadline, future).await.map_err(|_| {
            AutomationError::new(
                "nativeTimeout",
                if configuring_login {
                    "自动登录配置等待超时，请检查配置窗口与系统状态后重试。"
                } else if closing {
                    "等待管理员关闭授权超时，请检查应用退出状态后重试。"
                } else {
                    "Accessibility provider did not respond within 15 seconds"
                },
            )
        })?
    }
}
