use std::collections::{BTreeMap, BTreeSet};

use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use serde::{Deserialize, Serialize};
use thiserror::Error;

use crate::{DeviceCertificate, PROTOCOL_VERSION, verify_device_signature};

pub const MAX_CONVERSATION_ROTATIONS: usize = 1024;
pub const MAX_CONVERSATION_TRANSFERS: usize = 256;
pub const MAX_CONVERSATION_DEVICES: usize = 64;
pub const CONVERSATION_STATE_HARD_LIMIT: usize = 4 * 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversationDevice {
    pub identity_id: String,
    pub device_id: String,
    pub encryption_public_key: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EncryptedEnvelope {
    pub suite: String,
    pub nonce: String,
    pub ciphertext: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SealedEpochKey {
    pub suite: String,
    pub conversation_id: String,
    pub epoch: u64,
    pub recipient_device_id: String,
    pub ephemeral_public_key: String,
    pub salt: String,
    pub envelope: EncryptedEnvelope,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EpochRotationOperation {
    pub protocol_version: u64,
    pub operation_id: String,
    pub conversation_id: String,
    pub actor_id: String,
    pub actor_device_id: String,
    pub actor_sequence: u64,
    pub epoch: u64,
    #[serde(default)]
    pub devices: Vec<ConversationDevice>,
    #[serde(default)]
    pub sealed_keys: Vec<SealedEpochKey>,
    pub created_at: String,
    pub public_key: String,
    pub device_certificate: DeviceCertificate,
    pub signature: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversationControllerTransferOperation {
    pub protocol_version: u64,
    pub operation_id: String,
    pub conversation_id: String,
    pub actor_id: String,
    pub actor_device_id: String,
    pub actor_sequence: u64,
    pub conversation_epoch: u64,
    pub target_identity_id: String,
    pub target_device_id: String,
    pub created_at: String,
    pub public_key: String,
    pub device_certificate: DeviceCertificate,
    pub signature: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversationState {
    pub schema_version: u64,
    pub conversation_id: String,
    pub creator_id: String,
    pub creator_device_id: String,
    pub creator_encryption_public_key: String,
    #[serde(default)]
    pub rotations: BTreeMap<String, EpochRotationOperation>,
    #[serde(default)]
    pub transfers: BTreeMap<String, ConversationControllerTransferOperation>,
    #[serde(default)]
    pub controller_id: String,
    #[serde(default)]
    pub controller_device_id: String,
    #[serde(default)]
    pub epoch: u64,
    #[serde(default)]
    pub devices: BTreeMap<String, ConversationDevice>,
    #[serde(default)]
    pub sealed_keys: BTreeMap<String, SealedEpochKey>,
    #[serde(default)]
    pub actor_sequences: BTreeMap<String, u64>,
}

impl ConversationState {
    pub fn new(
        conversation_id: String,
        creator_id: String,
        creator_device_id: String,
        creator_encryption_public_key: String,
    ) -> Self {
        let mut state = Self {
            schema_version: PROTOCOL_VERSION,
            conversation_id,
            creator_id,
            creator_device_id,
            creator_encryption_public_key,
            rotations: BTreeMap::new(),
            transfers: BTreeMap::new(),
            controller_id: String::new(),
            controller_device_id: String::new(),
            epoch: 0,
            devices: BTreeMap::new(),
            sealed_keys: BTreeMap::new(),
            actor_sequences: BTreeMap::new(),
        };
        materialize_conversation(&mut state);
        state
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ConversationSummary {
    #[serde(default)]
    pub rotation_ids: BTreeSet<String>,
    #[serde(default)]
    pub transfer_ids: BTreeSet<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ConversationDelta {
    #[serde(default)]
    pub rotations: Vec<EpochRotationOperation>,
    #[serde(default)]
    pub transfers: Vec<ConversationControllerTransferOperation>,
}

#[derive(Debug, Error, PartialEq, Eq)]
pub enum ConversationProtocolError {
    #[error("malformed conversation state or rotation: {0}")]
    Malformed(String),
    #[error("invalid conversation rotation signature")]
    InvalidSignature,
    #[error("rotation belongs to another conversation")]
    WrongConversation,
    #[error("conversation rotation operation limit reached")]
    OperationLimit,
    #[error("conversation state exceeds the hard size limit")]
    StateTooLarge,
}

pub fn canonical_conversation_controller_transfer_bytes(
    operation: &ConversationControllerTransferOperation,
) -> Vec<u8> {
    let fields = [
        operation.protocol_version.to_string(),
        operation.operation_id.clone(),
        operation.conversation_id.clone(),
        operation.actor_id.clone(),
        operation.actor_device_id.clone(),
        operation.actor_sequence.to_string(),
        operation.conversation_epoch.to_string(),
        operation.target_identity_id.clone(),
        operation.target_device_id.clone(),
        operation.created_at.clone(),
    ];
    let mut output = Vec::with_capacity(1024);
    frame(b"nexus:conversation-controller-transfer:v2", &mut output);
    for field in fields {
        frame(field.as_bytes(), &mut output);
    }
    output
}

pub fn verify_conversation_controller_transfer(
    operation: &ConversationControllerTransferOperation,
) -> Result<(), ConversationProtocolError> {
    let encoded = serde_json::to_vec(operation)
        .map_err(|error| ConversationProtocolError::Malformed(error.to_string()))?;
    if encoded.len() > 16 * 1024
        || operation.protocol_version != PROTOCOL_VERSION
        || !valid_ulid(&operation.operation_id)
        || !valid_ulid(&operation.conversation_id)
        || !valid_identity(&operation.actor_id)
        || operation.actor_device_id.is_empty()
        || operation.actor_device_id.len() > 128
        || operation.actor_sequence == 0
        || operation.conversation_epoch == 0
        || !valid_identity(&operation.target_identity_id)
        || operation.target_device_id.is_empty()
        || operation.target_device_id.len() > 128
        || operation.created_at.is_empty()
        || operation.created_at.len() > 64
    {
        return Err(ConversationProtocolError::Malformed(
            "controller transfer field is outside its validated bounds".into(),
        ));
    }
    verify_identity_signature(
        &operation.actor_id,
        &operation.actor_device_id,
        &operation.public_key,
        &operation.device_certificate,
        &operation.signature,
        &canonical_conversation_controller_transfer_bytes(operation),
    )
}

pub fn canonical_epoch_rotation_bytes(operation: &EpochRotationOperation) -> Vec<u8> {
    let mut devices = operation.devices.clone();
    devices.sort();
    devices.dedup_by(|left, right| left.device_id == right.device_id);
    let device_records = devices
        .iter()
        .map(|device| {
            [
                device.identity_id.as_str(),
                device.device_id.as_str(),
                device.encryption_public_key.as_str(),
            ]
            .join("\u{1f}")
        })
        .collect::<Vec<_>>()
        .join("\u{1e}");

    let mut sealed_keys = operation.sealed_keys.clone();
    sealed_keys.sort_by(|left, right| left.recipient_device_id.cmp(&right.recipient_device_id));
    sealed_keys.dedup_by(|left, right| left.recipient_device_id == right.recipient_device_id);
    let sealed_records = sealed_keys
        .iter()
        .map(|sealed| {
            [
                sealed.suite.as_str(),
                sealed.conversation_id.as_str(),
                &sealed.epoch.to_string(),
                sealed.recipient_device_id.as_str(),
                sealed.ephemeral_public_key.as_str(),
                sealed.salt.as_str(),
                sealed.envelope.suite.as_str(),
                sealed.envelope.nonce.as_str(),
                sealed.envelope.ciphertext.as_str(),
            ]
            .join("\u{1f}")
        })
        .collect::<Vec<_>>()
        .join("\u{1e}");

    let fields = [
        operation.protocol_version.to_string(),
        operation.operation_id.clone(),
        operation.conversation_id.clone(),
        operation.actor_id.clone(),
        operation.actor_device_id.clone(),
        operation.actor_sequence.to_string(),
        operation.epoch.to_string(),
        device_records,
        sealed_records,
        operation.created_at.clone(),
    ];
    let mut output = Vec::with_capacity(4096);
    frame(b"nexus:conversation-epoch-rotation:v2", &mut output);
    for field in fields {
        frame(field.as_bytes(), &mut output);
    }
    output
}

pub fn verify_epoch_rotation(
    operation: &EpochRotationOperation,
) -> Result<(), ConversationProtocolError> {
    let encoded = serde_json::to_vec(operation)
        .map_err(|error| ConversationProtocolError::Malformed(error.to_string()))?;
    if encoded.len() > 256 * 1024
        || operation.protocol_version != PROTOCOL_VERSION
        || !valid_ulid(&operation.operation_id)
        || !valid_ulid(&operation.conversation_id)
        || !valid_identity(&operation.actor_id)
        || operation.actor_device_id.is_empty()
        || operation.actor_device_id.len() > 128
        || operation.actor_sequence == 0
        || operation.epoch == 0
        || operation.devices.is_empty()
        || operation.devices.len() > MAX_CONVERSATION_DEVICES
        || operation.sealed_keys.len() != operation.devices.len()
        || operation.created_at.is_empty()
        || operation.created_at.len() > 64
    {
        return Err(ConversationProtocolError::Malformed(
            "rotation field is outside its validated bounds".into(),
        ));
    }

    let mut device_ids = BTreeSet::new();
    for device in &operation.devices {
        if !valid_identity(&device.identity_id)
            || device.device_id.is_empty()
            || device.device_id.len() > 128
            || !base64_has_len(&device.encryption_public_key, 32)
            || !device_ids.insert(device.device_id.as_str())
        {
            return Err(ConversationProtocolError::Malformed(
                "conversation device roster is invalid".into(),
            ));
        }
    }
    let mut recipient_ids = BTreeSet::new();
    for sealed in &operation.sealed_keys {
        if sealed.suite != "X25519-HKDF-SHA-256+AES-256-GCM"
            || sealed.conversation_id != operation.conversation_id
            || sealed.epoch != operation.epoch
            || !device_ids.contains(sealed.recipient_device_id.as_str())
            || !recipient_ids.insert(sealed.recipient_device_id.as_str())
            || !base64_has_len(&sealed.ephemeral_public_key, 32)
            || !base64_has_len(&sealed.salt, 32)
            || sealed.envelope.suite != "AES-256-GCM"
            || !base64_has_len(&sealed.envelope.nonce, 12)
            || !base64_has_len(&sealed.envelope.ciphertext, 48)
        {
            return Err(ConversationProtocolError::Malformed(
                "sealed epoch key roster is invalid".into(),
            ));
        }
    }
    if recipient_ids != device_ids {
        return Err(ConversationProtocolError::Malformed(
            "every authorized device requires exactly one sealed epoch key".into(),
        ));
    }

    verify_identity_signature(
        &operation.actor_id,
        &operation.actor_device_id,
        &operation.public_key,
        &operation.device_certificate,
        &operation.signature,
        &canonical_epoch_rotation_bytes(operation),
    )
}

pub fn apply_epoch_rotation(
    state: &mut ConversationState,
    operation: EpochRotationOperation,
) -> Result<(), ConversationProtocolError> {
    verify_epoch_rotation(&operation)?;
    if operation.conversation_id != state.conversation_id {
        return Err(ConversationProtocolError::WrongConversation);
    }
    if state.rotations.contains_key(&operation.operation_id) {
        return Ok(());
    }
    if state.rotations.len() >= MAX_CONVERSATION_ROTATIONS {
        return Err(ConversationProtocolError::OperationLimit);
    }
    state
        .rotations
        .insert(operation.operation_id.clone(), operation);
    materialize_conversation(state);
    ensure_conversation_size(state)
}

pub fn apply_conversation_controller_transfer(
    state: &mut ConversationState,
    operation: ConversationControllerTransferOperation,
) -> Result<(), ConversationProtocolError> {
    verify_conversation_controller_transfer(&operation)?;
    if operation.conversation_id != state.conversation_id {
        return Err(ConversationProtocolError::WrongConversation);
    }
    if state.transfers.contains_key(&operation.operation_id) {
        return Ok(());
    }
    if state.transfers.len() >= MAX_CONVERSATION_TRANSFERS {
        return Err(ConversationProtocolError::OperationLimit);
    }
    state
        .transfers
        .insert(operation.operation_id.clone(), operation);
    materialize_conversation(state);
    ensure_conversation_size(state)
}

pub fn merge_conversation_states(
    destination: &mut ConversationState,
    source: ConversationState,
) -> Result<(), ConversationProtocolError> {
    if destination.conversation_id != source.conversation_id
        || destination.creator_id != source.creator_id
        || destination.creator_device_id != source.creator_device_id
        || destination.creator_encryption_public_key != source.creator_encryption_public_key
    {
        return Err(ConversationProtocolError::Malformed(
            "conversation bootstrap authority does not match".into(),
        ));
    }
    for rotation in source.rotations.into_values() {
        apply_epoch_rotation(destination, rotation)?;
    }
    for transfer in source.transfers.into_values() {
        apply_conversation_controller_transfer(destination, transfer)?;
    }
    materialize_conversation(destination);
    ensure_conversation_size(destination)
}

pub fn validate_conversation_state(
    state: &ConversationState,
) -> Result<(), ConversationProtocolError> {
    if state.schema_version != PROTOCOL_VERSION
        || !valid_ulid(&state.conversation_id)
        || !valid_identity(&state.creator_id)
        || state.creator_device_id.is_empty()
        || state.creator_device_id.len() > 128
        || !base64_has_len(&state.creator_encryption_public_key, 32)
        || state.rotations.len() > MAX_CONVERSATION_ROTATIONS
        || state.transfers.len() > MAX_CONVERSATION_TRANSFERS
    {
        return Err(ConversationProtocolError::Malformed(
            "conversation bootstrap or state bounds are invalid".into(),
        ));
    }
    for (rotation_id, rotation) in &state.rotations {
        if rotation_id != &rotation.operation_id
            || rotation.conversation_id != state.conversation_id
        {
            return Err(ConversationProtocolError::Malformed(
                "rotation index does not match its signed operation".into(),
            ));
        }
        verify_epoch_rotation(rotation)?;
    }
    for (transfer_id, transfer) in &state.transfers {
        if transfer_id != &transfer.operation_id
            || transfer.conversation_id != state.conversation_id
        {
            return Err(ConversationProtocolError::Malformed(
                "controller transfer index does not match its signed operation".into(),
            ));
        }
        verify_conversation_controller_transfer(transfer)?;
    }
    let mut expected = state.clone();
    materialize_conversation(&mut expected);
    let controller_view_matches = (state.controller_id.is_empty()
        && state.controller_device_id.is_empty()
        && state.transfers.is_empty())
        || (expected.controller_id == state.controller_id
            && expected.controller_device_id == state.controller_device_id);
    if expected.epoch != state.epoch
        || !controller_view_matches
        || expected.devices != state.devices
        || expected.sealed_keys != state.sealed_keys
        || expected.actor_sequences != state.actor_sequences
    {
        return Err(ConversationProtocolError::Malformed(
            "materialized conversation view does not match its rotation log".into(),
        ));
    }
    ensure_conversation_size(state)
}

pub fn summarize_conversation(state: &ConversationState) -> ConversationSummary {
    ConversationSummary {
        rotation_ids: state.rotations.keys().cloned().collect(),
        transfer_ids: state.transfers.keys().cloned().collect(),
    }
}

pub fn conversation_delta_for(
    state: &ConversationState,
    remote: &ConversationSummary,
) -> ConversationDelta {
    ConversationDelta {
        rotations: state
            .rotations
            .iter()
            .filter_map(|(rotation_id, rotation)| {
                (!remote.rotation_ids.contains(rotation_id)).then_some(rotation.clone())
            })
            .collect(),
        transfers: state
            .transfers
            .iter()
            .filter_map(|(transfer_id, transfer)| {
                (!remote.transfer_ids.contains(transfer_id)).then_some(transfer.clone())
            })
            .collect(),
    }
}

pub fn materialize_conversation(state: &mut ConversationState) {
    state.schema_version = PROTOCOL_VERSION;
    state.controller_id = state.creator_id.clone();
    state.controller_device_id = state.creator_device_id.clone();
    state.epoch = 0;
    state.actor_sequences.clear();
    state.sealed_keys.clear();
    state.devices.clear();
    state.devices.insert(
        state.creator_device_id.clone(),
        ConversationDevice {
            identity_id: state.creator_id.clone(),
            device_id: state.creator_device_id.clone(),
            encryption_public_key: state.creator_encryption_public_key.clone(),
        },
    );

    let mut applied_transfers = BTreeSet::new();
    loop {
        let transfer = state
            .transfers
            .iter()
            .filter(|(transfer_id, transfer)| {
                !applied_transfers.contains(*transfer_id)
                    && transfer.conversation_epoch == state.epoch
            })
            .rev()
            .find(|(_, transfer)| transfer_is_authorized(state, transfer))
            .map(|(transfer_id, transfer)| (transfer_id.clone(), transfer.clone()));
        if let Some((transfer_id, transfer)) = transfer {
            state.controller_id = transfer.target_identity_id;
            state.controller_device_id = transfer.target_device_id;
            state
                .actor_sequences
                .insert(transfer.actor_device_id, transfer.actor_sequence);
            applied_transfers.insert(transfer_id);
            continue;
        }

        let expected_epoch = state.epoch + 1;
        let candidate = state
            .rotations
            .values()
            .filter(|rotation| rotation.epoch == expected_epoch)
            .rev()
            .find(|rotation| rotation_is_authorized(state, rotation))
            .cloned();
        let Some(rotation) = candidate else {
            break;
        };
        state.devices = rotation
            .devices
            .iter()
            .cloned()
            .map(|device| (device.device_id.clone(), device))
            .collect();
        state.sealed_keys = rotation
            .sealed_keys
            .iter()
            .cloned()
            .map(|sealed| (sealed.recipient_device_id.clone(), sealed))
            .collect();
        state.epoch = rotation.epoch;
        if !state.devices.contains_key(&state.controller_device_id) {
            state.controller_device_id = state
                .devices
                .values()
                .filter(|device| device.identity_id == state.controller_id)
                .map(|device| device.device_id.clone())
                .next()
                .unwrap_or_default();
        }
        state
            .actor_sequences
            .insert(rotation.actor_device_id.clone(), rotation.actor_sequence);
    }
}

fn rotation_is_authorized(state: &ConversationState, operation: &EpochRotationOperation) -> bool {
    if operation.actor_id != state.controller_id
        || state
            .devices
            .get(&operation.actor_device_id)
            .is_none_or(|device| {
                device.identity_id != state.controller_id
                    || device.encryption_public_key
                        != operation.device_certificate.encryption_public_key
            })
        || operation.actor_sequence
            <= state
                .actor_sequences
                .get(&operation.actor_device_id)
                .copied()
                .unwrap_or_default()
    {
        return false;
    }
    operation
        .devices
        .iter()
        .any(|device| device.identity_id == state.controller_id)
}

fn transfer_is_authorized(
    state: &ConversationState,
    operation: &ConversationControllerTransferOperation,
) -> bool {
    operation.actor_id == state.controller_id
        && state
            .devices
            .get(&operation.actor_device_id)
            .is_some_and(|device| {
                device.identity_id == state.controller_id
                    && device.encryption_public_key
                        == operation.device_certificate.encryption_public_key
            })
        && state
            .devices
            .get(&operation.target_device_id)
            .is_some_and(|device| device.identity_id == operation.target_identity_id)
        && operation.actor_sequence
            > state
                .actor_sequences
                .get(&operation.actor_device_id)
                .copied()
                .unwrap_or_default()
}

fn verify_identity_signature(
    actor_id: &str,
    actor_device_id: &str,
    public_key: &str,
    device_certificate: &DeviceCertificate,
    signature: &str,
    message: &[u8],
) -> Result<(), ConversationProtocolError> {
    if verify_device_signature(
        device_certificate,
        public_key,
        signature,
        message,
        actor_id,
        actor_device_id,
    ) {
        Ok(())
    } else {
        Err(ConversationProtocolError::InvalidSignature)
    }
}

fn valid_identity(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn valid_ulid(value: &str) -> bool {
    value.len() == 26
        && value.bytes().all(|byte| {
            matches!(
                byte,
                b'0'..=b'9'
                    | b'A'..=b'H'
                    | b'J'
                    | b'K'
                    | b'M'
                    | b'N'
                    | b'P'..=b'T'
                    | b'V'..=b'Z'
            )
        })
}

fn base64_has_len(value: &str, length: usize) -> bool {
    URL_SAFE_NO_PAD
        .decode(value)
        .is_ok_and(|bytes| bytes.len() == length)
}

fn frame(bytes: &[u8], output: &mut Vec<u8>) {
    output.extend_from_slice(&(bytes.len() as u32).to_be_bytes());
    output.extend_from_slice(bytes);
}

fn ensure_conversation_size(state: &ConversationState) -> Result<(), ConversationProtocolError> {
    let bytes = serde_json::to_vec(state)
        .map_err(|error| ConversationProtocolError::Malformed(error.to_string()))?;
    if bytes.len() > CONVERSATION_STATE_HARD_LIMIT {
        return Err(ConversationProtocolError::StateTooLarge);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::{Signer, SigningKey};
    use sha2::{Digest, Sha256};

    const CONVERSATION_ID: &str = "01K10KJ6P20S58KQBV5P4E3T9D";

    fn identity(key: &SigningKey) -> String {
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

    fn rotation(
        key: &SigningKey,
        actor_device: &str,
        sequence: u64,
        epoch: u64,
        operation_id: &str,
        devices: Vec<ConversationDevice>,
    ) -> EpochRotationOperation {
        let public_key = key.verifying_key().to_bytes();
        let actor_encryption_public_key = devices
            .iter()
            .find(|device| device.device_id == actor_device)
            .map(|device| device.encryption_public_key.clone())
            .unwrap_or_else(|| encryption_key(if actor_device == "old-device" { 3 } else { 5 }));
        let mut operation = EpochRotationOperation {
            protocol_version: PROTOCOL_VERSION,
            operation_id: operation_id.into(),
            conversation_id: CONVERSATION_ID.into(),
            actor_id: identity(key),
            actor_device_id: actor_device.into(),
            actor_sequence: sequence,
            epoch,
            sealed_keys: devices
                .iter()
                .enumerate()
                .map(|(index, device)| sealed(&device.device_id, epoch, index as u8 + 1))
                .collect(),
            devices,
            created_at: "2026-07-26T12:00:00.000Z".into(),
            public_key: URL_SAFE_NO_PAD.encode(public_key),
            device_certificate: crate::test_device_certificate_with_encryption(
                key,
                key,
                actor_device,
                actor_encryption_public_key,
            ),
            signature: String::new(),
        };
        operation.signature = URL_SAFE_NO_PAD.encode(
            key.sign(&canonical_epoch_rotation_bytes(&operation))
                .to_bytes(),
        );
        operation
    }

    fn controller_transfer(
        key: &SigningKey,
        actor_device: &str,
        sequence: u64,
        epoch: u64,
        target_identity_id: String,
        target_device_id: &str,
    ) -> ConversationControllerTransferOperation {
        let public_key = key.verifying_key().to_bytes();
        let mut operation = ConversationControllerTransferOperation {
            protocol_version: PROTOCOL_VERSION,
            operation_id: "01K10KJ6P20S58KQBV5P4E3TC1".into(),
            conversation_id: CONVERSATION_ID.into(),
            actor_id: identity(key),
            actor_device_id: actor_device.into(),
            actor_sequence: sequence,
            conversation_epoch: epoch,
            target_identity_id,
            target_device_id: target_device_id.into(),
            created_at: "2026-07-26T12:01:00.000Z".into(),
            public_key: URL_SAFE_NO_PAD.encode(public_key),
            device_certificate: crate::test_device_certificate_with_encryption(
                key,
                key,
                actor_device,
                encryption_key(if actor_device == "successor-device" {
                    2
                } else {
                    1
                }),
            ),
            signature: String::new(),
        };
        operation.signature = URL_SAFE_NO_PAD.encode(
            key.sign(&canonical_conversation_controller_transfer_bytes(
                &operation,
            ))
            .to_bytes(),
        );
        operation
    }

    #[test]
    fn controller_transfer_allows_the_successor_to_rotate() {
        let founder = SigningKey::from_bytes(&[45; 32]);
        let successor = SigningKey::from_bytes(&[46; 32]);
        let founder_id = identity(&founder);
        let successor_id = identity(&successor);
        let roster = vec![
            device(founder_id.clone(), "founder-device", 1),
            device(successor_id.clone(), "successor-device", 2),
        ];
        let mut state = ConversationState::new(
            CONVERSATION_ID.into(),
            founder_id,
            "founder-device".into(),
            encryption_key(1),
        );
        apply_epoch_rotation(
            &mut state,
            rotation(
                &founder,
                "founder-device",
                1,
                1,
                "01K10KJ6P20S58KQBV5P4E3TB7",
                roster.clone(),
            ),
        )
        .unwrap();
        apply_conversation_controller_transfer(
            &mut state,
            controller_transfer(
                &founder,
                "founder-device",
                2,
                1,
                successor_id.clone(),
                "successor-device",
            ),
        )
        .unwrap();
        apply_epoch_rotation(
            &mut state,
            rotation(
                &successor,
                "successor-device",
                1,
                2,
                "01K10KJ6P20S58KQBV5P4E3TB8",
                roster,
            ),
        )
        .unwrap();
        assert_eq!(state.controller_id, successor_id);
        assert_eq!(state.epoch, 2);
        validate_conversation_state(&state).unwrap();
    }

    #[test]
    fn device_removal_requires_a_new_epoch_and_omits_its_envelope() {
        let creator = SigningKey::from_bytes(&[41; 32]);
        let member = SigningKey::from_bytes(&[42; 32]);
        let creator_id = identity(&creator);
        let mut state = ConversationState::new(
            CONVERSATION_ID.into(),
            creator_id.clone(),
            "creator-device".into(),
            encryption_key(1),
        );
        apply_epoch_rotation(
            &mut state,
            rotation(
                &creator,
                "creator-device",
                1,
                1,
                "01K10KJ6P20S58KQBV5P4E3TB1",
                vec![
                    device(creator_id.clone(), "creator-device", 1),
                    device(identity(&member), "member-device", 2),
                ],
            ),
        )
        .unwrap();
        apply_epoch_rotation(
            &mut state,
            rotation(
                &creator,
                "creator-device",
                2,
                2,
                "01K10KJ6P20S58KQBV5P4E3TB2",
                vec![device(creator_id, "creator-device", 1)],
            ),
        )
        .unwrap();
        assert_eq!(state.epoch, 2);
        assert!(!state.devices.contains_key("member-device"));
        assert!(!state.sealed_keys.contains_key("member-device"));
        validate_conversation_state(&state).unwrap();
    }

    #[test]
    fn removed_creator_device_cannot_rotate_again() {
        let creator = SigningKey::from_bytes(&[43; 32]);
        let creator_id = identity(&creator);
        let mut state = ConversationState::new(
            CONVERSATION_ID.into(),
            creator_id.clone(),
            "old-device".into(),
            encryption_key(3),
        );
        apply_epoch_rotation(
            &mut state,
            rotation(
                &creator,
                "old-device",
                1,
                1,
                "01K10KJ6P20S58KQBV5P4E3TB3",
                vec![device(creator_id.clone(), "new-device", 4)],
            ),
        )
        .unwrap();
        apply_epoch_rotation(
            &mut state,
            rotation(
                &creator,
                "old-device",
                2,
                2,
                "01K10KJ6P20S58KQBV5P4E3TB4",
                vec![device(creator_id, "old-device", 3)],
            ),
        )
        .unwrap();
        assert_eq!(state.epoch, 1);
        assert!(state.devices.contains_key("new-device"));
    }

    #[test]
    fn opposite_rotation_orders_converge() {
        let creator = SigningKey::from_bytes(&[44; 32]);
        let creator_id = identity(&creator);
        let initial = ConversationState::new(
            CONVERSATION_ID.into(),
            creator_id.clone(),
            "creator-device".into(),
            encryption_key(5),
        );
        let left = rotation(
            &creator,
            "creator-device",
            1,
            1,
            "01K10KJ6P20S58KQBV5P4E3TB5",
            vec![device(creator_id.clone(), "creator-device", 5)],
        );
        let right = rotation(
            &creator,
            "creator-device",
            1,
            1,
            "01K10KJ6P20S58KQBV5P4E3TB6",
            vec![device(creator_id, "replacement-device", 6)],
        );
        let mut forward = initial.clone();
        apply_epoch_rotation(&mut forward, left.clone()).unwrap();
        apply_epoch_rotation(&mut forward, right.clone()).unwrap();
        let mut reverse = initial;
        apply_epoch_rotation(&mut reverse, right).unwrap();
        apply_epoch_rotation(&mut reverse, left).unwrap();
        assert_eq!(forward, reverse);
        assert!(forward.devices.contains_key("replacement-device"));
    }
}
