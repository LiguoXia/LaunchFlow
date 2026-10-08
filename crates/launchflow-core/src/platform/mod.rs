use crate::{model::ApplicationProfile, Error, Result};
use async_trait::async_trait;
use std::{process::Stdio, sync::Arc};
use tokio::{
    io::{AsyncRead, AsyncReadExt},
    process::Command,
};

#[cfg(target_os = "macos")]
mod macos;
#[cfg(target_os = "windows")]
pub(crate) mod windows;

#[derive(Debug, Default)]
pub struct CommandOutput {
    pub code: i32,
    pub stdout: String,
    pub stderr: String,
}
#[async_trait]
pub trait PlatformAdapter: Send + Sync {
    fn automation(&self) -> Arc<dyn crate::automation::AutomationProvider> {
        crate::automation::native(crate::automation::AutomationPaths::default())
    }
    fn os(&self) -> &'static str;
    /// Whether the user's input desktop is available. Never changes or unlocks the desktop.
    fn desktop_ready(&self) -> bool {
        true
    }
    async fn launch(&self, profile: &ApplicationProfile, arguments: &[String]) -> Result<()>;
    async fn application_authorization(
        &self,
        _profile: &ApplicationProfile,
        action: ApplicationAuthorizationAction,
    ) -> Result<serde_json::Value> {
        if matches!(action, ApplicationAuthorizationAction::Status) {
            Ok(serde_json::json!({"state":"unsupported","message":"预授权启动仅支持 Windows。"}))
        } else {
            Err(Error::Runtime("预授权启动仅支持 Windows。".into()))
        }
    }
    async fn open_target(&self, target: &str) -> Result<()>;
    async fn window_exists(&self, _title: &str) -> Result<bool> {
        Err(Error::Runtime("Window detection unavailable".into()))
    }
    async fn monitor_count(&self) -> Result<u32> {
        Err(Error::Runtime("Monitor detection unavailable".into()))
    }
    async fn monitor_signature(&self) -> Result<String> {
        Ok(self.monitor_count().await?.to_string())
    }
    async fn power_state(&self) -> Result<String> {
        Err(Error::Runtime("Power detection unavailable".into()))
    }
    async fn wifi_ssid(&self) -> Result<Option<String>> {
        Err(Error::Runtime("Wi-Fi detection unavailable".into()))
    }
    async fn process_exists(&self, name: &str) -> Result<bool> {
        let name = name.to_owned();
        tokio::task::spawn_blocking(move || {
            let system = sysinfo::System::new_with_specifics(
                sysinfo::RefreshKind::nothing()
                    .with_processes(sysinfo::ProcessRefreshKind::nothing()),
            );
            Ok(system
                .processes()
                .values()
                .any(|p| p.name().to_string_lossy().eq_ignore_ascii_case(&name)))
        })
        .await
        .map_err(|_| Error::Runtime("Process inspection failed".into()))?
    }
    async fn command(
        &self,
        program: &str,
        arguments: &[String],
        cwd: Option<&str>,
        capture_output: bool,
    ) -> Result<CommandOutput> {
        let mut command = Command::new(program);
        command
            .args(arguments)
            .stdin(Stdio::null())
            .kill_on_drop(true);
        if let Some(cwd) = cwd.filter(|s| !s.is_empty()) {
            command.current_dir(cwd);
        }
        configure_background_command(&mut command);
        if capture_output {
            command.stdout(Stdio::piped()).stderr(Stdio::piped());
        } else {
            command.stdout(Stdio::null()).stderr(Stdio::null());
        }
        let mut child = command
            .spawn()
            .map_err(|e| Error::Runtime(format!("Could not start command: {e}")))?;
        #[cfg(target_os = "windows")]
        let scope = windows::CommandScope::attach(&child)?;
        #[cfg(target_os = "macos")]
        let scope = macos::CommandScope(
            child
                .id()
                .ok_or_else(|| Error::Runtime("Missing command process ID".into()))?
                as i32,
        );
        if capture_output {
            let stdout = child
                .stdout
                .take()
                .ok_or_else(|| Error::Runtime("Missing stdout pipe".into()))?;
            let stderr = child
                .stderr
                .take()
                .ok_or_else(|| Error::Runtime("Missing stderr pipe".into()))?;
            let wait = async move {
                let status = child.wait().await;
                drop(scope);
                status
            };
            let (status, stdout, stderr) =
                tokio::try_join!(wait, read_bounded(stdout), read_bounded(stderr))?;
            Ok(CommandOutput {
                code: status.code().unwrap_or(-1),
                stdout,
                stderr,
            })
        } else {
            Ok(CommandOutput {
                code: child.wait().await?.code().unwrap_or(-1),
                ..Default::default()
            })
        }
    }
}

#[derive(Clone, Copy)]
pub enum ApplicationAuthorizationAction {
    Status,
    Grant,
    Revoke,
}

pub fn native_platform() -> Arc<dyn PlatformAdapter> {
    native_platform_with_automation(crate::automation::AutomationPaths::default())
}
pub fn native_platform_with_automation(
    paths: crate::automation::AutomationPaths,
) -> Arc<dyn PlatformAdapter> {
    #[cfg(target_os = "windows")]
    {
        Arc::new(windows::WindowsPlatform {
            automation: crate::automation::native(paths),
        })
    }
    #[cfg(target_os = "macos")]
    {
        Arc::new(macos::MacosPlatform {
            automation: crate::automation::native(paths),
        })
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    {
        compile_error!("LaunchFlow supports Windows and macOS only");
    }
}
fn configure_background_command(command: &mut Command) {
    #[cfg(target_os = "windows")]
    windows::background(command);
    #[cfg(target_os = "macos")]
    command.process_group(0);
}
async fn read_bounded(mut stream: impl AsyncRead + Unpin) -> std::io::Result<String> {
    let mut saved = Vec::new();
    let mut buffer = [0u8; 4096];
    let mut truncated = false;
    loop {
        let count = stream.read(&mut buffer).await?;
        if count == 0 {
            break;
        }
        let remaining = 65_536usize.saturating_sub(saved.len());
        saved.extend_from_slice(&buffer[..count.min(remaining)]);
        truncated |= count > remaining;
    }
    let mut text = String::from_utf8_lossy(&saved).into_owned();
    if truncated {
        text.push_str("\n[output truncated at 64 KiB]");
    }
    Ok(text)
}
async fn open_association(target: &str) -> Result<()> {
    let target = target.to_owned();
    tokio::task::spawn_blocking(move || open::that_detached(target))
        .await
        .map_err(|_| Error::Runtime("System association task failed".into()))??;
    Ok(())
}

#[cfg(test)]
mod tests {
    #[tokio::test]
    async fn bounded_reader_drains_large_output() {
        let data = vec![b'x'; 100_000];
        let output = super::read_bounded(data.as_slice()).await.unwrap();
        assert!(output.starts_with(&"x".repeat(65_536)));
        assert!(output.ends_with("[output truncated at 64 KiB]"));
        assert!(output.len() < 65_600);
    }
}
