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
    ReleaseArtifact, ReleaseRecord, ReleaseRevocation, ReleaseState, canonical_release_bytes,
    canonical_revocation_bytes,
};
use tokio::time::{sleep, timeout};
use tokio_tungstenite::connect_async;

fn signed_release(key: &SigningKey) -> ReleaseRecord {
    let public = URL_SAFE_NO_PAD.encode(key.verifying_key().to_bytes());
    let mut record = ReleaseRecord {
        schema_version: 1,
        release_id: "01K10KJ6P20S58KQBV5P4E3TF1".into(),
        product: "Nexus".into(),
        version: "0.2.0".into(),
        published_at: "2026-07-26T12:00:00.000Z".into(),
        core_compatibility: "0.2.107".into(),
        artifacts: vec![ReleaseArtifact {
            name: "Nexus_0.2.0_x64-setup.exe".into(),
            platform: "windows-x86_64".into(),
            bytes: 47_000_000,
            sha256: "b".repeat(64),
            url: "https://updates.example/Nexus_0.2.0_x64-setup.exe".into(),
        }],
        signer_public_key: public,
        signature: String::new(),
    };
    record.signature =
        URL_SAFE_NO_PAD.encode(key.sign(&canonical_release_bytes(&record)).to_bytes());
    record
}

fn signed_revocation(key: &SigningKey, release_id: String) -> ReleaseRevocation {
    let mut record = ReleaseRevocation {
        schema_version: 1,
        revocation_id: "01K10KJ6P20S58KQBV5P4E3TF2".into(),
        release_id,
        reason: "withdrawn by the offline release authority".into(),
        created_at: "2026-07-26T13:00:00.000Z".into(),
        signer_public_key: URL_SAFE_NO_PAD.encode(key.verifying_key().to_bytes()),
        signature: String::new(),
    };
    record.signature =
        URL_SAFE_NO_PAD.encode(key.sign(&canonical_revocation_bytes(&record)).to_bytes());
    record
}

async fn connect(url: String) -> Result<WebApi> {
    let (stream, _) = connect_async(format!("{url}?encodingProtocol=native")).await?;
    Ok(WebApi::start(stream))
}

async fn response(client: &mut WebApi, update: bool) -> Result<()> {
    loop {
        match timeout(Duration::from_secs(60), client.recv()).await?? {
            HostResponse::ContractResponse(ContractResponse::PutResponse { .. }) if !update => {
                return Ok(());
            }
            HostResponse::ContractResponse(ContractResponse::UpdateResponse { .. }) if update => {
                return Ok(());
            }
            HostResponse::ContractResponse(ContractResponse::NotFound { .. }) => {
                bail!("release contract operation unexpectedly returned not found")
            }
            _ => {}
        }
    }
}

async fn notification(client: &mut WebApi) -> Result<()> {
    loop {
        if let HostResponse::ContractResponse(ContractResponse::UpdateNotification { .. }) =
            timeout(Duration::from_secs(60), client.recv())
                .await
                .context("timed out waiting for release update")??
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
    bail!("release state did not propagate to peer B")
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "requires pinned Freenet Core and compiled release-manifest contract Wasm"]
async fn signed_release_and_revocation_round_trip_across_two_real_nodes() -> Result<()> {
    let binary = PathBuf::from(
        env::var_os("NEXUS_FREENET_BIN")
            .context("set NEXUS_FREENET_BIN to the pinned Freenet Core executable")?,
    );
    let wasm = PathBuf::from(
        env::var_os("NEXUS_RELEASE_CONTRACT_WASM")
            .context("set NEXUS_RELEASE_CONTRACT_WASM to the release-manifest Wasm")?,
    );
    ensure!(binary.is_file() && wasm.is_file());
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
    let signing_key = SigningKey::from_bytes(&[101; 32]);
    let initial = ReleaseState::new(
        "Nexus".into(),
        URL_SAFE_NO_PAD.encode(signing_key.verifying_key().to_bytes()),
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
    response(&mut peer_a, false).await?;
    // Establish peer B's downstream route before waiting for an edge-triggered
    // release notification. A non-subscribing read cannot promise that event.
    let before: ReleaseState =
        serde_json::from_slice(get_state(&mut peer_b, key, true).await?.as_ref())?;
    ensure!(before.releases.is_empty());

    let release = signed_release(&signing_key);
    peer_a
        .send(ClientRequest::ContractOp(ContractRequest::Update {
            key,
            data: UpdateData::Delta(StateDelta::from(serde_json::to_vec(&release)?)),
        }))
        .await?;
    response(&mut peer_a, true).await?;
    notification(&mut peer_b).await?;
    let published: ReleaseState =
        serde_json::from_slice(get_state(&mut peer_b, key, true).await?.as_ref())?;
    ensure!(published.releases.contains_key(&release.release_id));
    eprintln!("offline-root-signed release reached peer B");

    let revocation = signed_revocation(&signing_key, release.release_id.clone());
    peer_a
        .send(ClientRequest::ContractOp(ContractRequest::Update {
            key,
            data: UpdateData::Delta(StateDelta::from(serde_json::to_vec(&revocation)?)),
        }))
        .await?;
    response(&mut peer_a, true).await?;
    let local_after_revocation: ReleaseState =
        serde_json::from_slice(get_state(&mut peer_a, key, false).await?.as_ref())?;
    ensure!(
        local_after_revocation
            .revocations
            .contains_key(&revocation.revocation_id),
        "peer A accepted the update response without materializing the revocation"
    );
    // The release notification above proves the subscription. Consume the
    // revocation hint when present, but base acceptance on authoritative state.
    if !matches!(
        timeout(Duration::from_secs(10), notification(&mut peer_b)).await,
        Ok(Ok(()))
    ) {
        eprintln!("release revocation hint was coalesced; verifying state directly");
    }
    let mut revoked = None;
    for _ in 0..60 {
        let state: ReleaseState =
            serde_json::from_slice(get_state(&mut peer_b, key, false).await?.as_ref())?;
        if state.revocations.contains_key(&revocation.revocation_id) {
            revoked = Some(state);
            break;
        }
        sleep(Duration::from_secs(1)).await;
    }
    let revoked = revoked.context("root-signed revocation did not propagate to peer B")?;
    ensure!(revoked.revocations.contains_key(&revocation.revocation_id));
    eprintln!("root-signed release revocation reached peer B");

    peer_a.disconnect("Nexus release test complete").await;
    peer_b.disconnect("Nexus release test complete").await;
    Ok(())
}
