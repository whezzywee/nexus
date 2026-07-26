use std::{
    collections::{HashMap, HashSet},
    env,
    net::{IpAddr, Ipv4Addr, SocketAddr},
    path::{Path as FilePath, PathBuf},
    sync::{Arc, Mutex as StdMutex},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use axum::{
    Json, Router,
    extract::{
        ConnectInfo, Path, State, WebSocketUpgrade,
        ws::{Message, WebSocket},
    },
    http::{
        HeaderMap, HeaderName, HeaderValue, Method, StatusCode,
        header::{AUTHORIZATION, CACHE_CONTROL, CONTENT_TYPE},
    },
    response::{IntoResponse, Response},
    routing::{get, post},
};
use base64::{
    Engine,
    engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD},
};
use hmac::{Hmac, Mac};
use rand::RngCore;
use serde::{Deserialize, Serialize};
use sha1::Sha1;
use sha2::{Digest, Sha256};
use tokio::{
    sync::{Mutex, Semaphore, broadcast},
    time::timeout,
};
use tower_http::{
    cors::{AllowOrigin, CorsLayer},
    limit::RequestBodyLimitLayer,
    set_header::SetResponseHeaderLayer,
    trace::TraceLayer,
};
use tracing_subscriber::EnvFilter;

const PROTOCOL_VERSION: u16 = 1;
const MAX_UPDATE_BYTES: usize = 32 * 1024;
const IDEMPOTENCY_TTL: Duration = Duration::from_secs(24 * 60 * 60);
const IDEMPOTENCY_CAPACITY: usize = 20_000;
const UPSTREAM_TIMEOUT: Duration = Duration::from_secs(10);
const IDEMPOTENCY_HEADER: &str = "idempotency-key";
const DEFAULT_MEETING_INVITE_TTL_SECONDS: u64 = 24 * 60 * 60;
const MAX_MEETING_INVITE_TTL_SECONDS: u64 = 7 * 24 * 60 * 60;
const DEFAULT_MEETING_HOST_SESSION_TTL_SECONDS: u64 = 15 * 60;
const MAX_MEETING_HOST_SESSION_TTL_SECONDS: u64 = 60 * 60;
const MAX_MEETING_PARTICIPANTS: usize = 6;
const MAX_MEETING_SIGNAL_BYTES: usize = 64 * 1024;
const MEETING_JOIN_TIMEOUT: Duration = Duration::from_secs(10);

type HmacSha256 = Hmac<Sha256>;
type HmacSha1 = Hmac<Sha1>;

#[derive(Clone)]
struct TurnConfig {
    secret: Arc<[u8]>,
    urls: Arc<[String]>,
    ttl_seconds: u64,
}

#[derive(Clone)]
struct GatewayConfig {
    gateway_id: String,
    bind: SocketAddr,
    hmac_secret: Arc<[u8]>,
    allowed_contracts: Arc<HashSet<String>>,
    allowed_origins: Vec<HeaderValue>,
    upstream_url: String,
    upstream_token: Arc<str>,
    idempotency_path: PathBuf,
    subject_rate: f64,
    subject_burst: f64,
    ip_rate: f64,
    ip_burst: f64,
    turn: Option<TurnConfig>,
    meeting_invite_ttl_seconds: u64,
    meeting_host_secret: Option<Arc<[u8]>>,
    meeting_host_session_ttl_seconds: u64,
}

impl GatewayConfig {
    fn from_env() -> Result<Self, String> {
        let bind: SocketAddr = env::var("NEXUS_GATEWAY_BIND")
            .unwrap_or_else(|_| SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 8787).to_string())
            .parse()
            .map_err(|error| format!("NEXUS_GATEWAY_BIND is invalid: {error}"))?;
        let secret = env::var("NEXUS_GATEWAY_HMAC_SECRET")
            .map_err(|_| "NEXUS_GATEWAY_HMAC_SECRET is required".to_owned())?;
        if secret.len() < 32 {
            return Err("NEXUS_GATEWAY_HMAC_SECRET must contain at least 32 bytes".into());
        }
        let allowed_contracts = comma_set("NEXUS_GATEWAY_CONTRACT_KEYS");
        if allowed_contracts.is_empty() {
            return Err(
                "NEXUS_GATEWAY_CONTRACT_KEYS must contain at least one contract key".into(),
            );
        }
        let allowed_origins = env::var("NEXUS_GATEWAY_ORIGINS")
            .unwrap_or_default()
            .split(',')
            .filter(|origin| !origin.trim().is_empty())
            .map(|origin| {
                origin
                    .trim()
                    .parse()
                    .map_err(|error| format!("Invalid gateway origin {origin}: {error}"))
            })
            .collect::<Result<Vec<_>, _>>()?;
        if !bind.ip().is_loopback() && allowed_origins.is_empty() {
            return Err("A non-loopback gateway requires NEXUS_GATEWAY_ORIGINS".into());
        }
        let upstream_url = env::var("NEXUS_GATEWAY_UPSTREAM_URL")
            .map_err(|_| "NEXUS_GATEWAY_UPSTREAM_URL is required".to_owned())?;
        validate_upstream_url(&upstream_url)?;
        let upstream_token = env::var("NEXUS_GATEWAY_UPSTREAM_TOKEN")
            .map_err(|_| "NEXUS_GATEWAY_UPSTREAM_TOKEN is required".to_owned())?;
        if upstream_token.len() < 24 {
            return Err("NEXUS_GATEWAY_UPSTREAM_TOKEN is unexpectedly short".into());
        }
        let idempotency_path = env::var_os("NEXUS_GATEWAY_IDEMPOTENCY_PATH")
            .map(PathBuf::from)
            .unwrap_or_else(|| {
                PathBuf::from(".runtime")
                    .join("gateway")
                    .join("idempotency.json")
            });
        if !bind.ip().is_loopback() && env::var_os("NEXUS_GATEWAY_IDEMPOTENCY_PATH").is_none() {
            return Err("A non-loopback gateway requires NEXUS_GATEWAY_IDEMPOTENCY_PATH".into());
        }
        let meeting_host_secret = optional_secret(
            "NEXUS_MEETING_HOST_SECRET",
            "NEXUS_MEETING_HOST_SECRET_FILE",
        )?;
        Ok(Self {
            gateway_id: env::var("NEXUS_GATEWAY_ID").unwrap_or_else(|_| "nexus-gateway".into()),
            bind,
            hmac_secret: Arc::from(secret.into_bytes()),
            allowed_contracts: Arc::new(allowed_contracts),
            allowed_origins,
            upstream_url: upstream_url.trim_end_matches('/').to_owned(),
            upstream_token: Arc::from(upstream_token),
            idempotency_path,
            subject_rate: positive_number("NEXUS_GATEWAY_SUBJECT_RATE", 5.0)?,
            subject_burst: positive_number("NEXUS_GATEWAY_SUBJECT_BURST", 20.0)?,
            ip_rate: positive_number("NEXUS_GATEWAY_IP_RATE", 20.0)?,
            ip_burst: positive_number("NEXUS_GATEWAY_IP_BURST", 60.0)?,
            turn: turn_config_from_env()?,
            meeting_invite_ttl_seconds: bounded_u64(
                "NEXUS_MEETING_INVITE_TTL_SECONDS",
                DEFAULT_MEETING_INVITE_TTL_SECONDS,
                5 * 60,
                MAX_MEETING_INVITE_TTL_SECONDS,
            )?,
            meeting_host_secret,
            meeting_host_session_ttl_seconds: bounded_u64(
                "NEXUS_MEETING_HOST_SESSION_TTL_SECONDS",
                DEFAULT_MEETING_HOST_SESSION_TTL_SECONDS,
                5 * 60,
                MAX_MEETING_HOST_SESSION_TTL_SECONDS,
            )?,
        })
    }
}

fn optional_secret(env_name: &str, file_name: &str) -> Result<Option<Arc<[u8]>>, String> {
    let direct = env::var(env_name).ok();
    let file = env::var_os(file_name);
    if direct.is_some() && file.is_some() {
        return Err(format!("{env_name} and {file_name} cannot both be set"));
    }
    let secret = match (direct, file) {
        (Some(value), None) => Some(value),
        (None, Some(path)) => Some(
            std::fs::read_to_string(&path)
                .map_err(|error| format!("Could not read {file_name}: {error}"))?,
        ),
        (None, None) => None,
        (Some(_), Some(_)) => unreachable!(),
    };
    secret
        .map(|value| {
            let trimmed = value.trim();
            if !(32..=256).contains(&trimmed.len()) {
                return Err(format!("{env_name} must contain between 32 and 256 bytes"));
            }
            Ok(Arc::from(trimmed.as_bytes()))
        })
        .transpose()
}

fn turn_config_from_env() -> Result<Option<TurnConfig>, String> {
    let secret = env::var("NEXUS_TURN_SECRET").ok();
    let urls = env::var("NEXUS_TURN_URLS").ok();
    match (secret, urls) {
        (None, None) => Ok(None),
        (Some(secret), Some(raw_urls)) => {
            if secret.len() < 32 {
                return Err("NEXUS_TURN_SECRET must contain at least 32 bytes".into());
            }
            let urls = raw_urls
                .split(',')
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(str::to_owned)
                .collect::<Vec<_>>();
            if urls.is_empty()
                || urls.len() > 8
                || urls.iter().any(|url| {
                    url.len() > 512 || (!url.starts_with("turn:") && !url.starts_with("turns:"))
                })
            {
                return Err("NEXUS_TURN_URLS must contain 1-8 bounded turn: or turns: URLs".into());
            }
            let ttl_seconds = env::var("NEXUS_TURN_TTL_SECONDS")
                .unwrap_or_else(|_| "300".into())
                .parse::<u64>()
                .map_err(|error| format!("NEXUS_TURN_TTL_SECONDS is invalid: {error}"))?;
            if !(60..=3600).contains(&ttl_seconds) {
                return Err("NEXUS_TURN_TTL_SECONDS must be between 60 and 3600".into());
            }
            Ok(Some(TurnConfig {
                secret: Arc::from(secret.into_bytes()),
                urls: Arc::from(urls),
                ttl_seconds,
            }))
        }
        _ => Err("NEXUS_TURN_SECRET and NEXUS_TURN_URLS must be configured together".into()),
    }
}

fn comma_set(name: &str) -> HashSet<String> {
    env::var(name)
        .unwrap_or_default()
        .split(',')
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
        .collect()
}

fn positive_number(name: &str, default: f64) -> Result<f64, String> {
    let value = match env::var(name) {
        Ok(raw) => raw
            .parse()
            .map_err(|error| format!("{name} is invalid: {error}"))?,
        Err(_) => default,
    };
    if value <= 0.0 || !value.is_finite() {
        return Err(format!("{name} must be a positive finite number"));
    }
    Ok(value)
}

fn bounded_u64(name: &str, default: u64, minimum: u64, maximum: u64) -> Result<u64, String> {
    let value = match env::var(name) {
        Ok(raw) => raw
            .parse()
            .map_err(|error| format!("{name} is invalid: {error}"))?,
        Err(_) => default,
    };
    if !(minimum..=maximum).contains(&value) {
        return Err(format!("{name} must be between {minimum} and {maximum}"));
    }
    Ok(value)
}

fn validate_upstream_url(raw: &str) -> Result<(), String> {
    let url = reqwest::Url::parse(raw)
        .map_err(|error| format!("NEXUS_GATEWAY_UPSTREAM_URL is invalid: {error}"))?;
    match url.scheme() {
        "https" => Ok(()),
        "http" if url.host_str().is_some_and(is_loopback_host) => Ok(()),
        _ => Err("Gateway upstream must use HTTPS, or HTTP on loopback".into()),
    }
}

fn is_loopback_host(host: &str) -> bool {
    host.eq_ignore_ascii_case("localhost")
        || host
            .parse::<IpAddr>()
            .is_ok_and(|address| address.is_loopback())
}

struct GatewayState {
    config: GatewayConfig,
    client: reqwest::Client,
    rates: StdMutex<HashMap<String, TokenBucket>>,
    idempotency: Mutex<HashMap<String, IdempotencyEntry>>,
    meeting_rooms: Mutex<HashMap<String, MeetingRoom>>,
    upstream_slots: Semaphore,
}

#[derive(Clone)]
struct TokenBucket {
    tokens: f64,
    updated_at: Instant,
}

#[derive(Clone)]
struct IdempotencyEntry {
    payload_hash: String,
    created_at: u64,
    response: Option<UpdateResponse>,
}

struct MeetingRoom {
    participants: HashSet<String>,
    sender: broadcast::Sender<MeetingServerFrame>,
}

#[derive(Serialize, Deserialize)]
struct PersistedIdempotencyEntry {
    operation_id: String,
    payload_hash: String,
    created_at: u64,
    response: UpdateResponse,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct AccessClaims {
    sub: String,
    exp: u64,
    permissions: Vec<String>,
    contracts: Vec<String>,
}

#[derive(Debug, Deserialize, Serialize)]
struct UpdateRequest {
    operation_id: String,
    contract_type: String,
    encoding: String,
    payload: String,
    payload_hash: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct UpdateResponse {
    request_id: String,
    gateway_id: String,
    server_time: u64,
    operation_id: String,
    state: String,
    payload_hash: String,
    replayed: bool,
}

#[derive(Serialize)]
struct HealthResponse {
    service: &'static str,
    protocol_version: u16,
    status: &'static str,
    freenet: &'static str,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct TurnCredentialResponse {
    urls: Vec<String>,
    username: String,
    credential: String,
    expires_at: u64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct MeetingInviteRequest {
    room_id: String,
    room_name: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct MeetingInviteResponse {
    room_id: String,
    room_name: String,
    access_token: String,
    expires_at: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct MeetingHostSessionResponse {
    access_token: String,
    expires_at: u64,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum MeetingClientFrame {
    Join {
        access_token: String,
        participant_id: String,
    },
    Signal {
        to: String,
        ciphertext: String,
    },
    Ping,
    Leave,
}

#[derive(Clone, Debug, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum MeetingServerFrame {
    Ready {
        participants: Vec<String>,
    },
    ParticipantJoined {
        participant_id: String,
    },
    ParticipantLeft {
        participant_id: String,
    },
    Signal {
        from: String,
        to: String,
        ciphertext: String,
    },
    Pong,
    Error {
        code: &'static str,
        message: String,
    },
}

#[derive(Debug)]
struct ApiError {
    status: StatusCode,
    code: &'static str,
    message: String,
    request_id: String,
}

#[derive(Serialize)]
struct ErrorResponse {
    request_id: String,
    gateway_id: &'static str,
    server_time: u64,
    code: &'static str,
    message: String,
}

impl ApiError {
    fn new(status: StatusCode, code: &'static str, message: impl Into<String>) -> Self {
        Self {
            status,
            code,
            message: message.into(),
            request_id: request_id(),
        }
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (
            self.status,
            Json(ErrorResponse {
                request_id: self.request_id,
                gateway_id: "nexus-gateway",
                server_time: unix_time(),
                code: self.code,
                message: self.message,
            }),
        )
            .into_response()
    }
}

async fn health() -> Json<HealthResponse> {
    Json(HealthResponse {
        service: "nexus-gateway",
        protocol_version: PROTOCOL_VERSION,
        status: "ready",
        freenet: "configured",
    })
}

async fn submit_update(
    ConnectInfo(remote): ConnectInfo<SocketAddr>,
    State(state): State<Arc<GatewayState>>,
    Path(contract_key): Path<String>,
    headers: HeaderMap,
    Json(update): Json<UpdateRequest>,
) -> Result<(StatusCode, Json<UpdateResponse>), ApiError> {
    let claims = authorize(&headers, &state.config)?;
    authorize_contract(&claims, &contract_key, &state.config)?;
    enforce_rate_limits(&state, &claims.sub, remote.ip())?;
    let payload = validate_update(&headers, &update)?;

    if let Some(replayed) =
        begin_idempotent_request(&state, &update.operation_id, &update.payload_hash).await?
    {
        return Ok((StatusCode::OK, Json(replayed)));
    }

    let permit = match timeout(Duration::from_millis(250), state.upstream_slots.acquire()).await {
        Ok(Ok(permit)) => permit,
        _ => {
            forget_idempotent_request(&state, &update.operation_id).await;
            return Err(ApiError::new(
                StatusCode::SERVICE_UNAVAILABLE,
                "gateway_busy",
                "Gateway upstream concurrency is saturated",
            ));
        }
    };
    let upstream_result = forward_update(&state, &contract_key, &headers, &update, payload).await;
    drop(permit);
    if let Err(error) = upstream_result {
        forget_idempotent_request(&state, &update.operation_id).await;
        return Err(error);
    }

    let response = UpdateResponse {
        request_id: request_id(),
        gateway_id: state.config.gateway_id.clone(),
        server_time: unix_time(),
        operation_id: update.operation_id.clone(),
        state: "accepted".into(),
        payload_hash: update.payload_hash.clone(),
        replayed: false,
    };
    complete_idempotent_request(&state, &update.operation_id, response.clone()).await?;
    Ok((StatusCode::ACCEPTED, Json(response)))
}

async fn issue_turn_credential(
    ConnectInfo(remote): ConnectInfo<SocketAddr>,
    State(state): State<Arc<GatewayState>>,
    headers: HeaderMap,
) -> Result<(HeaderMap, Json<TurnCredentialResponse>), ApiError> {
    let claims = authorize(&headers, &state.config)?;
    if !claims.permissions.iter().any(|value| value == "turn") {
        return Err(ApiError::new(
            StatusCode::FORBIDDEN,
            "insufficient_scope",
            "The token cannot request TURN credentials",
        ));
    }
    enforce_rate_limits(&state, &claims.sub, remote.ip())?;
    let turn = state.config.turn.as_ref().ok_or_else(|| {
        ApiError::new(
            StatusCode::SERVICE_UNAVAILABLE,
            "turn_unavailable",
            "TURN credentials are not configured on this gateway",
        )
    })?;
    let credential = mint_turn_credential(turn, &claims.sub, unix_time())?;
    let mut response_headers = HeaderMap::new();
    response_headers.insert(CACHE_CONTROL, HeaderValue::from_static("no-store"));
    Ok((response_headers, Json(credential)))
}

async fn issue_meeting_invite(
    ConnectInfo(remote): ConnectInfo<SocketAddr>,
    State(state): State<Arc<GatewayState>>,
    headers: HeaderMap,
    Json(request): Json<MeetingInviteRequest>,
) -> Result<(StatusCode, HeaderMap, Json<MeetingInviteResponse>), ApiError> {
    let claims = authorize(&headers, &state.config)?;
    if !claims.permissions.iter().any(|value| value == "meeting") {
        return Err(ApiError::new(
            StatusCode::FORBIDDEN,
            "insufficient_scope",
            "The token cannot create meeting invitations",
        ));
    }
    enforce_rate_limits(&state, &claims.sub, remote.ip())?;
    validate_meeting_room(&request.room_id, &request.room_name)?;
    let now = unix_time();
    let expiry = now
        .checked_add(state.config.meeting_invite_ttl_seconds)
        .ok_or_else(|| {
            ApiError::new(
                StatusCode::INTERNAL_SERVER_ERROR,
                "clock_error",
                "Meeting invitation expiry overflowed",
            )
        })?;
    let invite_claims = AccessClaims {
        sub: format!("meeting:{}:{}", request.room_id, request_id()),
        exp: expiry,
        permissions: vec!["meeting".into(), "turn".into()],
        contracts: Vec::new(),
    };
    let access_token = sign_access_token(&invite_claims, &state.config.hmac_secret)?;
    let mut response_headers = HeaderMap::new();
    response_headers.insert(CACHE_CONTROL, HeaderValue::from_static("no-store"));
    Ok((
        StatusCode::CREATED,
        response_headers,
        Json(MeetingInviteResponse {
            room_id: request.room_id,
            room_name: request.room_name.trim().to_owned(),
            access_token,
            expires_at: expiry.saturating_mul(1000),
        }),
    ))
}

async fn issue_meeting_host_session(
    ConnectInfo(remote): ConnectInfo<SocketAddr>,
    State(state): State<Arc<GatewayState>>,
    headers: HeaderMap,
) -> Result<(HeaderMap, Json<MeetingHostSessionResponse>), ApiError> {
    enforce_rate_limits(
        &state,
        &format!("meeting-host-session:{}", remote.ip()),
        remote.ip(),
    )?;
    let configured_secret = state.config.meeting_host_secret.as_ref().ok_or_else(|| {
        ApiError::new(
            StatusCode::SERVICE_UNAVAILABLE,
            "host_sessions_unavailable",
            "Meeting host sessions are not configured",
        )
    })?;
    let supplied_secret = headers
        .get(AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Nexus-Host "))
        .filter(|value| (32..=256).contains(&value.len()))
        .ok_or_else(|| {
            ApiError::new(
                StatusCode::UNAUTHORIZED,
                "invalid_host_secret",
                "The meeting host passphrase is invalid",
            )
        })?;
    if !meeting_host_secret_matches(configured_secret, supplied_secret.as_bytes()) {
        return Err(ApiError::new(
            StatusCode::UNAUTHORIZED,
            "invalid_host_secret",
            "The meeting host passphrase is invalid",
        ));
    }
    let now = unix_time();
    let expiry = now
        .checked_add(state.config.meeting_host_session_ttl_seconds)
        .ok_or_else(|| {
            ApiError::new(
                StatusCode::INTERNAL_SERVER_ERROR,
                "clock_error",
                "Meeting host session expiry overflowed",
            )
        })?;
    let claims = AccessClaims {
        sub: format!("meeting-host:{}", request_id()),
        exp: expiry,
        permissions: vec!["meeting".into()],
        contracts: Vec::new(),
    };
    let mut response_headers = HeaderMap::new();
    response_headers.insert(CACHE_CONTROL, HeaderValue::from_static("no-store"));
    Ok((
        response_headers,
        Json(MeetingHostSessionResponse {
            access_token: sign_access_token(&claims, &state.config.hmac_secret)?,
            expires_at: expiry.saturating_mul(1000),
        }),
    ))
}

fn meeting_host_secret_matches(expected: &[u8], supplied: &[u8]) -> bool {
    const CONTEXT: &[u8] = b"nexus:meeting-host-session:v1";
    let Ok(mut supplied_mac) = HmacSha256::new_from_slice(supplied) else {
        return false;
    };
    supplied_mac.update(CONTEXT);
    let supplied_tag = supplied_mac.finalize().into_bytes();
    let Ok(mut expected_mac) = HmacSha256::new_from_slice(expected) else {
        return false;
    };
    expected_mac.update(CONTEXT);
    expected_mac.verify_slice(&supplied_tag).is_ok()
}

async fn meeting_websocket(
    ConnectInfo(remote): ConnectInfo<SocketAddr>,
    State(state): State<Arc<GatewayState>>,
    Path(room_id): Path<String>,
    headers: HeaderMap,
    websocket: WebSocketUpgrade,
) -> Result<Response, ApiError> {
    validate_meeting_room(&room_id, "Meeting")?;
    validate_meeting_origin(&headers, &state.config)?;
    Ok(websocket
        .max_message_size(MAX_MEETING_SIGNAL_BYTES + 8 * 1024)
        .max_frame_size(MAX_MEETING_SIGNAL_BYTES + 8 * 1024)
        .on_upgrade(move |socket| serve_meeting_socket(socket, state, room_id, remote))
        .into_response())
}

async fn serve_meeting_socket(
    mut socket: WebSocket,
    state: Arc<GatewayState>,
    room_id: String,
    remote: SocketAddr,
) {
    let Some(Ok(Message::Text(first_message))) = timeout(MEETING_JOIN_TIMEOUT, socket.recv())
        .await
        .ok()
        .flatten()
    else {
        let _ = send_meeting_frame(
            &mut socket,
            &MeetingServerFrame::Error {
                code: "join_required",
                message: "The first meeting frame must authenticate and join.".into(),
            },
        )
        .await;
        return;
    };
    let Ok(MeetingClientFrame::Join {
        access_token,
        participant_id,
    }) = serde_json::from_str::<MeetingClientFrame>(&first_message)
    else {
        let _ = send_meeting_frame(
            &mut socket,
            &MeetingServerFrame::Error {
                code: "join_required",
                message: "The first meeting frame must authenticate and join.".into(),
            },
        )
        .await;
        return;
    };
    let claims =
        match authorize_meeting_capability(&access_token, &room_id, &participant_id, &state.config)
        {
            Ok(claims) => claims,
            Err(error) => {
                let _ = send_meeting_frame(
                    &mut socket,
                    &MeetingServerFrame::Error {
                        code: error.code,
                        message: error.message,
                    },
                )
                .await;
                return;
            }
        };
    if let Err(error) = enforce_rate_limits(&state, &claims.sub, remote.ip()) {
        let _ = send_meeting_frame(
            &mut socket,
            &MeetingServerFrame::Error {
                code: error.code,
                message: error.message,
            },
        )
        .await;
        return;
    }

    let (sender, mut receiver, participants) = {
        let mut rooms = state.meeting_rooms.lock().await;
        let room = rooms.entry(room_id.clone()).or_insert_with(|| {
            let (sender, _) = broadcast::channel(128);
            MeetingRoom {
                participants: HashSet::new(),
                sender,
            }
        });
        if room.participants.contains(&participant_id) {
            let _ = send_meeting_frame(
                &mut socket,
                &MeetingServerFrame::Error {
                    code: "participant_conflict",
                    message: "This participant is already connected.".into(),
                },
            )
            .await;
            return;
        }
        if room.participants.len() >= MAX_MEETING_PARTICIPANTS {
            let _ = send_meeting_frame(
                &mut socket,
                &MeetingServerFrame::Error {
                    code: "room_full",
                    message: "This small meeting already has six participants.".into(),
                },
            )
            .await;
            return;
        }
        let mut participants = room.participants.iter().cloned().collect::<Vec<_>>();
        participants.sort();
        room.participants.insert(participant_id.clone());
        (room.sender.clone(), room.sender.subscribe(), participants)
    };

    if send_meeting_frame(&mut socket, &MeetingServerFrame::Ready { participants })
        .await
        .is_err()
    {
        remove_meeting_participant(&state, &room_id, &participant_id).await;
        return;
    }
    let _ = sender.send(MeetingServerFrame::ParticipantJoined {
        participant_id: participant_id.clone(),
    });

    loop {
        tokio::select! {
            incoming = socket.recv() => {
                match incoming {
                    Some(Ok(Message::Text(payload))) => {
                        match serde_json::from_str::<MeetingClientFrame>(&payload) {
                            Ok(MeetingClientFrame::Signal { to, ciphertext })
                                if valid_participant_id(&to)
                                    && valid_meeting_ciphertext(&ciphertext)
                                    && meeting_has_participant(&state, &room_id, &to).await =>
                            {
                                let _ = sender.send(MeetingServerFrame::Signal {
                                    from: participant_id.clone(),
                                    to,
                                    ciphertext,
                                });
                            }
                            Ok(MeetingClientFrame::Ping) => {
                                if send_meeting_frame(&mut socket, &MeetingServerFrame::Pong).await.is_err() {
                                    break;
                                }
                            }
                            Ok(MeetingClientFrame::Leave) => break,
                            _ => {
                                if send_meeting_frame(
                                    &mut socket,
                                    &MeetingServerFrame::Error {
                                        code: "invalid_frame",
                                        message: "The meeting frame is invalid or its recipient is unavailable.".into(),
                                    },
                                ).await.is_err() {
                                    break;
                                }
                            }
                        }
                    }
                    Some(Ok(Message::Ping(payload))) => {
                        if socket.send(Message::Pong(payload)).await.is_err() {
                            break;
                        }
                    }
                    Some(Ok(Message::Close(_))) | None | Some(Err(_)) => break,
                    _ => {}
                }
            }
            outgoing = receiver.recv() => {
                match outgoing {
                    Ok(frame) => {
                        let addressed_elsewhere = matches!(
                            &frame,
                            MeetingServerFrame::Signal { to, .. } if to != &participant_id
                        );
                        if !addressed_elsewhere && send_meeting_frame(&mut socket, &frame).await.is_err() {
                            break;
                        }
                    }
                    Err(broadcast::error::RecvError::Lagged(_)) => {
                        let _ = send_meeting_frame(
                            &mut socket,
                            &MeetingServerFrame::Error {
                                code: "signal_lagged",
                                message: "Meeting signaling fell behind; reconnect to resynchronize.".into(),
                            },
                        ).await;
                        break;
                    }
                    Err(broadcast::error::RecvError::Closed) => break,
                }
            }
        }
    }

    remove_meeting_participant(&state, &room_id, &participant_id).await;
    let _ = sender.send(MeetingServerFrame::ParticipantLeft { participant_id });
}

async fn send_meeting_frame(
    socket: &mut WebSocket,
    frame: &MeetingServerFrame,
) -> Result<(), axum::Error> {
    let encoded = serde_json::to_string(frame).expect("meeting server frame should serialize");
    socket.send(Message::Text(encoded.into())).await
}

async fn meeting_has_participant(
    state: &GatewayState,
    room_id: &str,
    participant_id: &str,
) -> bool {
    state
        .meeting_rooms
        .lock()
        .await
        .get(room_id)
        .is_some_and(|room| room.participants.contains(participant_id))
}

async fn remove_meeting_participant(state: &GatewayState, room_id: &str, participant_id: &str) {
    let mut rooms = state.meeting_rooms.lock().await;
    let should_remove = if let Some(room) = rooms.get_mut(room_id) {
        room.participants.remove(participant_id);
        room.participants.is_empty()
    } else {
        false
    };
    if should_remove {
        rooms.remove(room_id);
    }
}

fn authorize_meeting_capability(
    access_token: &str,
    room_id: &str,
    participant_id: &str,
    config: &GatewayConfig,
) -> Result<AccessClaims, ApiError> {
    if !valid_participant_id(participant_id) {
        return Err(ApiError::new(
            StatusCode::BAD_REQUEST,
            "invalid_participant_id",
            "Meeting participant IDs must contain 8-128 URL-safe characters",
        ));
    }
    let claims = verify_access_token(access_token, &config.hmac_secret)
        .map_err(|message| ApiError::new(StatusCode::UNAUTHORIZED, "invalid_token", message))?;
    if !meeting_claims_allow_room(&claims, room_id) {
        return Err(ApiError::new(
            StatusCode::FORBIDDEN,
            "wrong_meeting",
            "This invitation cannot join the requested meeting",
        ));
    }
    Ok(claims)
}

fn meeting_claims_allow_room(claims: &AccessClaims, room_id: &str) -> bool {
    claims.permissions.iter().any(|scope| scope == "meeting")
        && claims.sub.starts_with(&format!("meeting:{room_id}:"))
}

fn valid_participant_id(participant_id: &str) -> bool {
    (8..=128).contains(&participant_id.len())
        && participant_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
}

fn valid_meeting_ciphertext(ciphertext: &str) -> bool {
    (16..=MAX_MEETING_SIGNAL_BYTES).contains(&ciphertext.len())
        && ciphertext
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
}

fn validate_meeting_origin(headers: &HeaderMap, config: &GatewayConfig) -> Result<(), ApiError> {
    let origin = headers
        .get("origin")
        .and_then(|value| value.to_str().ok())
        .ok_or_else(|| {
            ApiError::new(
                StatusCode::FORBIDDEN,
                "origin_required",
                "Meeting WebSocket connections require an allowed browser origin",
            )
        })?;
    let explicitly_allowed = config
        .allowed_origins
        .iter()
        .any(|allowed| allowed.as_bytes() == origin.as_bytes());
    let loopback_development = config.allowed_origins.is_empty()
        && reqwest::Url::parse(origin)
            .ok()
            .and_then(|url| url.host_str().map(is_loopback_host))
            .unwrap_or(false);
    if !explicitly_allowed && !loopback_development {
        return Err(ApiError::new(
            StatusCode::FORBIDDEN,
            "origin_not_allowed",
            "The browser origin is not allowed for meeting signaling",
        ));
    }
    Ok(())
}

fn validate_meeting_room(room_id: &str, room_name: &str) -> Result<(), ApiError> {
    if !(8..=64).contains(&room_id.len())
        || !room_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
    {
        return Err(ApiError::new(
            StatusCode::BAD_REQUEST,
            "invalid_room_id",
            "Meeting room IDs must contain 8-64 URL-safe characters",
        ));
    }
    let room_name = room_name.trim();
    if room_name.is_empty()
        || room_name.chars().count() > 80
        || room_name.chars().any(char::is_control)
    {
        return Err(ApiError::new(
            StatusCode::BAD_REQUEST,
            "invalid_room_name",
            "Meeting room names must contain 1-80 visible characters",
        ));
    }
    Ok(())
}

fn mint_turn_credential(
    config: &TurnConfig,
    subject: &str,
    now: u64,
) -> Result<TurnCredentialResponse, ApiError> {
    let expiry = now.checked_add(config.ttl_seconds).ok_or_else(|| {
        ApiError::new(
            StatusCode::INTERNAL_SERVER_ERROR,
            "clock_error",
            "TURN credential expiry overflowed",
        )
    })?;
    let username = format!("{expiry}:{subject}");
    let mut mac = HmacSha1::new_from_slice(&config.secret).map_err(|_| {
        ApiError::new(
            StatusCode::INTERNAL_SERVER_ERROR,
            "turn_secret_invalid",
            "TURN credential signing is unavailable",
        )
    })?;
    mac.update(username.as_bytes());
    Ok(TurnCredentialResponse {
        urls: config.urls.to_vec(),
        username,
        credential: STANDARD.encode(mac.finalize().into_bytes()),
        expires_at: expiry.saturating_mul(1000),
    })
}

fn authorize(headers: &HeaderMap, config: &GatewayConfig) -> Result<AccessClaims, ApiError> {
    let raw = headers
        .get(AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "))
        .ok_or_else(|| {
            ApiError::new(
                StatusCode::UNAUTHORIZED,
                "missing_token",
                "A bearer access token is required",
            )
        })?;
    verify_access_token(raw, &config.hmac_secret)
        .map_err(|message| ApiError::new(StatusCode::UNAUTHORIZED, "invalid_token", message))
}

fn verify_access_token(token: &str, secret: &[u8]) -> Result<AccessClaims, String> {
    let mut parts = token.split('.');
    if parts.next() != Some("v1") {
        return Err("Unsupported access token version".into());
    }
    let payload = parts
        .next()
        .ok_or_else(|| "Access token payload is missing".to_owned())?;
    let signature = parts
        .next()
        .ok_or_else(|| "Access token signature is missing".to_owned())?;
    if parts.next().is_some() {
        return Err("Access token has too many sections".into());
    }
    let signature = URL_SAFE_NO_PAD
        .decode(signature)
        .map_err(|_| "Access token signature is malformed".to_owned())?;
    let mut mac =
        HmacSha256::new_from_slice(secret).map_err(|_| "Access token key is invalid".to_owned())?;
    mac.update(format!("v1.{payload}").as_bytes());
    mac.verify_slice(&signature)
        .map_err(|_| "Access token signature is invalid".to_owned())?;
    let claims: AccessClaims = serde_json::from_slice(
        &URL_SAFE_NO_PAD
            .decode(payload)
            .map_err(|_| "Access token payload is malformed".to_owned())?,
    )
    .map_err(|_| "Access token claims are malformed".to_owned())?;
    if claims.sub.is_empty() || claims.sub.len() > 128 {
        return Err("Access token subject is invalid".into());
    }
    if claims.exp <= unix_time() {
        return Err("Access token has expired".into());
    }
    Ok(claims)
}

fn sign_access_token(claims: &AccessClaims, secret: &[u8]) -> Result<String, ApiError> {
    let payload = URL_SAFE_NO_PAD.encode(serde_json::to_vec(claims).map_err(|_| {
        ApiError::new(
            StatusCode::INTERNAL_SERVER_ERROR,
            "token_encoding_failed",
            "Meeting invitation could not be encoded",
        )
    })?);
    let unsigned = format!("v1.{payload}");
    let mut mac = HmacSha256::new_from_slice(secret).map_err(|_| {
        ApiError::new(
            StatusCode::INTERNAL_SERVER_ERROR,
            "token_signing_failed",
            "Meeting invitation signing is unavailable",
        )
    })?;
    mac.update(unsigned.as_bytes());
    Ok(format!(
        "{unsigned}.{}",
        URL_SAFE_NO_PAD.encode(mac.finalize().into_bytes())
    ))
}

fn authorize_contract(
    claims: &AccessClaims,
    contract_key: &str,
    config: &GatewayConfig,
) -> Result<(), ApiError> {
    if !config.allowed_contracts.contains(contract_key) {
        return Err(ApiError::new(
            StatusCode::NOT_FOUND,
            "contract_not_allowed",
            "The requested contract is not exposed by this gateway",
        ));
    }
    if !claims.permissions.iter().any(|value| value == "write")
        || !claims
            .contracts
            .iter()
            .any(|value| value == contract_key || value == "*")
    {
        return Err(ApiError::new(
            StatusCode::FORBIDDEN,
            "insufficient_scope",
            "The token cannot write this contract",
        ));
    }
    Ok(())
}

fn enforce_rate_limits(state: &GatewayState, subject: &str, ip: IpAddr) -> Result<(), ApiError> {
    let mut rates = state.rates.lock().map_err(|_| {
        ApiError::new(
            StatusCode::INTERNAL_SERVER_ERROR,
            "rate_store_failed",
            "Gateway rate store is unavailable",
        )
    })?;
    let now = Instant::now();
    if !take_token(
        &mut rates,
        &format!("subject:{subject}"),
        state.config.subject_rate,
        state.config.subject_burst,
        now,
    ) || !take_token(
        &mut rates,
        &format!("ip:{ip}"),
        state.config.ip_rate,
        state.config.ip_burst,
        now,
    ) {
        return Err(ApiError::new(
            StatusCode::TOO_MANY_REQUESTS,
            "rate_limited",
            "Gateway request rate exceeded",
        ));
    }
    Ok(())
}

fn take_token(
    rates: &mut HashMap<String, TokenBucket>,
    key: &str,
    rate: f64,
    burst: f64,
    now: Instant,
) -> bool {
    let bucket = rates.entry(key.to_owned()).or_insert(TokenBucket {
        tokens: burst,
        updated_at: now,
    });
    bucket.tokens =
        (bucket.tokens + now.duration_since(bucket.updated_at).as_secs_f64() * rate).min(burst);
    bucket.updated_at = now;
    if bucket.tokens < 1.0 {
        return false;
    }
    bucket.tokens -= 1.0;
    true
}

fn validate_update(headers: &HeaderMap, update: &UpdateRequest) -> Result<Vec<u8>, ApiError> {
    if update.operation_id.len() != 26
        || !update
            .operation_id
            .bytes()
            .all(|byte| byte.is_ascii_uppercase() || byte.is_ascii_digit())
    {
        return Err(ApiError::new(
            StatusCode::BAD_REQUEST,
            "invalid_operation_id",
            "operation_id must be an uppercase ULID",
        ));
    }
    let idempotency = headers
        .get(IDEMPOTENCY_HEADER)
        .and_then(|value| value.to_str().ok());
    if idempotency != Some(update.operation_id.as_str()) {
        return Err(ApiError::new(
            StatusCode::BAD_REQUEST,
            "invalid_idempotency_key",
            "Idempotency-Key must equal operation_id",
        ));
    }
    if update.contract_type != "message-segment" || update.encoding != "cbor" {
        return Err(ApiError::new(
            StatusCode::UNSUPPORTED_MEDIA_TYPE,
            "unsupported_contract_encoding",
            "Only CBOR message-segment updates are accepted",
        ));
    }
    let payload = URL_SAFE_NO_PAD.decode(&update.payload).map_err(|_| {
        ApiError::new(
            StatusCode::BAD_REQUEST,
            "invalid_payload",
            "payload must be unpadded base64url",
        )
    })?;
    if payload.is_empty() || payload.len() > MAX_UPDATE_BYTES {
        return Err(ApiError::new(
            StatusCode::PAYLOAD_TOO_LARGE,
            "payload_too_large",
            "Decoded update must contain 1 to 32768 bytes",
        ));
    }
    let actual_hash = hex::encode(Sha256::digest(&payload));
    if actual_hash != update.payload_hash {
        return Err(ApiError::new(
            StatusCode::UNPROCESSABLE_ENTITY,
            "payload_hash_mismatch",
            "payload_hash does not match the decoded payload",
        ));
    }
    Ok(payload)
}

async fn begin_idempotent_request(
    state: &GatewayState,
    operation_id: &str,
    payload_hash: &str,
) -> Result<Option<UpdateResponse>, ApiError> {
    let mut entries = state.idempotency.lock().await;
    let oldest = unix_time().saturating_sub(IDEMPOTENCY_TTL.as_secs());
    entries.retain(|_, entry| entry.created_at >= oldest);
    if let Some(entry) = entries.get(operation_id) {
        if entry.payload_hash != payload_hash {
            return Err(ApiError::new(
                StatusCode::CONFLICT,
                "idempotency_conflict",
                "operation_id was already used with different bytes",
            ));
        }
        if let Some(mut response) = entry.response.clone() {
            response.replayed = true;
            response.request_id = request_id();
            response.server_time = unix_time();
            return Ok(Some(response));
        }
        return Err(ApiError::new(
            StatusCode::TOO_EARLY,
            "operation_in_progress",
            "An identical update is already in progress",
        ));
    }
    if entries.len() >= IDEMPOTENCY_CAPACITY {
        return Err(ApiError::new(
            StatusCode::SERVICE_UNAVAILABLE,
            "idempotency_capacity",
            "Gateway idempotency capacity is exhausted",
        ));
    }
    entries.insert(
        operation_id.to_owned(),
        IdempotencyEntry {
            payload_hash: payload_hash.to_owned(),
            created_at: unix_time(),
            response: None,
        },
    );
    Ok(None)
}

async fn complete_idempotent_request(
    state: &GatewayState,
    operation_id: &str,
    response: UpdateResponse,
) -> Result<(), ApiError> {
    let persisted = {
        let mut entries = state.idempotency.lock().await;
        let entry = entries.get_mut(operation_id).ok_or_else(|| {
            ApiError::new(
                StatusCode::INTERNAL_SERVER_ERROR,
                "idempotency_entry_lost",
                "Gateway lost the pending idempotency entry",
            )
        })?;
        entry.response = Some(response);
        entries
            .iter()
            .filter_map(|(operation_id, entry)| {
                entry
                    .response
                    .clone()
                    .map(|response| PersistedIdempotencyEntry {
                        operation_id: operation_id.clone(),
                        payload_hash: entry.payload_hash.clone(),
                        created_at: entry.created_at,
                        response,
                    })
            })
            .collect::<Vec<_>>()
    };
    persist_idempotency(&state.config.idempotency_path, &persisted)
        .await
        .map_err(|message| {
            ApiError::new(
                StatusCode::INTERNAL_SERVER_ERROR,
                "idempotency_persistence_failed",
                message,
            )
        })
}

async fn forget_idempotent_request(state: &GatewayState, operation_id: &str) {
    state.idempotency.lock().await.remove(operation_id);
}

async fn load_idempotency(path: &FilePath) -> Result<HashMap<String, IdempotencyEntry>, String> {
    let bytes = match tokio::fs::read(path).await {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(HashMap::new()),
        Err(error) => return Err(format!("Could not read the idempotency journal: {error}")),
    };
    let persisted: Vec<PersistedIdempotencyEntry> = serde_json::from_slice(&bytes)
        .map_err(|error| format!("Idempotency journal is malformed: {error}"))?;
    let oldest = unix_time().saturating_sub(IDEMPOTENCY_TTL.as_secs());
    Ok(persisted
        .into_iter()
        .filter(|entry| entry.created_at >= oldest)
        .map(|entry| {
            (
                entry.operation_id,
                IdempotencyEntry {
                    payload_hash: entry.payload_hash,
                    created_at: entry.created_at,
                    response: Some(entry.response),
                },
            )
        })
        .collect())
}

async fn persist_idempotency(
    path: &FilePath,
    entries: &[PersistedIdempotencyEntry],
) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| "Idempotency journal path has no parent".to_owned())?;
    tokio::fs::create_dir_all(parent)
        .await
        .map_err(|error| format!("Could not create the idempotency journal directory: {error}"))?;
    let bytes = serde_json::to_vec(entries)
        .map_err(|error| format!("Could not encode the idempotency journal: {error}"))?;
    let staging = path.with_extension("json.staging");
    let backup = path.with_extension("json.backup");
    tokio::fs::write(&staging, bytes)
        .await
        .map_err(|error| format!("Could not stage the idempotency journal: {error}"))?;
    if backup.exists() {
        tokio::fs::remove_file(&backup)
            .await
            .map_err(|error| format!("Could not clear the idempotency backup: {error}"))?;
    }
    if path.exists() {
        tokio::fs::rename(path, &backup)
            .await
            .map_err(|error| format!("Could not back up the idempotency journal: {error}"))?;
    }
    if let Err(error) = tokio::fs::rename(&staging, path).await {
        if backup.exists() {
            let _ = tokio::fs::rename(&backup, path).await;
        }
        return Err(format!(
            "Could not activate the idempotency journal: {error}"
        ));
    }
    if backup.exists() {
        tokio::fs::remove_file(&backup)
            .await
            .map_err(|error| format!("Could not clear the idempotency backup: {error}"))?;
    }
    Ok(())
}

async fn forward_update(
    state: &GatewayState,
    contract_key: &str,
    headers: &HeaderMap,
    update: &UpdateRequest,
    _validated_payload: Vec<u8>,
) -> Result<(), ApiError> {
    let response = timeout(
        UPSTREAM_TIMEOUT,
        state
            .client
            .post(format!(
                "{}/contracts/{contract_key}/updates",
                state.config.upstream_url
            ))
            .bearer_auth(state.config.upstream_token.as_ref())
            .header(
                IDEMPOTENCY_HEADER,
                headers
                    .get(IDEMPOTENCY_HEADER)
                    .expect("validated idempotency header"),
            )
            .json(update)
            .send(),
    )
    .await
    .map_err(|_| {
        ApiError::new(
            StatusCode::GATEWAY_TIMEOUT,
            "upstream_timeout",
            "Freenet upstream timed out",
        )
    })?
    .map_err(|_| {
        ApiError::new(
            StatusCode::BAD_GATEWAY,
            "upstream_unavailable",
            "Freenet upstream is unavailable",
        )
    })?;
    if !response.status().is_success() {
        return Err(ApiError::new(
            StatusCode::BAD_GATEWAY,
            "upstream_rejected",
            format!("Freenet upstream returned {}", response.status()),
        ));
    }
    Ok(())
}

fn router(state: Arc<GatewayState>) -> Router {
    let origins = state.config.allowed_origins.clone();
    Router::new()
        .route("/nexus/v1/health", get(health))
        .route("/nexus/v1/contracts/{key}/updates", post(submit_update))
        .route("/nexus/v1/turn-credentials", post(issue_turn_credential))
        .route(
            "/nexus/v1/meeting-host-sessions",
            post(issue_meeting_host_session),
        )
        .route("/nexus/v1/meeting-invites", post(issue_meeting_invite))
        .route("/nexus/v1/meetings/{room_id}", get(meeting_websocket))
        .layer(SetResponseHeaderLayer::overriding(
            HeaderName::from_static("x-content-type-options"),
            HeaderValue::from_static("nosniff"),
        ))
        .layer(SetResponseHeaderLayer::overriding(
            HeaderName::from_static("referrer-policy"),
            HeaderValue::from_static("no-referrer"),
        ))
        .layer(
            CorsLayer::new()
                .allow_origin(AllowOrigin::list(origins))
                .allow_methods([Method::GET, Method::POST])
                .allow_headers([
                    AUTHORIZATION,
                    CONTENT_TYPE,
                    HeaderName::from_static(IDEMPOTENCY_HEADER),
                ]),
        )
        .layer(RequestBodyLimitLayer::new(64 * 1024))
        .layer(TraceLayer::new_for_http())
        .with_state(state)
}

fn request_id() -> String {
    let mut bytes = [0_u8; 16];
    rand::thread_rng().fill_bytes(&mut bytes);
    hex::encode(bytes)
}

fn unix_time() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")),
        )
        .init();

    let config = GatewayConfig::from_env().expect("invalid Nexus Gateway configuration");
    let address = config.bind;
    let idempotency = load_idempotency(&config.idempotency_path)
        .await
        .expect("failed to load the gateway idempotency journal");
    let state = Arc::new(GatewayState {
        config,
        client: reqwest::Client::builder()
            .timeout(UPSTREAM_TIMEOUT)
            .build()
            .expect("failed to create the gateway upstream client"),
        rates: StdMutex::new(HashMap::new()),
        idempotency: Mutex::new(idempotency),
        meeting_rooms: Mutex::new(HashMap::new()),
        upstream_slots: Semaphore::new(32),
    });
    let listener = tokio::net::TcpListener::bind(address)
        .await
        .expect("failed to bind Nexus Gateway");
    tracing::info!(%address, "Nexus Gateway listening");
    axum::serve(
        listener,
        router(state).into_make_service_with_connect_info::<SocketAddr>(),
    )
    .with_graceful_shutdown(shutdown_signal())
    .await
    .expect("Nexus Gateway server failed");
}

async fn shutdown_signal() {
    let _ = tokio::signal::ctrl_c().await;
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    const SECRET: &[u8] = b"0123456789abcdef0123456789abcdef";

    fn access_token(claims: &AccessClaims) -> String {
        let payload = URL_SAFE_NO_PAD.encode(serde_json::to_vec(claims).unwrap());
        let signed = format!("v1.{payload}");
        let mut mac = HmacSha256::new_from_slice(SECRET).unwrap();
        mac.update(signed.as_bytes());
        format!(
            "{signed}.{}",
            URL_SAFE_NO_PAD.encode(mac.finalize().into_bytes())
        )
    }

    #[test]
    fn access_tokens_are_authenticated_and_expire() {
        let claims = AccessClaims {
            sub: "identity-1".into(),
            exp: unix_time() + 60,
            permissions: vec!["write".into()],
            contracts: vec!["contract-1".into()],
        };
        let token = access_token(&claims);
        assert_eq!(
            verify_access_token(&token, SECRET).unwrap().sub,
            "identity-1"
        );
        assert!(verify_access_token(&format!("{token}x"), SECRET).is_err());

        let expired = access_token(&AccessClaims {
            exp: unix_time().saturating_sub(1),
            ..claims
        });
        assert!(verify_access_token(&expired, SECRET).is_err());
    }

    #[test]
    fn meeting_invites_are_gateway_signed_and_room_bound() {
        validate_meeting_room("01MEETINGROOM", "Café planning").unwrap();
        assert!(validate_meeting_room("short", "Café planning").is_err());
        assert!(validate_meeting_room("01MEETINGROOM", "\n").is_err());

        let claims = AccessClaims {
            sub: "meeting:01MEETINGROOM:random".into(),
            exp: unix_time() + 300,
            permissions: vec!["meeting".into(), "turn".into()],
            contracts: Vec::new(),
        };
        let token = sign_access_token(&claims, SECRET).unwrap();
        let decoded = verify_access_token(&token, SECRET).unwrap();
        assert_eq!(decoded.sub, claims.sub);
        assert!(decoded.permissions.iter().any(|scope| scope == "meeting"));
        assert!(decoded.permissions.iter().any(|scope| scope == "turn"));
        assert!(meeting_claims_allow_room(&decoded, "01MEETINGROOM"));
        assert!(!meeting_claims_allow_room(&decoded, "01OTHERMEETING"));
        assert!(valid_participant_id("01PARTICIPANT"));
        assert!(!valid_participant_id("bad id"));
        assert!(valid_meeting_ciphertext("abcdefghijklmnop"));
        assert!(!valid_meeting_ciphertext("not+base64url!!!!"));
    }

    #[test]
    fn meeting_host_secret_comparison_is_exact() {
        let expected = b"host-passphrase-that-is-long-enough-123";
        assert!(meeting_host_secret_matches(expected, expected));
        assert!(!meeting_host_secret_matches(
            expected,
            b"host-passphrase-that-is-long-enough-124"
        ));
        assert!(!meeting_host_secret_matches(expected, b"short"));
    }

    #[test]
    fn turn_credentials_are_short_lived_and_bound_to_the_subject() {
        let config = TurnConfig {
            secret: Arc::from(&b"0123456789abcdef0123456789abcdef"[..]),
            urls: Arc::from(vec![
                "turn:relay.example:3478?transport=udp".to_owned(),
                "turns:relay.example:5349?transport=tcp".to_owned(),
            ]),
            ttl_seconds: 300,
        };
        let response = mint_turn_credential(&config, "identity-1", 1_800_000_000).unwrap();
        assert_eq!(response.username, "1800000300:identity-1");
        assert_eq!(response.expires_at, 1_800_000_300_000);
        let mut mac = HmacSha1::new_from_slice(&config.secret).unwrap();
        mac.update(response.username.as_bytes());
        assert_eq!(
            response.credential,
            STANDARD.encode(mac.finalize().into_bytes())
        );
    }

    #[test]
    fn update_validation_binds_idempotency_and_payload_hash() {
        let payload = b"signed cbor fixture";
        let operation_id = "01K10KJ6P20S58KQBV5P4E3T9Z";
        let update = UpdateRequest {
            operation_id: operation_id.into(),
            contract_type: "message-segment".into(),
            encoding: "cbor".into(),
            payload: URL_SAFE_NO_PAD.encode(payload),
            payload_hash: hex::encode(Sha256::digest(payload)),
        };
        let mut headers = HeaderMap::new();
        headers.insert(
            HeaderName::from_static(IDEMPOTENCY_HEADER),
            HeaderValue::from_static(operation_id),
        );
        assert_eq!(validate_update(&headers, &update).unwrap(), payload);

        let mut changed = update;
        changed.payload_hash = "00".repeat(32);
        assert_eq!(
            validate_update(&headers, &changed).unwrap_err().status,
            StatusCode::UNPROCESSABLE_ENTITY
        );
    }

    #[test]
    fn token_bucket_enforces_burst_and_refills() {
        let mut rates = HashMap::new();
        let start = Instant::now();
        assert!(take_token(&mut rates, "subject", 2.0, 2.0, start));
        assert!(take_token(&mut rates, "subject", 2.0, 2.0, start));
        assert!(!take_token(&mut rates, "subject", 2.0, 2.0, start));
        assert!(take_token(
            &mut rates,
            "subject",
            2.0,
            2.0,
            start + Duration::from_millis(500)
        ));
    }

    #[test]
    fn upstream_plaintext_is_limited_to_loopback() {
        assert!(validate_upstream_url("http://127.0.0.1:9000").is_ok());
        assert!(validate_upstream_url("http://localhost:9000").is_ok());
        assert!(validate_upstream_url("https://core.example").is_ok());
        assert!(validate_upstream_url("http://core.example").is_err());
    }

    #[tokio::test]
    async fn completed_idempotency_receipts_survive_a_restart() {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system clock should be valid")
            .as_nanos();
        let directory = std::env::temp_dir().join(format!("nexus-gateway-journal-{unique}"));
        let path = directory.join("idempotency.json");
        let response = UpdateResponse {
            request_id: request_id(),
            gateway_id: "test-gateway".into(),
            server_time: unix_time(),
            operation_id: "01K10KJ6P20S58KQBV5P4E3T9Z".into(),
            state: "accepted".into(),
            payload_hash: "ab".repeat(32),
            replayed: false,
        };
        persist_idempotency(
            &path,
            &[PersistedIdempotencyEntry {
                operation_id: response.operation_id.clone(),
                payload_hash: response.payload_hash.clone(),
                created_at: unix_time(),
                response: response.clone(),
            }],
        )
        .await
        .expect("journal write should succeed");
        let restored = load_idempotency(&path)
            .await
            .expect("journal read should succeed");
        assert_eq!(
            restored
                .get(&response.operation_id)
                .and_then(|entry| entry.response.as_ref())
                .map(|entry| entry.payload_hash.as_str()),
            Some(response.payload_hash.as_str())
        );
        tokio::fs::remove_file(&path)
            .await
            .expect("journal cleanup should succeed");
        tokio::fs::remove_dir(&directory)
            .await
            .expect("journal directory cleanup should succeed");
    }
}
