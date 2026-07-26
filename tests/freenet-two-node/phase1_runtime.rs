use std::{
    collections::BTreeMap,
    env, fs,
    net::{IpAddr, Ipv4Addr, SocketAddr},
    path::{Path, PathBuf},
    sync::Arc,
    time::Duration,
};

use anyhow::{Context, Result, bail, ensure};
use axum::{
    Json, Router,
    extract::{Path as AxumPath, Query, State},
    http::{HeaderMap, StatusCode},
    response::IntoResponse,
    routing::{get, post},
};
use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use freenet_stdlib::{
    client_api::{ClientRequest, ContractRequest, ContractResponse, HostResponse, WebApi},
    prelude::{
        ContractCode, ContractContainer, ContractKey, ContractWasmAPIVersion, Parameters,
        RelatedContracts, StateDelta, UpdateData, WrappedContract, WrappedState,
    },
};
use freenet_test_network::{FreenetBinary, TestNetwork};
use nexus_protocol::{
    AttachmentIndexOperation, AttachmentIndexState, MessageOperation, SegmentState, validate_state,
    verify_attachment_index_operation, verify_operation,
};
use rand::{RngCore, rngs::OsRng};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::Digest;
use tokio::time::{sleep, timeout};
use tokio_tungstenite::connect_async;
use tower_http::{
    cors::{Any, CorsLayer},
    limit::RequestBodyLimitLayer,
};

const CHANNEL_ID: &str = "01K10KJ6P20S58KQBV5P4E3T9Z";

#[derive(Serialize)]
struct RuntimeDescriptor {
    peer_a_websocket_url: String,
    peer_b_websocket_url: String,
    contract_instance_id: String,
    contract_code_hash: String,
    attachment_index_instance_id: String,
    attachment_index_code_hash: String,
    bridge_url: String,
    bridge_token: String,
    channel_id: &'static str,
}

#[derive(Clone)]
struct BridgeState {
    peer_a_url: String,
    peer_b_url: String,
    key: ContractKey,
    attachment_index_key: ContractKey,
    attachment_chunk_wasm: Arc<Vec<u8>>,
    community: AuthorityContract,
    conversation: AuthorityContract,
    token: String,
}

#[derive(Clone)]
struct AuthorityContract {
    key: ContractKey,
    wasm: Arc<Vec<u8>>,
}

#[derive(Serialize)]
struct HealthResponse {
    status: &'static str,
    transport: &'static str,
}

#[derive(Serialize)]
struct BridgeError {
    error: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AttachmentUpload {
    operation: AttachmentIndexOperation,
    chunks: BTreeMap<String, String>,
}

#[derive(Deserialize)]
struct AttachmentQuery {
    reference: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AttachmentDownload {
    operation: AttachmentIndexOperation,
    chunks: BTreeMap<String, String>,
}

type BridgeResult<T> = Result<Json<T>, (StatusCode, Json<BridgeError>)>;

fn native_websocket_url(url: String) -> String {
    if url.contains('?') {
        format!("{url}&encodingProtocol=native")
    } else {
        format!("{url}?encodingProtocol=native")
    }
}

async fn connect(url: String) -> Result<WebApi> {
    let url = native_websocket_url(url);
    let (stream, _) = connect_async(&url)
        .await
        .with_context(|| format!("connect to {url}"))?;
    Ok(WebApi::start(stream))
}

async fn receive_put(client: &mut WebApi) -> Result<()> {
    loop {
        match timeout(Duration::from_secs(60), client.recv()).await?? {
            HostResponse::ContractResponse(ContractResponse::PutResponse { .. }) => return Ok(()),
            HostResponse::ContractResponse(ContractResponse::NotFound { .. }) => {
                bail!("contract PUT unexpectedly returned not found");
            }
            _ => {}
        }
    }
}

async fn receive_get(client: &mut WebApi) -> Result<()> {
    loop {
        match timeout(Duration::from_secs(60), client.recv()).await?? {
            HostResponse::ContractResponse(ContractResponse::GetResponse { .. }) => return Ok(()),
            HostResponse::ContractResponse(ContractResponse::NotFound { .. }) => {
                bail!("published contract was not found on peer B");
            }
            _ => {}
        }
    }
}

fn bridge_error(status: StatusCode, error: impl ToString) -> (StatusCode, Json<BridgeError>) {
    (
        status,
        Json(BridgeError {
            error: error.to_string(),
        }),
    )
}

fn authorize(headers: &HeaderMap, expected: &str) -> Result<(), (StatusCode, Json<BridgeError>)> {
    let supplied = headers
        .get("authorization")
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "));
    if supplied == Some(expected) {
        Ok(())
    } else {
        Err(bridge_error(
            StatusCode::UNAUTHORIZED,
            "invalid bridge token",
        ))
    }
}

fn peer_url(state: &BridgeState, peer: &str) -> Option<String> {
    match peer {
        "a" => Some(state.peer_a_url.clone()),
        "b" => Some(state.peer_b_url.clone()),
        _ => None,
    }
}

async fn fetch_wrapped_state(url: String, key: ContractKey) -> Result<WrappedState> {
    let mut client = connect(url).await?;
    client
        .send(ClientRequest::ContractOp(ContractRequest::Get {
            key: *key.id(),
            return_contract_code: false,
            subscribe: false,
            blocking_subscribe: false,
        }))
        .await?;
    loop {
        match timeout(Duration::from_secs(30), client.recv()).await?? {
            HostResponse::ContractResponse(ContractResponse::GetResponse { state, .. }) => {
                client.disconnect("Nexus bridge read complete").await;
                return Ok(state);
            }
            HostResponse::ContractResponse(ContractResponse::NotFound { .. }) => {
                bail!("contract was not found")
            }
            _ => {}
        }
    }
}

fn authority_contract(state: &BridgeState, family: &str) -> Option<AuthorityContract> {
    match family {
        "community" => Some(state.community.clone()),
        "conversation" => Some(state.conversation.clone()),
        _ => None,
    }
}

async fn bootstrap_authority(
    url: String,
    contract: AuthorityContract,
    initial_state: Value,
) -> Result<Value> {
    if let Ok(existing) = fetch_wrapped_state(url.clone(), contract.key).await {
        return Ok(serde_json::from_slice(existing.as_ref())?);
    }
    let mut client = connect(url).await?;
    let container = ContractContainer::Wasm(ContractWasmAPIVersion::V1(WrappedContract::new(
        Arc::new(ContractCode::from(contract.wasm.as_ref().clone())),
        Parameters::from(Vec::<u8>::new()),
    )));
    ensure!(
        container.key() == contract.key,
        "authority contract key changed"
    );
    client
        .send(ClientRequest::ContractOp(ContractRequest::Put {
            contract: container,
            state: WrappedState::from(serde_json::to_vec(&initial_state)?),
            related_contracts: RelatedContracts::default(),
            subscribe: false,
            blocking_subscribe: false,
        }))
        .await?;
    receive_put(&mut client).await?;
    client
        .disconnect("Nexus authority bootstrap complete")
        .await;
    Ok(initial_state)
}

async fn submit_authority_operation(url: String, key: ContractKey, operation: Value) -> Result<()> {
    let mut client = connect(url).await?;
    client
        .send(ClientRequest::ContractOp(ContractRequest::Update {
            key,
            data: UpdateData::Delta(StateDelta::from(serde_json::to_vec(&operation)?)),
        }))
        .await?;
    loop {
        match timeout(Duration::from_secs(30), client.recv()).await?? {
            HostResponse::ContractResponse(ContractResponse::UpdateResponse { .. }) => {
                client.disconnect("Nexus authority update complete").await;
                return Ok(());
            }
            HostResponse::ContractResponse(ContractResponse::NotFound { .. }) => {
                bail!("authority contract was not found")
            }
            _ => {}
        }
    }
}

async fn fetch_state(url: String, key: ContractKey) -> Result<SegmentState> {
    let state = fetch_wrapped_state(url, key).await?;
    let decoded: SegmentState = serde_json::from_slice(state.as_ref())?;
    validate_state(&decoded)?;
    Ok(decoded)
}

async fn submit_operation(
    url: String,
    key: ContractKey,
    operation: MessageOperation,
) -> Result<()> {
    verify_operation(&operation)?;
    let mut client = connect(url).await?;
    client
        .send(ClientRequest::ContractOp(ContractRequest::Update {
            key,
            data: UpdateData::Delta(StateDelta::from(serde_json::to_vec(&operation)?)),
        }))
        .await?;
    loop {
        match timeout(Duration::from_secs(30), client.recv()).await?? {
            HostResponse::ContractResponse(ContractResponse::UpdateResponse { .. }) => {
                client.disconnect("Nexus bridge update complete").await;
                return Ok(());
            }
            HostResponse::ContractResponse(ContractResponse::NotFound { .. }) => {
                bail!("contract was not found")
            }
            _ => {}
        }
    }
}

async fn publish_attachment(
    url: String,
    index_key: ContractKey,
    chunk_wasm: Arc<Vec<u8>>,
    upload: AttachmentUpload,
) -> Result<()> {
    verify_attachment_index_operation(&upload.operation)?;
    ensure!(
        upload.chunks.len() == upload.operation.manifest.chunks.len(),
        "attachment upload chunk count does not match its signed manifest"
    );
    let mut decoded_chunks = BTreeMap::new();
    for record in &upload.operation.manifest.chunks {
        let encoded = upload
            .chunks
            .get(&record.sha256)
            .context("attachment upload is missing a signed chunk")?;
        let bytes = URL_SAFE_NO_PAD
            .decode(encoded)
            .context("attachment chunk is not base64url")?;
        ensure!(
            bytes.len() as u64 == record.stored_bytes,
            "attachment chunk length does not match its manifest"
        );
        ensure!(
            hex::encode(sha2::Sha256::digest(&bytes)) == record.sha256,
            "attachment chunk does not match its content address"
        );
        decoded_chunks.insert(record.sha256.clone(), bytes);
    }

    let mut client = connect(url).await?;
    for (hash, bytes) in decoded_chunks {
        let parameters = hex::decode(&hash).context("attachment chunk hash is invalid")?;
        let contract = ContractContainer::Wasm(ContractWasmAPIVersion::V1(WrappedContract::new(
            Arc::new(ContractCode::from(chunk_wasm.as_ref().clone())),
            Parameters::from(parameters),
        )));
        client
            .send(ClientRequest::ContractOp(ContractRequest::Put {
                contract,
                state: WrappedState::from(bytes),
                related_contracts: RelatedContracts::default(),
                subscribe: false,
                blocking_subscribe: false,
            }))
            .await?;
        receive_put(&mut client).await?;
    }
    client
        .send(ClientRequest::ContractOp(ContractRequest::Update {
            key: index_key,
            data: UpdateData::Delta(StateDelta::from(serde_json::to_vec(&upload.operation)?)),
        }))
        .await?;
    loop {
        if let HostResponse::ContractResponse(ContractResponse::UpdateResponse { .. }) =
            timeout(Duration::from_secs(30), client.recv()).await??
        {
            client
                .disconnect("Nexus bridge attachment publish complete")
                .await;
            return Ok(());
        }
    }
}

async fn download_attachment(
    url: String,
    index_key: ContractKey,
    chunk_wasm: Arc<Vec<u8>>,
    reference: &str,
) -> Result<AttachmentDownload> {
    let index: AttachmentIndexState =
        serde_json::from_slice(fetch_wrapped_state(url.clone(), index_key).await?.as_ref())?;
    let operation = index
        .attachments
        .get(reference)
        .cloned()
        .context("attachment reference is not present in the signed index")?;
    verify_attachment_index_operation(&operation)?;
    let mut client = connect(url).await?;
    let mut chunks = BTreeMap::new();
    for record in &operation.manifest.chunks {
        let contract = ContractContainer::Wasm(ContractWasmAPIVersion::V1(WrappedContract::new(
            Arc::new(ContractCode::from(chunk_wasm.as_ref().clone())),
            Parameters::from(hex::decode(&record.sha256)?),
        )));
        let key = contract.key();
        client
            .send(ClientRequest::ContractOp(ContractRequest::Get {
                key: *key.id(),
                return_contract_code: false,
                subscribe: false,
                blocking_subscribe: false,
            }))
            .await?;
        loop {
            match timeout(Duration::from_secs(30), client.recv()).await?? {
                HostResponse::ContractResponse(ContractResponse::GetResponse { state, .. }) => {
                    ensure!(
                        hex::encode(sha2::Sha256::digest(state.as_ref())) == record.sha256,
                        "downloaded attachment chunk failed content verification"
                    );
                    chunks.insert(
                        record.sha256.clone(),
                        URL_SAFE_NO_PAD.encode(state.as_ref()),
                    );
                    break;
                }
                HostResponse::ContractResponse(ContractResponse::NotFound { .. }) => {
                    bail!("attachment chunk was not found")
                }
                _ => {}
            }
        }
    }
    client
        .disconnect("Nexus bridge attachment download complete")
        .await;
    Ok(AttachmentDownload { operation, chunks })
}

async fn bridge_health() -> Json<HealthResponse> {
    Json(HealthResponse {
        status: "ready",
        transport: "freenet-native",
    })
}

async fn bridge_state(
    State(state): State<Arc<BridgeState>>,
    AxumPath(peer): AxumPath<String>,
    headers: HeaderMap,
) -> BridgeResult<SegmentState> {
    authorize(&headers, &state.token)?;
    let url = peer_url(&state, &peer)
        .ok_or_else(|| bridge_error(StatusCode::NOT_FOUND, "unknown peer"))?;
    fetch_state(url, state.key)
        .await
        .map(Json)
        .map_err(|error| bridge_error(StatusCode::BAD_GATEWAY, error))
}

async fn bridge_update(
    State(state): State<Arc<BridgeState>>,
    AxumPath(peer): AxumPath<String>,
    headers: HeaderMap,
    Json(operation): Json<MessageOperation>,
) -> impl IntoResponse {
    if let Err(error) = authorize(&headers, &state.token) {
        return error.into_response();
    }
    let Some(url) = peer_url(&state, &peer) else {
        return bridge_error(StatusCode::NOT_FOUND, "unknown peer").into_response();
    };
    match submit_operation(url, state.key, operation).await {
        Ok(()) => StatusCode::NO_CONTENT.into_response(),
        Err(error) => bridge_error(StatusCode::BAD_GATEWAY, error).into_response(),
    }
}

async fn bridge_attachment_upload(
    State(state): State<Arc<BridgeState>>,
    AxumPath(peer): AxumPath<String>,
    headers: HeaderMap,
    Json(upload): Json<AttachmentUpload>,
) -> impl IntoResponse {
    if let Err(error) = authorize(&headers, &state.token) {
        return error.into_response();
    }
    let Some(url) = peer_url(&state, &peer) else {
        return bridge_error(StatusCode::NOT_FOUND, "unknown peer").into_response();
    };
    match publish_attachment(
        url,
        state.attachment_index_key,
        Arc::clone(&state.attachment_chunk_wasm),
        upload,
    )
    .await
    {
        Ok(()) => StatusCode::NO_CONTENT.into_response(),
        Err(error) => bridge_error(StatusCode::BAD_GATEWAY, error).into_response(),
    }
}

async fn bridge_attachment_download(
    State(state): State<Arc<BridgeState>>,
    AxumPath(peer): AxumPath<String>,
    Query(query): Query<AttachmentQuery>,
    headers: HeaderMap,
) -> impl IntoResponse {
    if let Err(error) = authorize(&headers, &state.token) {
        return error.into_response();
    }
    let Some(url) = peer_url(&state, &peer) else {
        return bridge_error(StatusCode::NOT_FOUND, "unknown peer").into_response();
    };
    match download_attachment(
        url,
        state.attachment_index_key,
        Arc::clone(&state.attachment_chunk_wasm),
        &query.reference,
    )
    .await
    {
        Ok(download) => Json(download).into_response(),
        Err(error) => bridge_error(StatusCode::BAD_GATEWAY, error).into_response(),
    }
}

async fn bridge_authority_bootstrap(
    State(state): State<Arc<BridgeState>>,
    AxumPath((peer, family)): AxumPath<(String, String)>,
    headers: HeaderMap,
    Json(initial_state): Json<Value>,
) -> impl IntoResponse {
    if let Err(error) = authorize(&headers, &state.token) {
        return error.into_response();
    }
    let Some(url) = peer_url(&state, &peer) else {
        return bridge_error(StatusCode::NOT_FOUND, "unknown peer").into_response();
    };
    let Some(contract) = authority_contract(&state, &family) else {
        return bridge_error(StatusCode::NOT_FOUND, "unknown authority family").into_response();
    };
    match bootstrap_authority(url, contract, initial_state).await {
        Ok(value) => Json(value).into_response(),
        Err(error) => bridge_error(StatusCode::BAD_GATEWAY, error).into_response(),
    }
}

async fn bridge_authority_state(
    State(state): State<Arc<BridgeState>>,
    AxumPath((peer, family)): AxumPath<(String, String)>,
    headers: HeaderMap,
) -> impl IntoResponse {
    if let Err(error) = authorize(&headers, &state.token) {
        return error.into_response();
    }
    let Some(url) = peer_url(&state, &peer) else {
        return bridge_error(StatusCode::NOT_FOUND, "unknown peer").into_response();
    };
    let Some(contract) = authority_contract(&state, &family) else {
        return bridge_error(StatusCode::NOT_FOUND, "unknown authority family").into_response();
    };
    match fetch_wrapped_state(url, contract.key).await {
        Ok(value) => match serde_json::from_slice::<Value>(value.as_ref()) {
            Ok(value) => Json(value).into_response(),
            Err(error) => bridge_error(StatusCode::BAD_GATEWAY, error).into_response(),
        },
        Err(error) => bridge_error(StatusCode::BAD_GATEWAY, error).into_response(),
    }
}

async fn bridge_authority_update(
    State(state): State<Arc<BridgeState>>,
    AxumPath((peer, family)): AxumPath<(String, String)>,
    headers: HeaderMap,
    Json(operation): Json<Value>,
) -> impl IntoResponse {
    if let Err(error) = authorize(&headers, &state.token) {
        return error.into_response();
    }
    let Some(url) = peer_url(&state, &peer) else {
        return bridge_error(StatusCode::NOT_FOUND, "unknown peer").into_response();
    };
    let Some(contract) = authority_contract(&state, &family) else {
        return bridge_error(StatusCode::NOT_FOUND, "unknown authority family").into_response();
    };
    match submit_authority_operation(url, contract.key, operation).await {
        Ok(()) => StatusCode::NO_CONTENT.into_response(),
        Err(error) => bridge_error(StatusCode::BAD_GATEWAY, error).into_response(),
    }
}

fn bridge_router(state: Arc<BridgeState>) -> Router {
    Router::new()
        .route("/nexus/v1/health", get(bridge_health))
        .route("/nexus/v1/peers/{peer}/state", get(bridge_state))
        .route("/nexus/v1/peers/{peer}/operations", post(bridge_update))
        .route(
            "/nexus/v1/peers/{peer}/attachments",
            post(bridge_attachment_upload).get(bridge_attachment_download),
        )
        .route(
            "/nexus/v1/peers/{peer}/authority/{family}/bootstrap",
            post(bridge_authority_bootstrap),
        )
        .route(
            "/nexus/v1/peers/{peer}/authority/{family}",
            get(bridge_authority_state).post(bridge_authority_update),
        )
        .layer(RequestBodyLimitLayer::new(40 * 1024 * 1024))
        .layer(
            CorsLayer::new()
                .allow_origin(Any)
                .allow_headers(Any)
                .allow_methods(Any),
        )
        .with_state(state)
}

fn write_descriptor(path: &Path, descriptor: &RuntimeDescriptor) -> Result<()> {
    let parent = path
        .parent()
        .context("runtime descriptor needs a parent directory")?;
    fs::create_dir_all(parent)?;
    let temporary = path.with_extension("json.pending");
    fs::write(&temporary, serde_json::to_vec_pretty(descriptor)?)?;
    fs::rename(temporary, path)?;
    Ok(())
}

async fn wait_for_stop_file(path: &Path) {
    loop {
        if path.exists() {
            return;
        }
        sleep(Duration::from_millis(250)).await;
    }
}

#[tokio::main(flavor = "multi_thread", worker_threads = 4)]
async fn main() -> Result<()> {
    let binary = PathBuf::from(
        env::var_os("NEXUS_FREENET_BIN")
            .context("set NEXUS_FREENET_BIN to the pinned Freenet Core executable")?,
    );
    let wasm = PathBuf::from(
        env::var_os("NEXUS_CONTRACT_WASM")
            .context("set NEXUS_CONTRACT_WASM to the message-segment Wasm artifact")?,
    );
    let attachment_index_wasm = PathBuf::from(
        env::var_os("NEXUS_ATTACHMENT_INDEX_CONTRACT_WASM")
            .context("set NEXUS_ATTACHMENT_INDEX_CONTRACT_WASM")?,
    );
    let attachment_chunk_wasm = PathBuf::from(
        env::var_os("NEXUS_ATTACHMENT_CHUNK_CONTRACT_WASM")
            .context("set NEXUS_ATTACHMENT_CHUNK_CONTRACT_WASM")?,
    );
    let community_wasm = PathBuf::from(
        env::var_os("NEXUS_COMMUNITY_CONTRACT_WASM")
            .context("set NEXUS_COMMUNITY_CONTRACT_WASM")?,
    );
    let conversation_wasm = PathBuf::from(
        env::var_os("NEXUS_PRIVATE_CONVERSATION_CONTRACT_WASM")
            .context("set NEXUS_PRIVATE_CONVERSATION_CONTRACT_WASM")?,
    );
    let descriptor_path = PathBuf::from(
        env::var_os("NEXUS_RUNTIME_CONFIG")
            .context("set NEXUS_RUNTIME_CONFIG to the runtime descriptor path")?,
    );
    let stop_path = PathBuf::from(
        env::var_os("NEXUS_RUNTIME_STOP_FILE")
            .context("set NEXUS_RUNTIME_STOP_FILE to the runtime stop-signal path")?,
    );
    ensure!(binary.is_file(), "Freenet binary does not exist");
    ensure!(wasm.is_file(), "Nexus contract Wasm does not exist");
    ensure!(
        attachment_index_wasm.is_file() && attachment_chunk_wasm.is_file(),
        "Nexus attachment contract Wasm does not exist"
    );
    ensure!(
        community_wasm.is_file() && conversation_wasm.is_file(),
        "Nexus authority contract Wasm does not exist"
    );

    let network = TestNetwork::builder()
        .gateways(1)
        .peers(1)
        .min_connections(1)
        .max_connections(4)
        .binary(FreenetBinary::Path(binary))
        .connectivity_timeout(Duration::from_secs(60))
        .build()
        .await
        .context("start the Phase 1 two-node Freenet network")?;

    let peer_a_url = network.peer(0).ws_url();
    let peer_b_url = network.gateway(0).ws_url();
    let mut peer_a = connect(peer_a_url.clone()).await?;
    let mut peer_b = connect(peer_b_url.clone()).await?;

    let contract = ContractContainer::Wasm(ContractWasmAPIVersion::V1(WrappedContract::new(
        Arc::new(ContractCode::from(fs::read(wasm)?)),
        Parameters::from(Vec::<u8>::new()),
    )));
    let key = contract.key();
    let initial_state = WrappedState::from(serde_json::to_vec(&SegmentState::default())?);

    peer_a
        .send(ClientRequest::ContractOp(ContractRequest::Put {
            contract,
            state: initial_state,
            related_contracts: RelatedContracts::default(),
            subscribe: false,
            blocking_subscribe: false,
        }))
        .await?;
    receive_put(&mut peer_a).await?;

    peer_b
        .send(ClientRequest::ContractOp(ContractRequest::Get {
            key: *key.id(),
            return_contract_code: false,
            subscribe: true,
            blocking_subscribe: true,
        }))
        .await?;
    receive_get(&mut peer_b).await?;

    let attachment_index_contract =
        ContractContainer::Wasm(ContractWasmAPIVersion::V1(WrappedContract::new(
            Arc::new(ContractCode::from(fs::read(attachment_index_wasm)?)),
            Parameters::from(Vec::<u8>::new()),
        )));
    let attachment_index_key = attachment_index_contract.key();
    peer_a
        .send(ClientRequest::ContractOp(ContractRequest::Put {
            contract: attachment_index_contract,
            state: WrappedState::from(serde_json::to_vec(&AttachmentIndexState::default())?),
            related_contracts: RelatedContracts::default(),
            subscribe: false,
            blocking_subscribe: false,
        }))
        .await?;
    receive_put(&mut peer_a).await?;
    peer_b
        .send(ClientRequest::ContractOp(ContractRequest::Get {
            key: *attachment_index_key.id(),
            return_contract_code: false,
            subscribe: true,
            blocking_subscribe: true,
        }))
        .await?;
    receive_get(&mut peer_b).await?;
    let attachment_chunk_wasm = Arc::new(fs::read(attachment_chunk_wasm)?);
    let community_wasm = Arc::new(fs::read(community_wasm)?);
    let community_contract =
        ContractContainer::Wasm(ContractWasmAPIVersion::V1(WrappedContract::new(
            Arc::new(ContractCode::from(community_wasm.as_ref().clone())),
            Parameters::from(Vec::<u8>::new()),
        )));
    let community = AuthorityContract {
        key: community_contract.key(),
        wasm: community_wasm,
    };
    let conversation_wasm = Arc::new(fs::read(conversation_wasm)?);
    let conversation_contract =
        ContractContainer::Wasm(ContractWasmAPIVersion::V1(WrappedContract::new(
            Arc::new(ContractCode::from(conversation_wasm.as_ref().clone())),
            Parameters::from(Vec::<u8>::new()),
        )));
    let conversation = AuthorityContract {
        key: conversation_contract.key(),
        wasm: conversation_wasm,
    };

    let bridge_listener =
        tokio::net::TcpListener::bind(SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 0)).await?;
    let bridge_address = bridge_listener.local_addr()?;
    let mut token_bytes = [0_u8; 32];
    OsRng.fill_bytes(&mut token_bytes);
    let bridge_token = URL_SAFE_NO_PAD.encode(token_bytes);
    let bridge = Arc::new(BridgeState {
        peer_a_url: peer_a_url.clone(),
        peer_b_url: peer_b_url.clone(),
        key,
        attachment_index_key,
        attachment_chunk_wasm,
        community,
        conversation,
        token: bridge_token.clone(),
    });
    let bridge_task = tokio::spawn(async move {
        axum::serve(bridge_listener, bridge_router(bridge))
            .await
            .context("serve the Nexus native bridge")
    });

    let descriptor = RuntimeDescriptor {
        peer_a_websocket_url: peer_a_url,
        peer_b_websocket_url: peer_b_url,
        contract_instance_id: key.id().to_string(),
        contract_code_hash: key.encoded_code_hash(),
        attachment_index_instance_id: attachment_index_key.id().to_string(),
        attachment_index_code_hash: attachment_index_key.encoded_code_hash(),
        bridge_url: format!("http://{bridge_address}/nexus/v1"),
        bridge_token,
        channel_id: CHANNEL_ID,
    };
    write_descriptor(&descriptor_path, &descriptor)?;
    println!("{}", serde_json::to_string(&descriptor)?);

    tokio::select! {
        result = tokio::signal::ctrl_c() => result.context("listen for Ctrl+C")?,
        () = wait_for_stop_file(&stop_path) => {}
    }

    bridge_task.abort();
    peer_a.disconnect("Nexus Phase 1 runtime stopping").await;
    peer_b.disconnect("Nexus Phase 1 runtime stopping").await;
    drop(network);
    Ok(())
}

#[cfg(test)]
mod tests {
    use base64::{Engine as _, engine::general_purpose::STANDARD};
    use freenet_stdlib::client_api::{ClientRequest, ContractRequest};

    #[test]
    fn typescript_sdk_update_frame_decodes_in_rust() {
        let bytes = STANDARD
            .decode("BAAAANz///8IAAAAAAAAAej///8IAAAAAAAAAtD///8QAAAAMAAAAAgADAALAAQACAAAAAgAAAAAAAACtv///wQAAAACAAAAe30AAAgADAAIAAQACAAAAAgAAAAwAAAAIAAAALe6OodPHRjpSaFjvn9QoSxeod8xaG0OLbhrLPMntRy8AAAGAAgABAAGAAAABAAAACAAAADvqKRUGIRvMV4yrJegflqJcMwNsLUTy1+urY9Dk6O0cA==")
            .unwrap();
        let request = ClientRequest::try_decode_fbs(&bytes).unwrap();
        assert!(matches!(
            request,
            ClientRequest::ContractOp(ContractRequest::Update { .. })
        ));
    }
}
