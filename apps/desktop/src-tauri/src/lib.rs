mod core_manager;
mod identity_vault;
mod update_verifier;

use core_manager::{CoreManager, ManagedNodeDiagnostics, ManagedNodeStatus};
use identity_vault::{load_identity_secret, store_identity_secret};
use serde::Serialize;
use std::env;
use tauri::{Manager, State};
use update_verifier::verify_update_artifact;

#[tauri::command]
async fn managed_node_status(manager: State<'_, CoreManager>) -> Result<ManagedNodeStatus, String> {
    Ok(manager.status().await)
}

#[tauri::command]
async fn install_managed_node(
    manager: State<'_, CoreManager>,
) -> Result<ManagedNodeStatus, String> {
    manager.install().await
}

#[tauri::command]
async fn start_managed_node(manager: State<'_, CoreManager>) -> Result<ManagedNodeStatus, String> {
    manager.start().await
}

#[tauri::command]
async fn stop_managed_node(manager: State<'_, CoreManager>) -> Result<ManagedNodeStatus, String> {
    Ok(manager.stop().await)
}

#[tauri::command]
async fn export_managed_node_diagnostics(
    manager: State<'_, CoreManager>,
) -> Result<ManagedNodeDiagnostics, String> {
    Ok(manager.diagnostics().await)
}

#[tauri::command]
async fn set_managed_node_port(
    manager: State<'_, CoreManager>,
    port: u16,
) -> Result<ManagedNodeStatus, String> {
    manager.set_ws_api_port(port).await
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Phase1RuntimeConfig {
    websocket_url: String,
    contract_instance_id: String,
    contract_code_hash: String,
    bridge_url: Option<String>,
    bridge_token: Option<String>,
    peer: String,
    display_name: String,
    channel_id: Option<String>,
    auth_token: Option<String>,
}

#[tauri::command]
fn phase1_runtime_config() -> Option<Phase1RuntimeConfig> {
    let websocket_url = env::var("NEXUS_FREENET_WS_URL").ok()?;
    let contract_instance_id = env::var("NEXUS_CONTRACT_INSTANCE_ID").ok()?;
    let contract_code_hash = env::var("NEXUS_CONTRACT_CODE_HASH").ok()?;
    Some(Phase1RuntimeConfig {
        websocket_url,
        contract_instance_id,
        contract_code_hash,
        bridge_url: env::var("NEXUS_BRIDGE_URL").ok(),
        bridge_token: env::var("NEXUS_BRIDGE_TOKEN").ok(),
        peer: env::var("NEXUS_PEER").unwrap_or_else(|_| "b".into()),
        display_name: env::var("NEXUS_DISPLAY_NAME").unwrap_or_else(|_| "Desktop user".into()),
        channel_id: env::var("NEXUS_CHANNEL_ID").ok(),
        auth_token: env::var("NEXUS_FREENET_AUTH_TOKEN").ok(),
    })
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            let app_data_dir = app.path().app_local_data_dir()?;
            app.manage(CoreManager::new(app_data_dir));
            Ok(())
        })
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .invoke_handler(tauri::generate_handler![
            managed_node_status,
            install_managed_node,
            start_managed_node,
            stop_managed_node,
            export_managed_node_diagnostics,
            set_managed_node_port,
            load_identity_secret,
            store_identity_secret,
            phase1_runtime_config,
            verify_update_artifact
        ])
        .run(tauri::generate_context!())
        .expect("Nexus Desktop failed to start");
}
