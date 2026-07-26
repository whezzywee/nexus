use std::{env, fs, path::PathBuf, sync::Arc, time::Duration};

use anyhow::{Context, Result, bail, ensure};
use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use ed25519_dalek::{Signer, SigningKey};
use freenet_stdlib::{
    client_api::{ClientRequest, ContractRequest, ContractResponse, HostResponse, WebApi},
    prelude::{
        ContractCode, ContractContainer, ContractWasmAPIVersion, Parameters, RelatedContracts,
        StateDelta, UpdateData, WrappedContract, WrappedState,
    },
};
use freenet_test_network::{FreenetBinary, TestNetwork};
use nexus_protocol::{MessageOperation, PROTOCOL_VERSION, SegmentState, canonical_message_bytes};
use sha2::{Digest, Sha256};
use tokio::time::{sleep, timeout};
use tokio_tungstenite::connect_async;

mod support;

const CHANNEL_ID: &str = "01K10KJ6P20S58KQBV5P4E3T9Z";
const MESSAGE_ID: &str = "01K10KJ6P20S58KQBV5P4E3TA0";
const OPERATION_ID: &str = "01K10KJ6P20S58KQBV5P4E3TA1";

fn signed_message() -> MessageOperation {
    let signing_key = SigningKey::from_bytes(&[7_u8; 32]);
    let public_key = signing_key.verifying_key().to_bytes();
    let mut operation = MessageOperation {
        protocol_version: PROTOCOL_VERSION,
        operation_id: OPERATION_ID.into(),
        message_id: MESSAGE_ID.into(),
        channel_id: CHANNEL_ID.into(),
        author_id: hex::encode(Sha256::digest(public_key)),
        author_device_id: "two-node-integration-device".into(),
        actor_sequence: 1,
        created_at: "2026-07-26T00:00:00.000Z".into(),
        client_generated_order: OPERATION_ID.into(),
        content: "hello through two Freenet nodes".into(),
        reply_to: None,
        attachment_references: Vec::new(),
        encryption_metadata: None,
        edit_version: 0,
        deletion_tombstone: false,
        public_key: URL_SAFE_NO_PAD.encode(public_key),
        device_certificate: support::device_certificate(
            &signing_key,
            "two-node-integration-device",
        ),
        signature: String::new(),
    };
    operation.signature = URL_SAFE_NO_PAD.encode(
        signing_key
            .sign(&canonical_message_bytes(&operation))
            .to_bytes(),
    );
    operation
}

async fn connect(url: String) -> Result<WebApi> {
    let url = format!("{url}?encodingProtocol=native");
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
                bail!("contract PUT unexpectedly returned not found")
            }
            _ => {}
        }
    }
}

async fn receive_update(client: &mut WebApi) -> Result<()> {
    loop {
        if let HostResponse::ContractResponse(ContractResponse::UpdateResponse { .. }) =
            timeout(Duration::from_secs(60), client.recv()).await??
        {
            return Ok(());
        }
    }
}

async fn receive_rejected_signature_update(client: &mut WebApi) -> Result<()> {
    loop {
        match timeout(Duration::from_secs(60), client.recv())
            .await
            .context("timed out waiting for the tampered update rejection")?
        {
            Ok(HostResponse::ContractResponse(ContractResponse::UpdateResponse { .. })) => {
                bail!("Core accepted a message whose signed content was modified")
            }
            Ok(_) => {}
            Err(error) => {
                ensure!(
                    error.to_string().contains("invalid message signature"),
                    "Core rejected the tampered update for an unexpected reason: {error}"
                );
                return Ok(());
            }
        }
    }
}

async fn receive_notification(client: &mut WebApi) -> Result<()> {
    loop {
        if let HostResponse::ContractResponse(ContractResponse::UpdateNotification { .. }) =
            timeout(Duration::from_secs(60), client.recv())
                .await
                .context("timed out waiting for peer B's update notification")??
        {
            return Ok(());
        }
    }
}

async fn get_state(
    client: &mut WebApi,
    key: freenet_stdlib::prelude::ContractKey,
    subscribe: bool,
) -> Result<WrappedState> {
    for attempt in 1..=6 {
        client
            .send(ClientRequest::ContractOp(ContractRequest::Get {
                key: *key.id(),
                return_contract_code: false,
                subscribe,
                blocking_subscribe: subscribe,
            }))
            .await?;

        loop {
            match timeout(Duration::from_secs(20), client.recv()).await {
                Ok(Ok(HostResponse::ContractResponse(ContractResponse::GetResponse {
                    state,
                    ..
                }))) => return Ok(state),
                Ok(Ok(HostResponse::ContractResponse(ContractResponse::NotFound { .. }))) => break,
                Ok(Ok(_)) => {}
                Ok(Err(error)) => return Err(error.into()),
                Err(_) => break,
            }
        }

        if attempt < 6 {
            sleep(Duration::from_secs(2)).await;
        }
    }
    bail!("contract state did not propagate to the second Freenet node")
}

async fn wait_for_message(
    client: &mut WebApi,
    key: freenet_stdlib::prelude::ContractKey,
) -> Result<SegmentState> {
    for _ in 0..10 {
        let state = get_state(client, key, false).await?;
        let decoded: SegmentState = serde_json::from_slice(state.as_ref())?;
        if decoded.messages.contains_key(MESSAGE_ID) {
            return Ok(decoded);
        }
        sleep(Duration::from_secs(1)).await;
    }
    bail!("peer B did not recover the signed message accepted by peer A")
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "requires a pinned Freenet Core binary and compiled Nexus contract Wasm"]
async fn signed_message_round_trips_across_two_real_nodes() -> Result<()> {
    let binary = PathBuf::from(
        env::var_os("NEXUS_FREENET_BIN")
            .context("set NEXUS_FREENET_BIN to the pinned Freenet Core executable")?,
    );
    let wasm = PathBuf::from(
        env::var_os("NEXUS_CONTRACT_WASM")
            .context("set NEXUS_CONTRACT_WASM to the message-segment Wasm artifact")?,
    );
    ensure!(binary.is_file(), "Freenet binary does not exist");
    ensure!(wasm.is_file(), "Nexus contract Wasm does not exist");

    let network = TestNetwork::builder()
        .gateways(1)
        .peers(1)
        .min_connections(1)
        .max_connections(4)
        .binary(FreenetBinary::Path(binary))
        .connectivity_timeout(Duration::from_secs(60))
        .build()
        .await
        .context("start two-node Freenet network")?;
    eprintln!("two-node network ready");

    let peer_a_url = network.peer(0).ws_url();
    let peer_b_url = network.gateway(0).ws_url();
    let mut peer_a = connect(peer_a_url).await?;
    let mut peer_b = connect(peer_b_url).await?;

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
    eprintln!("contract published on peer A");

    // A blocking GET+subscribe is the Core wire protocol's deterministic way
    // to finish the complete downstream subscription path before the writer
    // sends an update.
    let state_before = get_state(&mut peer_b, key, true).await?;
    let decoded_before: SegmentState = serde_json::from_slice(state_before.as_ref())?;
    ensure!(decoded_before.messages.is_empty());
    eprintln!("initial contract retrieved and subscribed from peer B");

    let operation = signed_message();
    let mut tampered = operation.clone();
    tampered.content = "tampered after signing".into();
    peer_a
        .send(ClientRequest::ContractOp(ContractRequest::Update {
            key,
            data: UpdateData::Delta(StateDelta::from(serde_json::to_vec(&tampered)?)),
        }))
        .await?;
    receive_rejected_signature_update(&mut peer_a).await?;
    let state_after_tamper = get_state(&mut peer_a, key, false).await?;
    let decoded_after_tamper: SegmentState = serde_json::from_slice(state_after_tamper.as_ref())?;
    ensure!(
        decoded_after_tamper.messages.is_empty(),
        "peer A accepted a message whose signed content was modified"
    );
    eprintln!("tampered signed delta was rejected without changing authoritative state");

    peer_a
        .send(ClientRequest::ContractOp(ContractRequest::Update {
            key,
            data: UpdateData::Delta(StateDelta::from(serde_json::to_vec(&operation)?)),
        }))
        .await?;
    receive_update(&mut peer_a).await?;
    eprintln!("signed delta accepted by peer A");
    receive_notification(&mut peer_b).await?;
    eprintln!("peer B received update notification");

    let decoded_after = wait_for_message(&mut peer_b, key).await?;
    ensure!(
        decoded_after
            .messages
            .get(MESSAGE_ID)
            .is_some_and(|message| message.content == operation.content),
        "peer B did not receive the signed message accepted by peer A"
    );

    peer_a.disconnect("Nexus two-node test complete").await;
    peer_b.disconnect("Nexus two-node test complete").await;
    Ok(())
}
