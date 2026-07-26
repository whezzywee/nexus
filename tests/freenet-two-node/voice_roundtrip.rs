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
    CallSignalEnvelope, CallSignalType, PROTOCOL_VERSION, VoiceParticipant, VoiceSessionState,
    canonical_call_signal_bytes,
};
use sha2::{Digest, Sha256};
use tokio::time::{sleep, timeout};
use tokio_tungstenite::connect_async;

mod support;

const CALL_ID: &str = "01K10KJ6P20S58KQBV5P4E3TE1";

fn identity_id(key: &SigningKey) -> String {
    hex::encode(Sha256::digest(key.verifying_key().to_bytes()))
}

fn signed_signal(key: &SigningKey) -> CallSignalEnvelope {
    let public_key = key.verifying_key().to_bytes();
    let mut signal = CallSignalEnvelope {
        version: PROTOCOL_VERSION,
        signal_id: "01K10KJ6P20S58KQBV5P4E3TE2".into(),
        call_id: CALL_ID.into(),
        call_epoch: 1,
        sender_identity_id: identity_id(key),
        sender_device_id: "mara-call-device".into(),
        recipient_device_id: "theo-call-device".into(),
        sequence: 1,
        expires_at: 1_800_000_000_000,
        signal_type: CallSignalType::Offer,
        ciphertext: "recipient-encrypted-offer".into(),
        public_key: URL_SAFE_NO_PAD.encode(public_key),
        device_certificate: support::device_certificate(key, "mara-call-device"),
        signature: String::new(),
    };
    signal.signature =
        URL_SAFE_NO_PAD.encode(key.sign(&canonical_call_signal_bytes(&signal)).to_bytes());
    signal
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
                bail!("voice contract operation unexpectedly returned not found")
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
                .context("timed out waiting for encrypted voice signal")??
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
    bail!("voice-session state did not propagate to peer B")
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "requires pinned Freenet Core and compiled voice-session contract Wasm"]
async fn encrypted_call_signal_round_trips_across_two_real_nodes() -> Result<()> {
    let binary = PathBuf::from(
        env::var_os("NEXUS_FREENET_BIN")
            .context("set NEXUS_FREENET_BIN to the pinned Freenet Core executable")?,
    );
    let wasm = PathBuf::from(
        env::var_os("NEXUS_VOICE_CONTRACT_WASM")
            .context("set NEXUS_VOICE_CONTRACT_WASM to the voice-session Wasm")?,
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
    let mara = SigningKey::from_bytes(&[81; 32]);
    let theo = SigningKey::from_bytes(&[82; 32]);
    let initial = VoiceSessionState::new(
        CALL_ID.into(),
        1,
        vec![
            VoiceParticipant {
                identity_id: identity_id(&mara),
                device_id: "mara-call-device".into(),
            },
            VoiceParticipant {
                identity_id: identity_id(&theo),
                device_id: "theo-call-device".into(),
            },
        ],
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
    let before: VoiceSessionState =
        serde_json::from_slice(get_state(&mut peer_b, key, true).await?.as_ref())?;
    ensure!(before.signals.is_empty());
    eprintln!("voice-session roster published and subscribed across two nodes");

    let signal = signed_signal(&mara);
    peer_a
        .send(ClientRequest::ContractOp(ContractRequest::Update {
            key,
            data: UpdateData::Delta(StateDelta::from(serde_json::to_vec(&signal)?)),
        }))
        .await?;
    response(&mut peer_a, true).await?;
    notification(&mut peer_b).await?;
    let after: VoiceSessionState =
        serde_json::from_slice(get_state(&mut peer_b, key, false).await?.as_ref())?;
    ensure!(
        after
            .signals
            .get(&signal.signal_id)
            .is_some_and(|received| {
                received.recipient_device_id == "theo-call-device"
                    && received.ciphertext == "recipient-encrypted-offer"
            })
    );
    eprintln!("recipient-bound encrypted offer reached peer B");

    peer_a.disconnect("Nexus voice test complete").await;
    peer_b.disconnect("Nexus voice test complete").await;
    Ok(())
}
