use super::*;
pub struct MacosPlatform {
    pub automation: Arc<dyn crate::automation::AutomationProvider>,
}
pub struct CommandScope(pub i32);
impl Drop for CommandScope {
    fn drop(&mut self) {
        if self.0 > 0 {
            unsafe {
                libc::kill(-self.0, libc::SIGKILL);
            }
        }
    }
}
#[async_trait]
impl PlatformAdapter for MacosPlatform {
    fn automation(&self) -> Arc<dyn crate::automation::AutomationProvider> {
        self.automation.clone()
    }
    fn os(&self) -> &'static str {
        "macos"
    }
    async fn launch(&self, profile: &ApplicationProfile, arguments: &[String]) -> Result<()> {
        let binding = &profile.macos;
        let use_open = !binding.bundle_id.is_empty() || binding.app_path.ends_with(".app");
        let mut command = if use_open {
            let mut cmd = Command::new("/usr/bin/open");
            if !binding.bundle_id.is_empty() {
                cmd.args(["-b", &binding.bundle_id]);
            } else {
                cmd.args(["-a", &binding.app_path]);
            }
            cmd.arg("--args");
            cmd
        } else {
            Command::new(&binding.app_path)
        };
        command
            .args(&profile.launch_arguments)
            .args(arguments)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        let mut child = command.spawn()?;
        if use_open {
            if !child.wait().await?.success() {
                return Err(Error::Runtime(
                    "macOS could not open this application binding".into(),
                ));
            }
        } else {
            tokio::spawn(async move {
                let _ = child.wait().await;
            });
        }
        Ok(())
    }
    async fn open_target(&self, target: &str) -> Result<()> {
        open_association(target).await
    }
    async fn window_exists(&self, title: &str) -> Result<bool> {
        use core_foundation::{
            base::{CFType, TCFType},
            dictionary::CFDictionary,
            string::CFString,
        };
        use core_graphics::window::*;
        let windows = create_window_list(
            kCGWindowListOptionOnScreenOnly | kCGWindowListExcludeDesktopElements,
            0,
        )
        .and_then(create_description_from_array)
        .ok_or_else(|| Error::Runtime("Window list unavailable".into()))?;
        let key = unsafe { CFString::wrap_under_get_rule(kCGWindowName) };
        let query = title.to_lowercase();
        let mut readable = false;
        for item in windows.iter() {
            let dictionary: &CFDictionary<CFString, CFType> = &item;
            if let Some(value) = dictionary.find(&key) {
                if let Some(name) = value.downcast::<CFString>() {
                    readable = true;
                    if name.to_string().to_lowercase().contains(&query) {
                        return Ok(true);
                    }
                }
            }
        }
        if !windows.is_empty() && !readable {
            return Err(Error::Runtime(
                "macOS did not expose window titles; check Screen Recording permission".into(),
            ));
        }
        Ok(false)
    }
    async fn monitor_count(&self) -> Result<u32> {
        core_graphics::display::CGDisplay::active_displays()
            .map(|d| d.len() as u32)
            .map_err(|e| Error::Runtime(format!("Display inspection failed: {e}")))
    }
    async fn monitor_signature(&self) -> Result<String> {
        use core_graphics::display::CGDisplay;
        let ids = CGDisplay::active_displays()
            .map_err(|e| Error::Runtime(format!("Display inspection failed: {e}")))?;
        let mut signatures = ids
            .into_iter()
            .map(|id| {
                let bounds = CGDisplay::new(id).bounds();
                format!(
                    "{id}:{}:{}:{}:{}",
                    bounds.origin.x, bounds.origin.y, bounds.size.width, bounds.size.height
                )
            })
            .collect::<Vec<_>>();
        signatures.sort();
        Ok(signatures.join("|"))
    }
    async fn power_state(&self) -> Result<String> {
        let result = self
            .command("/usr/bin/pmset", &["-g".into(), "batt".into()], None, true)
            .await?;
        if result.code != 0 {
            return Err(Error::Runtime("Power inspection failed".into()));
        }
        Ok(if result.stdout.contains("AC Power") {
            "ac"
        } else if result.stdout.contains("Battery Power") {
            "battery"
        } else {
            "unknown"
        }
        .into())
    }
    async fn wifi_ssid(&self) -> Result<Option<String>> {
        let ports = self
            .command(
                "/usr/sbin/networksetup",
                &["-listallhardwareports".into()],
                None,
                true,
            )
            .await?;
        let mut wifi = false;
        let mut device = None;
        for line in ports.stdout.lines() {
            if line.starts_with("Hardware Port:") {
                wifi = line.contains("Wi-Fi") || line.contains("AirPort");
            }
            if wifi && line.starts_with("Device:") {
                device = Some(line.trim_start_matches("Device:").trim().to_string());
                break;
            }
        }
        let Some(device) = device else {
            return Ok(None);
        };
        let result = self
            .command(
                "/usr/sbin/networksetup",
                &["-getairportnetwork".into(), device],
                None,
                true,
            )
            .await?;
        if result.code != 0 {
            return Err(Error::Runtime(
                "Wi-Fi inspection failed; check macOS network/location permissions".into(),
            ));
        }
        if let Some((_, ssid)) = result.stdout.trim().split_once(": ") {
            return Ok(Some(ssid.into()));
        }
        if result.stdout.contains("not associated") {
            return Ok(None);
        }
        Err(Error::Runtime("macOS did not expose an SSID".into()))
    }
}
