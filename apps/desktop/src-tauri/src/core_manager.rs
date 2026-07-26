use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    fs::OpenOptions,
    io::Read,
    path::{Path, PathBuf},
    process::Stdio,
    sync::Arc,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tokio::{
    net::TcpStream,
    process::Command,
    sync::{Mutex, watch},
    time::{Instant, sleep},
};

const CORE_VERSION: &str = "0.2.107";
const DEFAULT_CORE_WS_PORT: u16 = 7520;
const READY_TIMEOUT: Duration = Duration::from_secs(30);
const MAX_RESTART_DELAY: Duration = Duration::from_secs(30);

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ManagedNodeSettings {
    ws_api_port: u16,
}

#[cfg(all(target_os = "windows", target_arch = "x86_64"))]
const CORE_ASSET_URL: &str =
    "https://github.com/freenet/freenet-core/releases/download/v0.2.107/freenet.exe";
#[cfg(all(target_os = "windows", target_arch = "x86_64"))]
const CORE_ASSET_SHA256: &str = "3d39b5469b92f558f8752869b997c0b7c0a88618d63f815602d53f032e59efdc";
#[cfg(all(target_os = "windows", target_arch = "x86_64"))]
const CORE_ASSET_SIZE: usize = 47_707_648;
#[cfg(all(target_os = "windows", target_arch = "x86_64"))]
const CORE_BINARY_SHA256: &str = "3d39b5469b92f558f8752869b997c0b7c0a88618d63f815602d53f032e59efdc";

#[cfg(all(target_os = "linux", target_arch = "x86_64"))]
const CORE_ASSET_URL: &str = "https://github.com/freenet/freenet-core/releases/download/v0.2.107/freenet-x86_64-unknown-linux-musl.tar.gz";
#[cfg(all(target_os = "linux", target_arch = "x86_64"))]
const CORE_ASSET_SHA256: &str = "8e1c0cb932f5317847fbde6a424e4a2e0a1a50eb2052b7cc011e8531f8e52e22";
#[cfg(all(target_os = "linux", target_arch = "x86_64"))]
const CORE_ASSET_SIZE: usize = 19_173_224;
#[cfg(all(target_os = "linux", target_arch = "x86_64"))]
const CORE_BINARY_SHA256: &str = "8539c26deebc7e0e60261ba9e4304de025b43018b358bf4e0752dd6b9af7990b";

#[cfg(all(target_os = "linux", target_arch = "aarch64"))]
const CORE_ASSET_URL: &str = "https://github.com/freenet/freenet-core/releases/download/v0.2.107/freenet-aarch64-unknown-linux-musl.tar.gz";
#[cfg(all(target_os = "linux", target_arch = "aarch64"))]
const CORE_ASSET_SHA256: &str = "e9ab4bb96e7b6c31feaa31992e334c4a2a2b76d2db4d672c9d3904c5e9c212c5";
#[cfg(all(target_os = "linux", target_arch = "aarch64"))]
const CORE_ASSET_SIZE: usize = 17_964_002;
#[cfg(all(target_os = "linux", target_arch = "aarch64"))]
const CORE_BINARY_SHA256: &str = "54d0fd43016bc4740edb4a4f12add76111e760c90817ad7dee9151e5969ef167";

#[cfg(all(target_os = "macos", target_arch = "x86_64"))]
const CORE_ASSET_URL: &str = "https://github.com/freenet/freenet-core/releases/download/v0.2.107/freenet-x86_64-apple-darwin.tar.gz";
#[cfg(all(target_os = "macos", target_arch = "x86_64"))]
const CORE_ASSET_SHA256: &str = "61d5f5215b935f57f1307ffb8c422195d910dacf12200815e7c98be5a3926c28";
#[cfg(all(target_os = "macos", target_arch = "x86_64"))]
const CORE_ASSET_SIZE: usize = 18_967_881;
#[cfg(all(target_os = "macos", target_arch = "x86_64"))]
const CORE_BINARY_SHA256: &str = "deac1e35b0b62b71004dda4d5fa17bf91efef27cf4bc523ddc3ce760bf345a3a";

#[cfg(all(target_os = "macos", target_arch = "aarch64"))]
const CORE_ASSET_URL: &str = "https://github.com/freenet/freenet-core/releases/download/v0.2.107/freenet-aarch64-apple-darwin.tar.gz";
#[cfg(all(target_os = "macos", target_arch = "aarch64"))]
const CORE_ASSET_SHA256: &str = "2a60a04278fa340009f926fddb763a66925a2f96b421722f313b2150f0cd0c9a";
#[cfg(all(target_os = "macos", target_arch = "aarch64"))]
const CORE_ASSET_SIZE: usize = 16_849_336;
#[cfg(all(target_os = "macos", target_arch = "aarch64"))]
const CORE_BINARY_SHA256: &str = "3de9339c39807178291696a4dafceb4abe5e8e9cc00163da12c9548e1303fba9";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum NodeLifecycleState {
    NotInstalled,
    Installing,
    Stopped,
    Starting,
    Connecting,
    Ready,
    Degraded,
    Restarting,
    Failed,
    Stopping,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ManagedNodeStatus {
    pub state: NodeLifecycleState,
    pub version: &'static str,
    pub installed: bool,
    pub verified: bool,
    pub websocket_url: String,
    pub ws_api_port: u16,
    pub process_id: Option<u32>,
    pub restart_attempt: u32,
    pub last_error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ManagedNodeDiagnostics {
    pub schema_version: u64,
    pub generated_at_unix_ms: u128,
    pub status: ManagedNodeStatus,
    pub recent_log: Vec<String>,
}

#[derive(Debug)]
struct Inner {
    state: NodeLifecycleState,
    verified: bool,
    process_id: Option<u32>,
    restart_attempt: u32,
    last_error: Option<String>,
    monitor_running: bool,
    ws_api_port: u16,
}

pub struct CoreManager {
    root: PathBuf,
    inner: Arc<Mutex<Inner>>,
    desired_tx: watch::Sender<bool>,
}

impl CoreManager {
    pub fn new(app_data_dir: PathBuf) -> Self {
        let root = app_data_dir.join("managed-core").join(CORE_VERSION);
        let ws_api_port = load_ws_api_port(&root).unwrap_or(DEFAULT_CORE_WS_PORT);
        let installed = core_binary_path(&root).is_file();
        let (desired_tx, _) = watch::channel(false);
        Self {
            root,
            inner: Arc::new(Mutex::new(Inner {
                state: if installed {
                    NodeLifecycleState::Stopped
                } else {
                    NodeLifecycleState::NotInstalled
                },
                verified: false,
                process_id: None,
                restart_attempt: 0,
                last_error: None,
                monitor_running: false,
                ws_api_port,
            })),
            desired_tx,
        }
    }

    pub async fn status(&self) -> ManagedNodeStatus {
        let should_verify = {
            let inner = self.inner.lock().await;
            core_binary_path(&self.root).is_file() && !inner.verified
        };
        if should_verify {
            let verification = verify_core_binary(&core_binary_path(&self.root)).await;
            let mut inner = self.inner.lock().await;
            inner.verified = verification.is_ok();
            if let Err(error) = verification {
                inner.state = NodeLifecycleState::Failed;
                inner.last_error = Some(error);
            }
        }
        snapshot(&self.root, &self.inner).await
    }

    pub async fn install(&self) -> Result<ManagedNodeStatus, String> {
        {
            let mut inner = self.inner.lock().await;
            if inner.monitor_running {
                return Err("Stop the managed Core before replacing its binary".into());
            }
            inner.state = NodeLifecycleState::Installing;
            inner.last_error = None;
        }

        let result = install_release(&self.root).await;
        let mut inner = self.inner.lock().await;
        match result {
            Ok(()) => {
                inner.state = NodeLifecycleState::Stopped;
                inner.verified = true;
            }
            Err(error) => {
                inner.state = NodeLifecycleState::Failed;
                inner.verified = false;
                inner.last_error = Some(error.clone());
                return Err(error);
            }
        }
        drop(inner);
        Ok(snapshot(&self.root, &self.inner).await)
    }

    pub async fn start(&self) -> Result<ManagedNodeStatus, String> {
        verify_core_binary(&core_binary_path(&self.root)).await?;
        {
            let mut inner = self.inner.lock().await;
            if inner.monitor_running {
                return Ok(snapshot_locked(&self.root, &inner));
            }
            inner.monitor_running = true;
            inner.verified = true;
            inner.state = NodeLifecycleState::Starting;
            inner.last_error = None;
            inner.restart_attempt = 0;
        }
        self.desired_tx.send_replace(true);
        let root = self.root.clone();
        let inner = Arc::clone(&self.inner);
        let desired_rx = self.desired_tx.subscribe();
        tauri::async_runtime::spawn(run_supervisor(root, inner, desired_rx));
        Ok(snapshot(&self.root, &self.inner).await)
    }

    pub async fn stop(&self) -> ManagedNodeStatus {
        {
            let mut inner = self.inner.lock().await;
            if inner.monitor_running {
                inner.state = NodeLifecycleState::Stopping;
            } else if core_binary_path(&self.root).is_file() {
                inner.state = NodeLifecycleState::Stopped;
            }
        }
        let _ = self.desired_tx.send(false);
        for _ in 0..100 {
            if !self.inner.lock().await.monitor_running {
                break;
            }
            sleep(Duration::from_millis(50)).await;
        }
        snapshot(&self.root, &self.inner).await
    }

    pub async fn set_ws_api_port(&self, port: u16) -> Result<ManagedNodeStatus, String> {
        if !(1024..=65535).contains(&port) {
            return Err("The managed node port must be between 1024 and 65535".into());
        }
        {
            let inner = self.inner.lock().await;
            if inner.monitor_running {
                return Err("Stop the managed node before changing its port".into());
            }
        }
        let listener = std::net::TcpListener::bind(("127.0.0.1", port))
            .map_err(|_| format!("Port {port} is already in use"))?;
        drop(listener);
        persist_ws_api_port(&self.root, port).await?;
        let mut inner = self.inner.lock().await;
        inner.ws_api_port = port;
        Ok(snapshot_locked(&self.root, &inner))
    }

    pub async fn diagnostics(&self) -> ManagedNodeDiagnostics {
        let status = self.status().await;
        let log_path = self.root.join("logs").join("core.log");
        let recent_log = tokio::fs::read_to_string(log_path)
            .await
            .unwrap_or_default()
            .lines()
            .rev()
            .take(200)
            .map(|line| redact_diagnostic_line(line, &self.root))
            .collect::<Vec<_>>()
            .into_iter()
            .rev()
            .collect();
        ManagedNodeDiagnostics {
            schema_version: 1,
            generated_at_unix_ms: SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis(),
            status,
            recent_log,
        }
    }
}

fn redact_diagnostic_line(line: &str, root: &Path) -> String {
    let lowered = line.to_ascii_lowercase();
    if [
        "authorization",
        "bearer ",
        "token=",
        "secret",
        "private_key",
        "private-key",
        "seed=",
        "password",
    ]
    .iter()
    .any(|needle| lowered.contains(needle))
    {
        return "[redacted sensitive log line]".into();
    }
    let without_root = line.replace(&root.display().to_string(), "<app-data>");
    without_root.chars().take(500).collect()
}

#[cfg(test)]
mod diagnostic_tests {
    use super::redact_diagnostic_line;
    use std::path::Path;

    #[test]
    fn removes_sensitive_lines_and_local_data_paths() {
        let root = Path::new("C:/Users/example/AppData/Nexus");
        assert_eq!(
            redact_diagnostic_line("authorization: Bearer private-value", root),
            "[redacted sensitive log line]"
        );
        assert_eq!(
            redact_diagnostic_line("log=C:/Users/example/AppData/Nexus/logs/core.log", root),
            "log=<app-data>/logs/core.log"
        );
    }
}

async fn snapshot(root: &Path, inner: &Arc<Mutex<Inner>>) -> ManagedNodeStatus {
    let current = inner.lock().await;
    snapshot_locked(root, &current)
}

fn snapshot_locked(root: &Path, inner: &Inner) -> ManagedNodeStatus {
    ManagedNodeStatus {
        state: inner.state,
        version: CORE_VERSION,
        installed: core_binary_path(root).is_file(),
        verified: inner.verified,
        websocket_url: format!("ws://127.0.0.1:{}/v1/contract/command", inner.ws_api_port),
        ws_api_port: inner.ws_api_port,
        process_id: inner.process_id,
        restart_attempt: inner.restart_attempt,
        last_error: inner.last_error.clone(),
    }
}

#[cfg(any(
    all(target_os = "windows", target_arch = "x86_64"),
    all(
        target_os = "linux",
        any(target_arch = "x86_64", target_arch = "aarch64")
    ),
    all(
        target_os = "macos",
        any(target_arch = "x86_64", target_arch = "aarch64")
    )
))]
async fn install_release(root: &Path) -> Result<(), String> {
    tokio::fs::create_dir_all(root)
        .await
        .map_err(|error| format!("Could not create the managed Core directory: {error}"))?;
    let destination = core_binary_path(root);
    if destination.is_file() && verify_core_binary(&destination).await.is_ok() {
        return Ok(());
    }

    let staging = root.join(if cfg!(target_os = "windows") {
        "freenet.exe.download"
    } else {
        "freenet.download"
    });
    let response = reqwest::Client::builder()
        .user_agent("Nexus-Desktop/0.1")
        .build()
        .map_err(|error| format!("Could not create the Core downloader: {error}"))?
        .get(CORE_ASSET_URL)
        .send()
        .await
        .map_err(|error| format!("Core download failed: {error}"))?
        .error_for_status()
        .map_err(|error| format!("Core download was rejected: {error}"))?;
    let bytes = response
        .bytes()
        .await
        .map_err(|error| format!("Core download was interrupted: {error}"))?;
    if bytes.len() != CORE_ASSET_SIZE {
        return Err(format!(
            "Core download size mismatch: expected {CORE_ASSET_SIZE}, received {}",
            bytes.len()
        ));
    }
    let digest = hex::encode(Sha256::digest(&bytes));
    if digest != CORE_ASSET_SHA256 {
        return Err("Core download failed its pinned SHA-256 verification".into());
    }
    #[cfg(target_os = "windows")]
    let binary = bytes.to_vec();
    #[cfg(not(target_os = "windows"))]
    let binary = tokio::task::spawn_blocking(move || extract_core_binary(&bytes))
        .await
        .map_err(|error| format!("Core extraction task failed: {error}"))??;
    let binary_digest = hex::encode(Sha256::digest(&binary));
    if binary_digest != CORE_BINARY_SHA256 {
        return Err("Extracted Core binary failed its pinned SHA-256 verification".into());
    }
    tokio::fs::write(&staging, &binary)
        .await
        .map_err(|error| format!("Could not stage the Core binary: {error}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        tokio::fs::set_permissions(&staging, std::fs::Permissions::from_mode(0o700))
            .await
            .map_err(|error| format!("Could not make the Core binary executable: {error}"))?;
    }
    if destination.exists() {
        tokio::fs::remove_file(&destination)
            .await
            .map_err(|error| format!("Could not replace the invalid Core binary: {error}"))?;
    }
    tokio::fs::rename(&staging, &destination)
        .await
        .map_err(|error| format!("Could not activate the verified Core binary: {error}"))?;
    verify_core_binary(&destination).await
}

#[cfg(not(any(
    all(target_os = "windows", target_arch = "x86_64"),
    all(
        target_os = "linux",
        any(target_arch = "x86_64", target_arch = "aarch64")
    ),
    all(
        target_os = "macos",
        any(target_arch = "x86_64", target_arch = "aarch64")
    )
)))]
async fn install_release(_root: &Path) -> Result<(), String> {
    Err(
        "Managed Core installation is not packaged for this operating system and architecture"
            .into(),
    )
}

#[cfg(not(target_os = "windows"))]
fn extract_core_binary(archive_bytes: &[u8]) -> Result<Vec<u8>, String> {
    use flate2::read::GzDecoder;
    use std::io::Read as _;

    let decoder = GzDecoder::new(archive_bytes);
    let mut archive = tar::Archive::new(decoder);
    let entries = archive
        .entries()
        .map_err(|error| format!("Could not inspect the Core archive: {error}"))?;
    for entry in entries {
        let mut entry =
            entry.map_err(|error| format!("Could not read a Core archive entry: {error}"))?;
        let path = entry
            .path()
            .map_err(|error| format!("Core archive path is invalid: {error}"))?;
        if path.file_name().is_some_and(|name| name == "freenet") {
            let mut binary = Vec::new();
            entry
                .read_to_end(&mut binary)
                .map_err(|error| format!("Could not extract the Core binary: {error}"))?;
            return Ok(binary);
        }
    }
    Err("The Core archive does not contain a freenet executable".into())
}

async fn verify_core_binary(path: &Path) -> Result<(), String> {
    if !path.is_file() {
        return Err("The managed Freenet Core is not installed".into());
    }
    let path = path.to_path_buf();
    let digest = tokio::task::spawn_blocking(move || sha256_file(&path))
        .await
        .map_err(|error| format!("Core verification task failed: {error}"))??;
    if digest != CORE_BINARY_SHA256 {
        return Err("Installed Core does not match the pinned release digest".into());
    }
    Ok(())
}

fn sha256_file(path: &Path) -> Result<String, String> {
    let mut file = std::fs::File::open(path)
        .map_err(|error| format!("Could not open Core for verification: {error}"))?;
    let mut hasher = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let read = file
            .read(&mut buffer)
            .map_err(|error| format!("Could not read Core for verification: {error}"))?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(hex::encode(hasher.finalize()))
}

async fn run_supervisor(
    root: PathBuf,
    inner: Arc<Mutex<Inner>>,
    mut desired_rx: watch::Receiver<bool>,
) {
    let binary = core_binary_path(&root);
    let config_dir = root.join("config");
    let data_dir = root.join("data");
    let log_dir = root.join("logs");
    if let Err(error) = create_runtime_directories(&config_dir, &data_dir, &log_dir).await {
        finish_supervisor(&inner, NodeLifecycleState::Failed, Some(error)).await;
        return;
    }

    while *desired_rx.borrow() {
        {
            let mut current = inner.lock().await;
            current.state = if current.restart_attempt == 0 {
                NodeLifecycleState::Starting
            } else {
                NodeLifecycleState::Restarting
            };
        }
        let log_path = log_dir.join("core.log");
        let log = match OpenOptions::new().create(true).append(true).open(&log_path) {
            Ok(file) => file,
            Err(error) => {
                finish_supervisor(
                    &inner,
                    NodeLifecycleState::Failed,
                    Some(format!("Could not open the managed Core log: {error}")),
                )
                .await;
                return;
            }
        };
        let stderr = match log.try_clone() {
            Ok(file) => file,
            Err(error) => {
                finish_supervisor(
                    &inner,
                    NodeLifecycleState::Failed,
                    Some(format!("Could not duplicate the Core log handle: {error}")),
                )
                .await;
                return;
            }
        };
        let mut command = Command::new(&binary);
        let ws_api_port = inner.lock().await.ws_api_port;
        command
            .arg("network")
            .arg("--ws-api-address")
            .arg("127.0.0.1")
            .arg("--ws-api-port")
            .arg(ws_api_port.to_string())
            .arg("--config-dir")
            .arg(&config_dir)
            .arg("--data-dir")
            .arg(&data_dir)
            .arg("--log-dir")
            .arg(&log_dir)
            .stdin(Stdio::null())
            .stdout(Stdio::from(log))
            .stderr(Stdio::from(stderr));
        #[cfg(target_os = "windows")]
        command.creation_flags(0x0800_0000);

        let mut child = match command.spawn() {
            Ok(child) => child,
            Err(error) => {
                record_crash(&inner, format!("Could not launch managed Core: {error}")).await;
                if !restart_delay(&inner, &mut desired_rx).await {
                    break;
                }
                continue;
            }
        };
        {
            let mut current = inner.lock().await;
            current.process_id = child.id();
            current.state = NodeLifecycleState::Connecting;
        }

        let started = Instant::now();
        let mut early_exit = None;
        while started.elapsed() < READY_TIMEOUT {
            if !*desired_rx.borrow() {
                let _ = child.start_kill();
                let _ = child.wait().await;
                finish_supervisor(&inner, NodeLifecycleState::Stopped, None).await;
                return;
            }
            match child.try_wait() {
                Ok(Some(status)) => {
                    early_exit = Some(status);
                    break;
                }
                Ok(None) => {}
                Err(error) => {
                    record_crash(&inner, format!("Could not inspect managed Core: {error}")).await;
                    break;
                }
            }
            if TcpStream::connect(("127.0.0.1", ws_api_port)).await.is_ok() {
                let mut current = inner.lock().await;
                current.state = NodeLifecycleState::Ready;
                current.last_error = None;
                break;
            }
            tokio::select! {
                _ = sleep(Duration::from_millis(250)) => {}
                changed = desired_rx.changed() => {
                    if changed.is_err() || !*desired_rx.borrow() {
                        let _ = child.start_kill();
                        let _ = child.wait().await;
                        finish_supervisor(&inner, NodeLifecycleState::Stopped, None).await;
                        return;
                    }
                }
            }
        }

        let status = if let Some(status) = early_exit {
            status
        } else if started.elapsed() >= READY_TIMEOUT {
            let _ = child.start_kill();
            let _ = child.wait().await;
            record_crash(
                &inner,
                "Managed Core did not open its API within 30 seconds".into(),
            )
            .await;
            if !restart_delay(&inner, &mut desired_rx).await {
                break;
            }
            continue;
        } else {
            tokio::select! {
                status = child.wait() => match status {
                    Ok(status) => status,
                    Err(error) => {
                        record_crash(&inner, format!("Could not wait for managed Core: {error}")).await;
                        if !restart_delay(&inner, &mut desired_rx).await {
                            break;
                        }
                        continue;
                    }
                },
                _ = wait_for_stop(&mut desired_rx) => {
                    let _ = child.start_kill();
                    let _ = child.wait().await;
                    finish_supervisor(&inner, NodeLifecycleState::Stopped, None).await;
                    return;
                }
            }
        };

        {
            let mut current = inner.lock().await;
            current.process_id = None;
        }
        if !*desired_rx.borrow() {
            finish_supervisor(&inner, NodeLifecycleState::Stopped, None).await;
            return;
        }
        if status.code() == Some(42) {
            finish_supervisor(
                &inner,
                NodeLifecycleState::Failed,
                Some(
                    "Core requested an update; Nexus stopped it because unattended upgrades must pass the compatibility pin"
                        .into(),
                ),
            )
            .await;
            return;
        }
        record_crash(
            &inner,
            format!("Managed Core exited unexpectedly with {status}"),
        )
        .await;
        if !restart_delay(&inner, &mut desired_rx).await {
            break;
        }
    }
    finish_supervisor(&inner, NodeLifecycleState::Stopped, None).await;
}

async fn create_runtime_directories(
    config_dir: &Path,
    data_dir: &Path,
    log_dir: &Path,
) -> Result<(), String> {
    for directory in [config_dir, data_dir, log_dir] {
        tokio::fs::create_dir_all(directory)
            .await
            .map_err(|error| format!("Could not create {}: {error}", directory.display()))?;
    }
    Ok(())
}

fn load_ws_api_port(root: &Path) -> Option<u16> {
    let settings = std::fs::read(root.join("settings.json")).ok()?;
    let settings: ManagedNodeSettings = serde_json::from_slice(&settings).ok()?;
    (1024..=65535)
        .contains(&settings.ws_api_port)
        .then_some(settings.ws_api_port)
}

async fn persist_ws_api_port(root: &Path, port: u16) -> Result<(), String> {
    tokio::fs::create_dir_all(root)
        .await
        .map_err(|error| format!("Could not create the managed node directory: {error}"))?;
    let target = root.join("settings.json");
    let temporary = root.join("settings.json.tmp");
    let bytes = serde_json::to_vec_pretty(&ManagedNodeSettings { ws_api_port: port })
        .map_err(|error| format!("Could not encode managed node settings: {error}"))?;
    tokio::fs::write(&temporary, bytes)
        .await
        .map_err(|error| format!("Could not write managed node settings: {error}"))?;
    if target.is_file() {
        tokio::fs::remove_file(&target)
            .await
            .map_err(|error| format!("Could not replace managed node settings: {error}"))?;
    }
    tokio::fs::rename(&temporary, &target)
        .await
        .map_err(|error| format!("Could not activate managed node settings: {error}"))
}

async fn wait_for_stop(desired_rx: &mut watch::Receiver<bool>) {
    while *desired_rx.borrow() && desired_rx.changed().await.is_ok() {}
}

async fn record_crash(inner: &Arc<Mutex<Inner>>, error: String) {
    let mut current = inner.lock().await;
    current.process_id = None;
    current.restart_attempt = current.restart_attempt.saturating_add(1);
    current.state = NodeLifecycleState::Degraded;
    current.last_error = Some(error);
}

async fn restart_delay(inner: &Arc<Mutex<Inner>>, desired_rx: &mut watch::Receiver<bool>) -> bool {
    let attempt = inner.lock().await.restart_attempt;
    let delay = restart_backoff(attempt);
    {
        inner.lock().await.state = NodeLifecycleState::Restarting;
    }
    tokio::select! {
        _ = sleep(delay) => *desired_rx.borrow(),
        changed = desired_rx.changed() => changed.is_ok() && *desired_rx.borrow(),
    }
}

fn restart_backoff(attempt: u32) -> Duration {
    let exponent = attempt.saturating_sub(1).min(5);
    Duration::from_secs((1_u64 << exponent).min(MAX_RESTART_DELAY.as_secs()))
}

async fn finish_supervisor(
    inner: &Arc<Mutex<Inner>>,
    state: NodeLifecycleState,
    error: Option<String>,
) {
    let mut current = inner.lock().await;
    current.state = state;
    current.process_id = None;
    current.monitor_running = false;
    current.last_error = error;
}

fn core_binary_path(root: &Path) -> PathBuf {
    #[cfg(target_os = "windows")]
    {
        root.join("freenet.exe")
    }
    #[cfg(not(target_os = "windows"))]
    {
        root.join("freenet")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn restart_backoff_is_bounded() {
        assert_eq!(restart_backoff(1), Duration::from_secs(1));
        assert_eq!(restart_backoff(2), Duration::from_secs(2));
        assert_eq!(restart_backoff(6), Duration::from_secs(30));
        assert_eq!(restart_backoff(u32::MAX), Duration::from_secs(30));
    }

    #[tokio::test]
    async fn managed_node_port_is_validated_and_persisted() {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system clock should be valid")
            .as_nanos();
        let test_root = std::env::temp_dir().join(format!("nexus-port-settings-{unique}"));
        let listener =
            std::net::TcpListener::bind(("127.0.0.1", 0)).expect("a loopback port should be free");
        let port = listener
            .local_addr()
            .expect("listener should have an address")
            .port();
        drop(listener);

        let manager = CoreManager::new(test_root.clone());
        assert!(manager.set_ws_api_port(1023).await.is_err());
        let status = manager
            .set_ws_api_port(port)
            .await
            .expect("free port should be accepted");
        assert_eq!(status.ws_api_port, port);
        let restored = CoreManager::new(test_root.clone());
        assert_eq!(restored.status().await.ws_api_port, port);

        if test_root.starts_with(std::env::temp_dir())
            && test_root
                .file_name()
                .is_some_and(|name| name.to_string_lossy().starts_with("nexus-port-settings-"))
        {
            let _ = tokio::fs::remove_dir_all(test_root).await;
        }
    }

    #[cfg(all(target_os = "windows", target_arch = "x86_64"))]
    #[test]
    fn release_manifest_is_pinned_to_https_and_sha256() {
        assert!(CORE_ASSET_URL.starts_with("https://github.com/freenet/freenet-core/releases/"));
        assert_eq!(CORE_ASSET_SHA256.len(), 64);
        assert_eq!(CORE_VERSION, "0.2.107");
    }

    #[cfg(all(target_os = "windows", target_arch = "x86_64"))]
    #[tokio::test]
    #[ignore = "downloads and launches the pinned real Freenet Core"]
    async fn real_core_is_verified_restarted_after_interruption_and_stopped() {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system clock should be valid")
            .as_nanos();
        let test_root =
            std::env::temp_dir().join(format!("nexus-managed-core-integration-{unique}"));
        let manager = CoreManager::new(test_root.clone());
        let result = async {
            manager.install().await?;
            manager.start().await?;
            let first = wait_for_status(&manager, Duration::from_secs(45), |status| {
                status.state == NodeLifecycleState::Ready && status.process_id.is_some()
            })
            .await?;
            let first_pid = first
                .process_id
                .expect("ready Core should have a process ID");
            let interrupted = Command::new("taskkill.exe")
                .args(["/PID", &first_pid.to_string(), "/F"])
                .status()
                .await
                .map_err(|error| format!("Could not interrupt Core: {error}"))?;
            if !interrupted.success() {
                return Err(format!("taskkill failed with {interrupted}"));
            }
            let recovered = wait_for_status(&manager, Duration::from_secs(45), |status| {
                status.state == NodeLifecycleState::Ready
                    && status.restart_attempt >= 1
                    && status.process_id.is_some_and(|pid| pid != first_pid)
            })
            .await?;
            Ok::<_, String>((first, recovered))
        }
        .await;
        let stopped = manager.stop().await;
        if test_root.starts_with(std::env::temp_dir())
            && test_root.file_name().is_some_and(|name| {
                name.to_string_lossy()
                    .starts_with("nexus-managed-core-integration-")
            })
        {
            let _ = tokio::fs::remove_dir_all(&test_root).await;
        }

        let (first, recovered) = result.expect("real managed Core recovery should pass");
        assert!(first.verified);
        assert_ne!(first.process_id, recovered.process_id);
        assert!(recovered.restart_attempt >= 1);
        assert_eq!(stopped.state, NodeLifecycleState::Stopped);
        assert!(stopped.process_id.is_none());
    }

    async fn wait_for_status(
        manager: &CoreManager,
        timeout: Duration,
        check: impl Fn(&ManagedNodeStatus) -> bool,
    ) -> Result<ManagedNodeStatus, String> {
        let deadline = Instant::now() + timeout;
        loop {
            let status = manager.status().await;
            if check(&status) {
                return Ok(status);
            }
            if status.state == NodeLifecycleState::Failed {
                return Err(status
                    .last_error
                    .unwrap_or_else(|| "Managed Core entered the failed state".into()));
            }
            if Instant::now() >= deadline {
                return Err(format!(
                    "Timed out waiting for managed Core; last state was {:?}: {:?}",
                    status.state, status.last_error
                ));
            }
            sleep(Duration::from_millis(250)).await;
        }
    }
}
