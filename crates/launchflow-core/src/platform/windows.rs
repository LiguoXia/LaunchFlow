use super::*;
pub struct WindowsPlatform {
    pub automation: Arc<dyn crate::automation::AutomationProvider>,
}
/// Commands are managed operations. Closing this Job kills their descendants;
/// application.launch deliberately does not use a Job and survives cancellation.
pub struct CommandScope(std::os::windows::io::OwnedHandle);
impl CommandScope {
    pub fn attach(child: &tokio::process::Child) -> Result<Self> {
        use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
        use windows_sys::Win32::System::JobObjects::*;
        unsafe {
            let raw = CreateJobObjectW(std::ptr::null(), std::ptr::null());
            if raw.is_null() {
                return Err(std::io::Error::last_os_error().into());
            }
            let scope = Self(OwnedHandle::from_raw_handle(raw));
            let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
            limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            if SetInformationJobObject(
                scope.0.as_raw_handle(),
                JobObjectExtendedLimitInformation,
                &limits as *const _ as *const _,
                std::mem::size_of_val(&limits) as u32,
            ) == 0
                || AssignProcessToJobObject(
                    scope.0.as_raw_handle(),
                    child
                        .raw_handle()
                        .ok_or_else(|| Error::Runtime("Missing command handle".into()))?,
                ) == 0
            {
                return Err(std::io::Error::last_os_error().into());
            }
            Ok(scope)
        }
    }
}
pub fn background(command: &mut Command) {
    command.creation_flags(0x0800_0000);
}
impl WindowsPlatform {
    async fn launch_elevated(
        &self,
        profile: &ApplicationProfile,
        arguments: &[String],
    ) -> Result<()> {
        // No application was launched yet; the engine can safely defer consent until unlock.
        if !self.desktop_ready() {
            return Err(Error::DesktopUnavailable);
        }
        let arguments: Vec<_> = profile.launch_arguments.iter().chain(arguments).collect();
        self.application_exchange(serde_json::json!({
            "op": "launchApplication", "executable": profile.windows.executable,
            "arguments": arguments, "elevate": true
        }))
        .await
        .map(|_| ())
    }
    async fn application_exchange(&self, request: serde_json::Value) -> Result<serde_json::Value> {
        let mut log =
            crate::application_log::RequestLog::begin(&self.automation.paths().data, &request);
        let result = self.application_exchange_inner(request, &mut log).await;
        log.finish(&result);
        result
    }
    async fn application_exchange_inner(
        &self,
        request: serde_json::Value,
        log: &mut crate::application_log::RequestLog,
    ) -> Result<serde_json::Value> {
        use crate::application_log::BrokerStage;
        use tokio::io::AsyncWriteExt;
        let launching = matches!(
            request["op"].as_str(),
            Some("launchApplication" | "applicationAuthorizationRun")
        );
        let mut input = serde_json::to_vec(&request)?;
        if input.len() > 1_048_576 {
            return Err(Error::ApplicationLaunchReview(
                "应用启动参数过长，请缩短后重试。".into(),
            ));
        }
        input.push(b'\n');
        // The node owns the timeout. The ordinary automation bridge's 15-second
        // deadline and kill-descendants Job are inappropriate for a consent prompt.
        // Only the unelevated broker is killed on cancellation; launched apps survive.
        let mut child = crate::automation::bridge::command(self.automation.paths())
            .map_err(|_| Error::Runtime("管理员启动组件缺失，请重新安装 LaunchFlow。".into()))?
            .spawn()?;
        let uncertain = || {
            Error::ApplicationLaunchReview(
            "未能确认 Windows 授权启动结果。请检查应用是否已启动后手动重试；为避免重复授权，本步骤不自动重试。".into(),
        )
        };
        let mut stdin = child.stdin.take().ok_or_else(uncertain)?;
        log.stage(BrokerStage::Write);
        stdin.write_all(&input).await.map_err(|_| uncertain())?;
        let stdout = child.stdout.take().ok_or_else(uncertain)?;
        let mut output = Vec::new();
        log.stage(BrokerStage::Read);
        stdout
            .take(65_537)
            .read_to_end(&mut output)
            .await
            .map_err(|_| uncertain())?;
        if output.len() > 65_536 {
            return Err(uncertain());
        }
        let status = child.wait().await.map_err(|_| uncertain())?;
        // Keep stdin open until the broker exits. EOF cancels an outstanding request.
        drop(stdin);
        if !status.success() {
            return Err(uncertain());
        }
        log.stage(BrokerStage::Parse);
        let response: serde_json::Value =
            serde_json::from_slice(&output).map_err(|_| uncertain())?;
        log.stage(BrokerStage::Response);
        log.response(&response);
        if response["ok"] == true && (!launching || response["result"]["launched"] == true) {
            Ok(response["result"].clone())
        } else {
            Err(Error::ApplicationLaunchReview(
                response["error"]["message"]
                    .as_str()
                    .filter(|s| !s.is_empty())
                    .unwrap_or("Windows 未完成应用启动，请检查授权窗口后手动重试。")
                    .to_owned(),
            ))
        }
    }
}
#[async_trait]
impl PlatformAdapter for WindowsPlatform {
    fn automation(&self) -> Arc<dyn crate::automation::AutomationProvider> {
        self.automation.clone()
    }
    fn os(&self) -> &'static str {
        "windows"
    }
    fn desktop_ready(&self) -> bool {
        use windows_sys::Win32::System::RemoteDesktop::*;
        use windows_sys::Win32::System::StationsAndDesktops::*;
        unsafe {
            let mut session = std::ptr::null_mut();
            let mut bytes = 0;
            let queried = WTSQuerySessionInformationW(
                std::ptr::null_mut(),
                WTS_CURRENT_SESSION,
                WTSConnectState,
                &mut session,
                &mut bytes,
            );
            if queried == 0 || session.is_null() {
                if !session.is_null() {
                    WTSFreeMemory(session.cast());
                }
                return false;
            }
            let active = bytes >= 4 && *(session.cast::<i32>()) == WTSActive;
            WTSFreeMemory(session.cast());
            if !active {
                return false;
            }
            let desktop = OpenInputDesktop(0, 0, DESKTOP_READOBJECTS);
            if desktop.is_null() {
                return false;
            }
            let mut name = [0u16; 128];
            let mut needed = 0;
            let ok = GetUserObjectInformationW(
                desktop,
                UOI_NAME,
                name.as_mut_ptr().cast(),
                std::mem::size_of_val(&name) as u32,
                &mut needed,
            );
            CloseDesktop(desktop);
            ok != 0
                && String::from_utf16_lossy(
                    &name[..name.iter().position(|&c| c == 0).unwrap_or(name.len())],
                )
                .eq_ignore_ascii_case("default")
        }
    }
    async fn launch(&self, profile: &ApplicationProfile, arguments: &[String]) -> Result<()> {
        if profile.windows.use_preauthorized_task {
            let arguments: Vec<_> = profile.launch_arguments.iter().chain(arguments).collect();
            return self
                .application_exchange(serde_json::json!({
                    "op":"applicationAuthorizationRun", "profileId":profile.id,
                    "executable":profile.windows.executable, "arguments":arguments
                }))
                .await
                .map(|_| ())
                .map_err(|e| Error::ApplicationLaunchReview(e.to_string()));
        }
        if profile.windows.run_as_administrator {
            return self.launch_elevated(profile, arguments).await;
        }
        let child = Command::new(&profile.windows.executable)
            .args(&profile.launch_arguments)
            .args(arguments)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn();
        let mut child = match child {
            Ok(child) => child,
            // requireAdministrator manifests and Windows compatibility settings.
            // Other errors must not silently escalate privileges.
            Err(error) if error.raw_os_error() == Some(740) => {
                return self.launch_elevated(profile, arguments).await;
            }
            Err(error) => return Err(error.into()),
        };
        tokio::spawn(async move {
            let _ = child.wait().await;
        });
        Ok(())
    }
    async fn application_authorization(
        &self,
        profile: &ApplicationProfile,
        action: ApplicationAuthorizationAction,
    ) -> Result<serde_json::Value> {
        let op = match action {
            ApplicationAuthorizationAction::Status => "applicationAuthorizationStatus",
            ApplicationAuthorizationAction::Grant => "applicationAuthorizationGrant",
            ApplicationAuthorizationAction::Revoke => "applicationAuthorizationRevoke",
        };
        let seconds = if matches!(action, ApplicationAuthorizationAction::Grant) {
            180
        } else {
            30
        };
        tokio::time::timeout(std::time::Duration::from_secs(seconds), self.application_exchange(serde_json::json!({
            "op":op, "profileId":profile.id, "executable":profile.windows.executable, "arguments":profile.launch_arguments
        }))).await.map_err(|_| Error::ApplicationLaunchReview("授权操作等待超时，请刷新授权状态后再操作。".into()))?
    }
    async fn open_target(&self, target: &str) -> Result<()> {
        open_association(target).await
    }
    async fn window_exists(&self, title: &str) -> Result<bool> {
        use windows_sys::Win32::{
            Foundation::{HWND, LPARAM},
            UI::WindowsAndMessaging::*,
        };
        struct Search {
            title: String,
            found: bool,
        }
        unsafe extern "system" fn visit(hwnd: HWND, data: LPARAM) -> i32 {
            let search = &mut *(data as *mut Search);
            if IsWindowVisible(hwnd) != 0 {
                let mut text = [0u16; 2048];
                let count = GetWindowTextW(hwnd, text.as_mut_ptr(), text.len() as i32);
                if count > 0
                    && String::from_utf16_lossy(&text[..count as usize])
                        .to_lowercase()
                        .contains(&search.title)
                {
                    search.found = true;
                    return 0;
                }
            }
            1
        }
        let mut search = Search {
            title: title.to_lowercase(),
            found: false,
        };
        // EnumWindows callbacks are synchronous; Search outlives them.
        unsafe {
            EnumWindows(Some(visit), &mut search as *mut Search as LPARAM);
        }
        Ok(search.found)
    }
    async fn monitor_count(&self) -> Result<u32> {
        use windows_sys::Win32::UI::WindowsAndMessaging::{GetSystemMetrics, SM_CMONITORS};
        Ok(unsafe { GetSystemMetrics(SM_CMONITORS) }.max(0) as u32)
    }
    async fn monitor_signature(&self) -> Result<String> {
        use windows_sys::Win32::{
            Foundation::{LPARAM, RECT},
            Graphics::Gdi::*,
        };
        unsafe extern "system" fn visit(
            monitor: HMONITOR,
            _dc: HDC,
            _rect: *mut RECT,
            data: LPARAM,
        ) -> i32 {
            let displays = &mut *(data as *mut Vec<String>);
            let mut info = MONITORINFOEXW::default();
            info.monitorInfo.cbSize = std::mem::size_of_val(&info) as u32;
            if GetMonitorInfoW(monitor, (&mut info as *mut MONITORINFOEXW).cast()) != 0 {
                let name = String::from_utf16_lossy(
                    &info.szDevice[..info
                        .szDevice
                        .iter()
                        .position(|c| *c == 0)
                        .unwrap_or(info.szDevice.len())],
                );
                let r = info.monitorInfo.rcMonitor;
                displays.push(format!(
                    "{name}:{}:{}:{}:{}:{}",
                    r.left, r.top, r.right, r.bottom, info.monitorInfo.dwFlags
                ));
            }
            1
        }
        let mut displays = Vec::<String>::new();
        if unsafe {
            EnumDisplayMonitors(
                std::ptr::null_mut(),
                std::ptr::null(),
                Some(visit),
                &mut displays as *mut _ as LPARAM,
            )
        } == 0
        {
            return Err(std::io::Error::last_os_error().into());
        }
        displays.sort();
        Ok(displays.join("|"))
    }
    async fn power_state(&self) -> Result<String> {
        use windows_sys::Win32::System::Power::{GetSystemPowerStatus, SYSTEM_POWER_STATUS};
        let mut state = SYSTEM_POWER_STATUS::default();
        if unsafe { GetSystemPowerStatus(&mut state) } == 0 {
            return Err(std::io::Error::last_os_error().into());
        }
        Ok(match state.ACLineStatus {
            0 => "battery",
            1 => "ac",
            _ => "unknown",
        }
        .into())
    }
    async fn wifi_ssid(&self) -> Result<Option<String>> {
        use std::ptr::{null, null_mut};
        use windows_sys::Win32::NetworkManagement::WiFi::*;
        // Release every WLAN-owned allocation and handle before returning.
        unsafe {
            let mut handle = null_mut();
            let mut version = 0;
            let result = WlanOpenHandle(2, null(), &mut version, &mut handle);
            if result != 0 {
                return Err(Error::Runtime(format!(
                    "Wi-Fi service unavailable (OS code {result})"
                )));
            }
            let mut list = null_mut();
            let mut ssid = None;
            let mut error = WlanEnumInterfaces(handle, null(), &mut list);
            if error == 0 && !list.is_null() {
                let interfaces = std::slice::from_raw_parts(
                    (*list).InterfaceInfo.as_ptr(),
                    (*list).dwNumberOfItems as usize,
                );
                for interface in interfaces
                    .iter()
                    .filter(|i| i.isState == wlan_interface_state_connected)
                {
                    let mut data = null_mut();
                    let mut size = 0;
                    error = WlanQueryInterface(
                        handle,
                        &interface.InterfaceGuid,
                        wlan_intf_opcode_current_connection,
                        null(),
                        &mut size,
                        &mut data,
                        null_mut(),
                    );
                    if error == 0
                        && !data.is_null()
                        && size as usize >= std::mem::size_of::<WLAN_CONNECTION_ATTRIBUTES>()
                    {
                        let s = &(*(data as *const WLAN_CONNECTION_ATTRIBUTES))
                            .wlanAssociationAttributes
                            .dot11Ssid;
                        ssid = Some(
                            String::from_utf8_lossy(&s.ucSSID[..(s.uSSIDLength as usize).min(32)])
                                .into_owned(),
                        );
                    }
                    if !data.is_null() {
                        WlanFreeMemory(data);
                    }
                    if ssid.is_some() {
                        break;
                    }
                }
                WlanFreeMemory(list.cast());
            }
            WlanCloseHandle(handle, null());
            if error != 0 {
                return Err(Error::Runtime(format!(
                    "Wi-Fi information unavailable (OS code {error}); check location permission"
                )));
            }
            Ok(ssid)
        }
    }
}
