use std::{env, fs, path::PathBuf, sync::Arc, time::Duration};

use anyhow::{Context, Result, bail, ensure};
use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use ed25519_dalek::{Signer, SigningKey};
use freenet_stdlib::{
    client_api::{ClientRequest, ContractRequest, ContractResponse, HostResponse, WebApi},
    prelude::{
        ContractCode, ContractContainer, ContractKey, ContractWasmAPIVersion, Parameters,
        RelatedContracts, StateDelta, UpdateData, WrappedContract, WrappedState,
    },
};
use freenet_test_network::{FreenetBinary, TestNetwork};
use nexus_protocol::{
    ATTACHMENT_CHUNK_BYTES, AttachmentChunk, AttachmentIndexOperation, AttachmentIndexState,
    AttachmentManifest, PROTOCOL_VERSION, canonical_attachment_index_bytes,
};
use sha2::{Digest, Sha256};
use tokio::time::{sleep, timeout};
use tokio_tungstenite::connect_async;

mod support;

const CHUNK: &[u8] = b"content delivered through two real Freenet nodes";

async fn connect(url: String) -> Result<WebApi> {
    let (stream, _) = connect_async(format!("{url}?encodingProtocol=native")).await?;
    Ok(WebApi::start(stream))
}

async fn receive_put(client: &mut WebApi) -> Result<()> {
    loop {
        match timeout(Duration::from_secs(60), client.recv()).await?? {
            HostResponse::ContractResponse(ContractResponse::PutResponse { .. }) => return Ok(()),
            HostResponse::ContractResponse(ContractResponse::NotFound { .. }) => {
                bail!("attachment contract PUT unexpectedly returned not found")
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
                .context("timed out waiting for attachment index notification")??
        {
            return Ok(());
        }
    }
}

async fn get_state(client: &mut WebApi, key: ContractKey, subscribe: bool) -> Result<WrappedState> {
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
    bail!("attachment state did not propagate to peer B")
}

fn index_operation(key: &SigningKey) -> AttachmentIndexOperation {
    let chunk_hash = hex::encode(Sha256::digest(CHUNK));
    let manifest = AttachmentManifest {
        version: PROTOCOL_VERSION,
        attachment_id: "01K10KJ6P20S58KQBV5P4E3TD1".into(),
        file_name: "freenet.txt".into(),
        media_type: "text/plain".into(),
        total_bytes: CHUNK.len() as u64,
        content_sha256: chunk_hash.clone(),
        chunk_bytes: ATTACHMENT_CHUNK_BYTES,
        encrypted: false,
        chunks: vec![AttachmentChunk {
            index: 0,
            plaintext_bytes: CHUNK.len() as u64,
            stored_bytes: CHUNK.len() as u64,
            sha256: chunk_hash,
        }],
    };
    let reference = format!(
        "nexus-attachment:{}",
        hex::encode(Sha256::digest(serde_json::to_vec(&manifest).unwrap()))
    );
    let public_key = key.verifying_key().to_bytes();
    let mut operation = AttachmentIndexOperation {
        protocol_version: PROTOCOL_VERSION,
        operation_id: "01K10KJ6P20S58KQBV5P4E3TD2".into(),
        target_id: "01K10KJ6P20S58KQBV5P4E3T9Z".into(),
        author_id: hex::encode(Sha256::digest(public_key)),
        author_device_id: "attachment-integration-device".into(),
        actor_sequence: 1,
        reference,
        manifest,
        created_at: "2026-07-26T12:00:00.000Z".into(),
        public_key: URL_SAFE_NO_PAD.encode(public_key),
        device_certificate: support::device_certificate(key, "attachment-integration-device"),
        signature: String::new(),
    };
    operation.signature = URL_SAFE_NO_PAD.encode(
        key.sign(&canonical_attachment_index_bytes(&operation))
            .to_bytes(),
    );
    operation
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "requires pinned Freenet Core and compiled attachment contract Wasm"]
async fn content_chunk_and_signed_index_round_trip_across_two_real_nodes() -> Result<()> {
    let binary = PathBuf::from(
        env::var_os("NEXUS_FREENET_BIN")
            .context("set NEXUS_FREENET_BIN to the pinned Freenet Core executable")?,
    );
    let chunk_wasm = PathBuf::from(
        env::var_os("NEXUS_ATTACHMENT_CHUNK_CONTRACT_WASM")
            .context("set NEXUS_ATTACHMENT_CHUNK_CONTRACT_WASM")?,
    );
    let index_wasm = PathBuf::from(
        env::var_os("NEXUS_ATTACHMENT_INDEX_CONTRACT_WASM")
            .context("set NEXUS_ATTACHMENT_INDEX_CONTRACT_WASM")?,
    );
    ensure!(binary.is_file() && chunk_wasm.is_file() && index_wasm.is_file());

    let network = TestNetwork::builder()
        .gateways(1)
        .peers(1)
        .min_connections(1)
        .max_connections(4)
        .binary(FreenetBinary::Path(binary))
        .connectivity_timeout(Duration::from_secs(60))
        .build()
        .await?;
    let mut peer_a = connect(network.peer(0).ws_url()).await?;
    let mut peer_b = connect(network.gateway(0).ws_url()).await?;
    eprintln!("two-node attachment network ready");

    let chunk_contract = ContractContainer::Wasm(ContractWasmAPIVersion::V1(WrappedContract::new(
        Arc::new(ContractCode::from(fs::read(chunk_wasm)?)),
        Parameters::from(Sha256::digest(CHUNK).to_vec()),
    )));
    let chunk_key = chunk_contract.key();
    peer_a
        .send(ClientRequest::ContractOp(ContractRequest::Put {
            contract: chunk_contract,
            state: WrappedState::from(CHUNK.to_vec()),
            related_contracts: RelatedContracts::default(),
            subscribe: false,
            blocking_subscribe: false,
        }))
        .await?;
    receive_put(&mut peer_a).await?;
    let delivered = get_state(&mut peer_b, chunk_key, false).await?;
    ensure!(delivered.as_ref() == CHUNK);
    eprintln!("content-addressed attachment chunk reached peer B intact");

    let index_contract = ContractContainer::Wasm(ContractWasmAPIVersion::V1(WrappedContract::new(
        Arc::new(ContractCode::from(fs::read(index_wasm)?)),
        Parameters::from(Vec::<u8>::new()),
    )));
    let index_key = index_contract.key();
    peer_a
        .send(ClientRequest::ContractOp(ContractRequest::Put {
            contract: index_contract,
            state: WrappedState::from(serde_json::to_vec(&AttachmentIndexState::default())?),
            related_contracts: RelatedContracts::default(),
            subscribe: false,
            blocking_subscribe: false,
        }))
        .await?;
    receive_put(&mut peer_a).await?;
    let before: AttachmentIndexState =
        serde_json::from_slice(get_state(&mut peer_b, index_key, true).await?.as_ref())?;
    ensure!(before.attachments.is_empty());

    let operation = index_operation(&SigningKey::from_bytes(&[63; 32]));
    peer_a
        .send(ClientRequest::ContractOp(ContractRequest::Update {
            key: index_key,
            data: UpdateData::Delta(StateDelta::from(serde_json::to_vec(&operation)?)),
        }))
        .await?;
    receive_update(&mut peer_a).await?;
    receive_notification(&mut peer_b).await?;
    let after: AttachmentIndexState =
        serde_json::from_slice(get_state(&mut peer_b, index_key, false).await?.as_ref())?;
    ensure!(
        after
            .attachments
            .get(&operation.reference)
            .is_some_and(|indexed| indexed.manifest.file_name == "freenet.txt")
    );
    eprintln!("signed attachment index entry reached peer B");

    peer_a.disconnect("Nexus attachment test complete").await;
    peer_b.disconnect("Nexus attachment test complete").await;
    Ok(())
}
