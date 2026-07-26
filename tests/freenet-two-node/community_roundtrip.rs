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
    CommunityRole, CommunityState, MembershipAction, MembershipOperation, PROTOCOL_VERSION,
    canonical_membership_bytes,
};
use sha2::{Digest, Sha256};
use tokio::time::{sleep, timeout};
use tokio_tungstenite::connect_async;

mod support;

const COMMUNITY_ID: &str = "01K10KJ6P20S58KQBV5P4E3T9C";
const OWNER_DEVICE: &str = "two-node-owner-device";
const LINKED_DEVICE: &str = "two-node-linked-device";

fn identity_id(key: &SigningKey) -> String {
    hex::encode(Sha256::digest(key.verifying_key().to_bytes()))
}

#[allow(clippy::too_many_arguments)]
fn signed_membership_operation(
    signing_key: &SigningKey,
    sequence: u64,
    target_identity_id: String,
    target_device_ids: Vec<String>,
    action: MembershipAction,
    role: Option<CommunityRole>,
    epoch: u64,
    operation_id: &str,
) -> MembershipOperation {
    let public_key = signing_key.verifying_key().to_bytes();
    let mut operation = MembershipOperation {
        protocol_version: PROTOCOL_VERSION,
        operation_id: operation_id.into(),
        community_id: COMMUNITY_ID.into(),
        actor_id: identity_id(signing_key),
        actor_device_id: OWNER_DEVICE.into(),
        actor_sequence: sequence,
        target_identity_id,
        target_device_ids,
        action,
        role,
        epoch,
        created_at: "2026-07-26T12:00:00.000Z".into(),
        public_key: URL_SAFE_NO_PAD.encode(public_key),
        device_certificate: support::device_certificate(signing_key, OWNER_DEVICE),
        signature: String::new(),
    };
    operation.signature = URL_SAFE_NO_PAD.encode(
        signing_key
            .sign(&canonical_membership_bytes(&operation))
            .to_bytes(),
    );
    operation
}

async fn connect(url: String) -> Result<WebApi> {
    let (stream, _) = connect_async(format!("{url}?encodingProtocol=native"))
        .await
        .with_context(|| format!("connect to {url}"))?;
    Ok(WebApi::start(stream))
}

async fn receive_put(client: &mut WebApi) -> Result<()> {
    loop {
        match timeout(Duration::from_secs(60), client.recv()).await?? {
            HostResponse::ContractResponse(ContractResponse::PutResponse { .. }) => return Ok(()),
            HostResponse::ContractResponse(ContractResponse::NotFound { .. }) => {
                bail!("community contract PUT unexpectedly returned not found")
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

async fn receive_rejected_impersonation(client: &mut WebApi) -> Result<()> {
    loop {
        match timeout(Duration::from_secs(60), client.recv()).await {
            Ok(Ok(HostResponse::ContractResponse(ContractResponse::UpdateResponse { .. }))) => {
                bail!("Core accepted a revoked device impersonating its active sibling")
            }
            Ok(Ok(_)) => {}
            Ok(Err(error)) => {
                ensure!(
                    error.to_string().contains("invalid membership signature"),
                    "Core rejected sibling impersonation for an unexpected reason: {error}"
                );
                return Ok(());
            }
            Err(_) => bail!("timed out waiting for rejected sibling impersonation"),
        }
    }
}

async fn receive_notification(client: &mut WebApi) -> Result<()> {
    loop {
        if let HostResponse::ContractResponse(ContractResponse::UpdateNotification { .. }) =
            timeout(Duration::from_secs(60), client.recv())
                .await
                .context("timed out waiting for the community update notification")??
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
    bail!("community contract state did not propagate to the second Freenet node")
}

async fn wait_for_epoch(
    client: &mut WebApi,
    key: freenet_stdlib::prelude::ContractKey,
    epoch: u64,
) -> Result<CommunityState> {
    for _ in 0..60 {
        let state = get_state(client, key, false).await?;
        let decoded: CommunityState = serde_json::from_slice(state.as_ref())?;
        if decoded.epoch == epoch {
            return Ok(decoded);
        }
        sleep(Duration::from_secs(1)).await;
    }
    bail!("peer B did not recover community epoch {epoch}")
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "requires a pinned Freenet Core binary and compiled community contract Wasm"]
async fn membership_and_revocation_round_trip_across_two_real_nodes() -> Result<()> {
    let binary = PathBuf::from(
        env::var_os("NEXUS_FREENET_BIN")
            .context("set NEXUS_FREENET_BIN to the pinned Freenet Core executable")?,
    );
    let wasm = PathBuf::from(
        env::var_os("NEXUS_COMMUNITY_CONTRACT_WASM")
            .context("set NEXUS_COMMUNITY_CONTRACT_WASM to the community contract Wasm")?,
    );
    ensure!(binary.is_file(), "Freenet binary does not exist");
    ensure!(
        wasm.is_file(),
        "Nexus community contract Wasm does not exist"
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
    eprintln!("two-node community network ready");

    let mut peer_a = connect(network.peer(0).ws_url()).await?;
    let mut peer_b = connect(network.gateway(0).ws_url()).await?;
    let owner = SigningKey::from_bytes(&[31_u8; 32]);
    let initial = CommunityState::new(
        COMMUNITY_ID.into(),
        identity_id(&owner),
        vec![OWNER_DEVICE.into()],
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
    eprintln!("community contract published on peer A");

    let before: CommunityState =
        serde_json::from_slice(get_state(&mut peer_b, key, true).await?.as_ref())?;
    ensure!(before.epoch == 0 && before.members.len() == 1);

    let add = signed_membership_operation(
        &owner,
        1,
        identity_id(&owner),
        vec![OWNER_DEVICE.into(), LINKED_DEVICE.into()],
        MembershipAction::SetDevices,
        None,
        1,
        "01K10KJ6P20S58KQBV5P4E3TA1",
    );
    peer_a
        .send(ClientRequest::ContractOp(ContractRequest::Update {
            key,
            data: UpdateData::Delta(StateDelta::from(serde_json::to_vec(&add)?)),
        }))
        .await?;
    receive_update(&mut peer_a).await?;
    receive_notification(&mut peer_b).await?;
    let added = wait_for_epoch(&mut peer_b, key, 1).await?;
    ensure!(
        added
            .members
            .get(&identity_id(&owner))
            .is_some_and(|member| {
                member.active
                    && member.device_ids == [LINKED_DEVICE.to_string(), OWNER_DEVICE.to_string()]
            })
    );
    eprintln!("linked-device addition reached peer B at epoch 1");

    let remove = signed_membership_operation(
        &owner,
        2,
        identity_id(&owner),
        vec![OWNER_DEVICE.into()],
        MembershipAction::SetDevices,
        None,
        2,
        "01K10KJ6P20S58KQBV5P4E3TA2",
    );
    peer_a
        .send(ClientRequest::ContractOp(ContractRequest::Update {
            key,
            data: UpdateData::Delta(StateDelta::from(serde_json::to_vec(&remove)?)),
        }))
        .await?;
    receive_update(&mut peer_a).await?;
    // Core notifications are edge-triggered hints rather than a durable queue.
    // The first update above verifies the subscription; consume a later hint
    // when present and always confirm the authoritative state.
    if !matches!(
        timeout(Duration::from_secs(10), receive_notification(&mut peer_b)).await,
        Ok(Ok(()))
    ) {
        eprintln!("community removal hint was coalesced; verifying state directly");
    }
    let removed = wait_for_epoch(&mut peer_b, key, 2).await?;
    ensure!(
        removed
            .members
            .get(&identity_id(&owner))
            .is_some_and(|member| member.active && member.device_ids == [OWNER_DEVICE])
            && removed.revoked_device_ids.contains(LINKED_DEVICE)
    );
    eprintln!("linked-device revocation reached peer B at epoch 2");

    let linked_key = SigningKey::from_bytes(&[32_u8; 32]);
    let linked_public_key = linked_key.verifying_key().to_bytes();
    let impersonation_operation_id = "01K10KJ6P20S58KQBV5P4E3TA3";
    let mut impersonation = MembershipOperation {
        protocol_version: PROTOCOL_VERSION,
        operation_id: impersonation_operation_id.into(),
        community_id: COMMUNITY_ID.into(),
        actor_id: identity_id(&owner),
        actor_device_id: OWNER_DEVICE.into(),
        actor_sequence: 3,
        target_identity_id: identity_id(&owner),
        target_device_ids: vec![OWNER_DEVICE.into(), LINKED_DEVICE.into()],
        action: MembershipAction::SetDevices,
        role: None,
        epoch: 3,
        created_at: "2026-07-26T12:05:00.000Z".into(),
        public_key: URL_SAFE_NO_PAD.encode(linked_public_key),
        device_certificate: support::device_certificate_for(
            &owner,
            &linked_key,
            LINKED_DEVICE,
            URL_SAFE_NO_PAD.encode([77_u8; 32]),
        ),
        signature: String::new(),
    };
    impersonation.signature = URL_SAFE_NO_PAD.encode(
        linked_key
            .sign(&canonical_membership_bytes(&impersonation))
            .to_bytes(),
    );
    peer_a
        .send(ClientRequest::ContractOp(ContractRequest::Update {
            key,
            data: UpdateData::Delta(StateDelta::from(serde_json::to_vec(&impersonation)?)),
        }))
        .await?;
    receive_rejected_impersonation(&mut peer_a).await?;
    let after_impersonation: CommunityState =
        serde_json::from_slice(get_state(&mut peer_b, key, false).await?.as_ref())?;
    ensure!(
        after_impersonation.epoch == 2
            && !after_impersonation
                .operations
                .contains_key(impersonation_operation_id)
    );
    eprintln!("revoked linked device could not impersonate the active owner device");

    peer_a.disconnect("Nexus community test complete").await;
    peer_b.disconnect("Nexus community test complete").await;
    Ok(())
}
