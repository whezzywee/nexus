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
use nexus_protocol::{
    ConversationDevice, ConversationState, EncryptedEnvelope, EpochRotationOperation,
    PROTOCOL_VERSION, SealedEpochKey, canonical_epoch_rotation_bytes,
};
use sha2::{Digest, Sha256};
use tokio::time::{sleep, timeout};
use tokio_tungstenite::connect_async;

mod support;

const CONVERSATION_ID: &str = "01K10KJ6P20S58KQBV5P4E3T9D";
const CREATOR_DEVICE: &str = "two-node-creator-device";
const MEMBER_DEVICE: &str = "two-node-member-device";

fn identity_id(key: &SigningKey) -> String {
    hex::encode(Sha256::digest(key.verifying_key().to_bytes()))
}

fn encryption_key(byte: u8) -> String {
    URL_SAFE_NO_PAD.encode([byte; 32])
}

fn device(identity_id: String, device_id: &str, byte: u8) -> ConversationDevice {
    ConversationDevice {
        identity_id,
        device_id: device_id.into(),
        encryption_public_key: encryption_key(byte),
    }
}

fn sealed(device_id: &str, epoch: u64, byte: u8) -> SealedEpochKey {
    SealedEpochKey {
        suite: "X25519-HKDF-SHA-256+AES-256-GCM".into(),
        conversation_id: CONVERSATION_ID.into(),
        epoch,
        recipient_device_id: device_id.into(),
        ephemeral_public_key: URL_SAFE_NO_PAD.encode([byte; 32]),
        salt: URL_SAFE_NO_PAD.encode([byte.wrapping_add(1); 32]),
        envelope: EncryptedEnvelope {
            suite: "AES-256-GCM".into(),
            nonce: URL_SAFE_NO_PAD.encode([byte.wrapping_add(2); 12]),
            ciphertext: URL_SAFE_NO_PAD.encode([byte.wrapping_add(3); 48]),
        },
    }
}

fn signed_rotation(
    creator: &SigningKey,
    sequence: u64,
    epoch: u64,
    operation_id: &str,
    devices: Vec<ConversationDevice>,
) -> EpochRotationOperation {
    let public_key = creator.verifying_key().to_bytes();
    let mut operation = EpochRotationOperation {
        protocol_version: PROTOCOL_VERSION,
        operation_id: operation_id.into(),
        conversation_id: CONVERSATION_ID.into(),
        actor_id: identity_id(creator),
        actor_device_id: CREATOR_DEVICE.into(),
        actor_sequence: sequence,
        epoch,
        sealed_keys: devices
            .iter()
            .enumerate()
            .map(|(index, device)| sealed(&device.device_id, epoch, index as u8 + 11))
            .collect(),
        devices,
        created_at: "2026-07-26T12:00:00.000Z".into(),
        public_key: URL_SAFE_NO_PAD.encode(public_key),
        device_certificate: support::device_certificate_with_encryption(
            creator,
            CREATOR_DEVICE,
            encryption_key(1),
        ),
        signature: String::new(),
    };
    operation.signature = URL_SAFE_NO_PAD.encode(
        creator
            .sign(&canonical_epoch_rotation_bytes(&operation))
            .to_bytes(),
    );
    operation
}

async fn connect(url: String) -> Result<WebApi> {
    let (stream, _) = connect_async(format!("{url}?encodingProtocol=native")).await?;
    Ok(WebApi::start(stream))
}

async fn receive_put(client: &mut WebApi) -> Result<()> {
    loop {
        match timeout(Duration::from_secs(60), client.recv()).await?? {
            HostResponse::ContractResponse(ContractResponse::PutResponse { .. }) => return Ok(()),
            HostResponse::ContractResponse(ContractResponse::NotFound { .. }) => {
                bail!("private-conversation PUT unexpectedly returned not found")
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

async fn receive_notification(client: &mut WebApi) -> Result<()> {
    loop {
        if let HostResponse::ContractResponse(ContractResponse::UpdateNotification { .. }) =
            timeout(Duration::from_secs(60), client.recv())
                .await
                .context("timed out waiting for the private-conversation update notification")??
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
    bail!("private-conversation state did not propagate to the second Freenet node")
}

async fn wait_for_epoch(
    client: &mut WebApi,
    key: freenet_stdlib::prelude::ContractKey,
    epoch: u64,
) -> Result<ConversationState> {
    for _ in 0..60 {
        let state: ConversationState =
            serde_json::from_slice(get_state(client, key, false).await?.as_ref())?;
        if state.epoch == epoch {
            return Ok(state);
        }
        sleep(Duration::from_secs(1)).await;
    }
    bail!("peer B did not recover private-conversation epoch {epoch}")
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "requires a pinned Freenet Core binary and compiled private-conversation Wasm"]
async fn key_rotation_and_device_removal_round_trip_across_two_real_nodes() -> Result<()> {
    let binary = PathBuf::from(
        env::var_os("NEXUS_FREENET_BIN")
            .context("set NEXUS_FREENET_BIN to the pinned Freenet Core executable")?,
    );
    let wasm = PathBuf::from(
        env::var_os("NEXUS_PRIVATE_CONVERSATION_CONTRACT_WASM").context(
            "set NEXUS_PRIVATE_CONVERSATION_CONTRACT_WASM to the private conversation Wasm",
        )?,
    );
    ensure!(binary.is_file(), "Freenet binary does not exist");
    ensure!(
        wasm.is_file(),
        "Nexus private-conversation contract Wasm does not exist"
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
        .context("start two-node Freenet network")?;
    eprintln!("two-node private-conversation network ready");

    let mut peer_a = connect(network.peer(0).ws_url()).await?;
    let mut peer_b = connect(network.gateway(0).ws_url()).await?;
    let creator = SigningKey::from_bytes(&[51_u8; 32]);
    let member = SigningKey::from_bytes(&[52_u8; 32]);
    let creator_id = identity_id(&creator);
    let initial = ConversationState::new(
        CONVERSATION_ID.into(),
        creator_id.clone(),
        CREATOR_DEVICE.into(),
        encryption_key(1),
    );
    let contract = ContractContainer::Wasm(ContractWasmAPIVersion::V1(WrappedContract::new(
        Arc::new(ContractCode::from(fs::read(wasm)?)),
        Parameters::from(Vec::<u8>::new()),
    )));
    let key = contract.key();

    peer_a
        .send(ClientRequest::ContractOp(ContractRequest::Put {
            contract,
            state: WrappedState::from(serde_json::to_vec(&initial)?),
            related_contracts: RelatedContracts::default(),
            subscribe: false,
            blocking_subscribe: false,
        }))
        .await?;
    receive_put(&mut peer_a).await?;
    let before: ConversationState =
        serde_json::from_slice(get_state(&mut peer_b, key, true).await?.as_ref())?;
    ensure!(before.epoch == 0 && before.devices.len() == 1);
    eprintln!("private-conversation contract published and subscribed");

    let epoch_one = signed_rotation(
        &creator,
        1,
        1,
        "01K10KJ6P20S58KQBV5P4E3TC1",
        vec![
            device(creator_id.clone(), CREATOR_DEVICE, 1),
            device(identity_id(&member), MEMBER_DEVICE, 2),
        ],
    );
    peer_a
        .send(ClientRequest::ContractOp(ContractRequest::Update {
            key,
            data: UpdateData::Delta(StateDelta::from(serde_json::to_vec(&epoch_one)?)),
        }))
        .await?;
    receive_update(&mut peer_a).await?;
    receive_notification(&mut peer_b).await?;
    let joined = wait_for_epoch(&mut peer_b, key, 1).await?;
    ensure!(
        joined.devices.contains_key(MEMBER_DEVICE)
            && joined.sealed_keys.contains_key(MEMBER_DEVICE)
    );
    eprintln!("peer B received epoch 1 with independently sealed device keys");

    let epoch_two = signed_rotation(
        &creator,
        2,
        2,
        "01K10KJ6P20S58KQBV5P4E3TC2",
        vec![device(creator_id, CREATOR_DEVICE, 1)],
    );
    peer_a
        .send(ClientRequest::ContractOp(ContractRequest::Update {
            key,
            data: UpdateData::Delta(StateDelta::from(serde_json::to_vec(&epoch_two)?)),
        }))
        .await?;
    receive_update(&mut peer_a).await?;
    // A notification is only a wake-up hint and may be coalesced. The first
    // rotation verifies the subscription; consume the second hint when present
    // and always verify the durable state.
    if !matches!(
        timeout(Duration::from_secs(10), receive_notification(&mut peer_b)).await,
        Ok(Ok(()))
    ) {
        eprintln!("epoch-two hint was coalesced; verifying state directly");
    }
    let revoked = wait_for_epoch(&mut peer_b, key, 2).await?;
    ensure!(
        !revoked.devices.contains_key(MEMBER_DEVICE)
            && !revoked.sealed_keys.contains_key(MEMBER_DEVICE)
            && revoked.sealed_keys.contains_key(CREATOR_DEVICE)
    );
    eprintln!("peer B received epoch 2 with removed device key access revoked");

    peer_a
        .disconnect("Nexus private conversation test complete")
        .await;
    peer_b
        .disconnect("Nexus private conversation test complete")
        .await;
    Ok(())
}
