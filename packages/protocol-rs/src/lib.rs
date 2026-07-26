use std::collections::{BTreeMap, BTreeSet};

use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use ed25519_dalek::{Signature, Verifier, VerifyingKey};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use thiserror::Error;

mod attachment;
mod community;
mod conversation;
mod release;
mod voice;

pub use attachment::*;
pub use community::*;
pub use conversation::*;
pub use release::*;
pub use voice::*;

pub const PROTOCOL_VERSION: u64 = 2;
pub const MAX_MESSAGE_CONTENT_BYTES: usize = 8 * 1024;
pub const MAX_MESSAGE_OPERATION_BYTES: usize = 32 * 1024;
pub const SEGMENT_MESSAGE_TARGET: usize = 512;
pub const SEGMENT_STATE_HARD_LIMIT: usize = 8 * 1024 * 1024;
pub const MAX_SEEN_OPERATION_IDS: usize = 4096;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceCertificate {
    pub version: u64,
    pub identity_id: String,
    pub device_id: String,
    pub root_public_key: String,
    pub signing_public_key: String,
    pub encryption_public_key: String,
    pub issuance_sequence: u64,
    pub issued_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expires_at: Option<String>,
    pub signature: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EncryptionMetadata {
    pub suite: String,
    pub epoch: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MessageOperation {
    pub protocol_version: u64,
    pub operation_id: String,
    pub message_id: String,
    pub channel_id: String,
    pub author_id: String,
    pub author_device_id: String,
    pub actor_sequence: u64,
    pub created_at: String,
    pub client_generated_order: String,
    pub content: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reply_to: Option<String>,
    #[serde(default)]
    pub attachment_references: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub encryption_metadata: Option<EncryptionMetadata>,
    pub edit_version: u64,
    pub deletion_tombstone: bool,
    pub public_key: String,
    pub device_certificate: DeviceCertificate,
    pub signature: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SegmentState {
    pub schema_version: u64,
    #[serde(default)]
    pub messages: BTreeMap<String, MessageOperation>,
    #[serde(default)]
    pub seen_operation_ids: BTreeSet<String>,
}

impl Default for SegmentState {
    fn default() -> Self {
        Self {
            schema_version: PROTOCOL_VERSION,
            messages: BTreeMap::new(),
            seen_operation_ids: BTreeSet::new(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct SegmentSummary {
    #[serde(default)]
    pub message_versions: BTreeMap<String, String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct SegmentDelta {
    #[serde(default)]
    pub operations: Vec<MessageOperation>,
}

#[derive(Debug, Error, PartialEq, Eq)]
pub enum ProtocolError {
    #[error("malformed operation: {0}")]
    Malformed(String),
    #[error("invalid message signature")]
    InvalidSignature,
    #[error("message state exceeds the hard size limit")]
    StateTooLarge,
}

fn frame(bytes: &[u8], output: &mut Vec<u8>) {
    output.extend_from_slice(&(bytes.len() as u32).to_be_bytes());
    output.extend_from_slice(bytes);
}

fn frame_text(value: &str, output: &mut Vec<u8>) {
    frame(value.as_bytes(), output);
}

fn frame_number(value: u64, output: &mut Vec<u8>) {
    frame(&value.to_be_bytes(), output);
}

fn frame_bool(value: bool, output: &mut Vec<u8>) {
    frame(&[u8::from(value)], output);
}

pub fn canonical_device_certificate_bytes(certificate: &DeviceCertificate) -> Vec<u8> {
    let mut output = Vec::with_capacity(768);
    frame(b"nexus:device-certificate:v2", &mut output);
    frame_text(&certificate.version.to_string(), &mut output);
    frame_text(&certificate.identity_id, &mut output);
    frame_text(&certificate.device_id, &mut output);
    frame_text(&certificate.root_public_key, &mut output);
    frame_text(&certificate.signing_public_key, &mut output);
    frame_text(&certificate.encryption_public_key, &mut output);
    frame_text(&certificate.issuance_sequence.to_string(), &mut output);
    frame_text(&certificate.issued_at, &mut output);
    frame_text(
        certificate.expires_at.as_deref().unwrap_or_default(),
        &mut output,
    );
    output
}

pub fn verify_device_signature(
    certificate: &DeviceCertificate,
    public_key: &str,
    signature: &str,
    message: &[u8],
    asserted_identity_id: &str,
    asserted_device_id: &str,
) -> bool {
    if certificate.version != PROTOCOL_VERSION
        || certificate.identity_id != asserted_identity_id
        || certificate.device_id != asserted_device_id
        || certificate.signing_public_key != public_key
        || certificate.issuance_sequence == 0
        || certificate.issued_at.is_empty()
        || certificate.issued_at.len() > 64
        || certificate
            .expires_at
            .as_ref()
            .is_some_and(|expires_at| expires_at.is_empty() || expires_at.len() > 64)
    {
        return false;
    }

    let Ok(root_public_key): Result<[u8; 32], _> = URL_SAFE_NO_PAD
        .decode(&certificate.root_public_key)
        .and_then(|bytes| {
            bytes
                .try_into()
                .map_err(|_| base64::DecodeError::InvalidLength(0))
        })
    else {
        return false;
    };
    let Ok(signing_public_key): Result<[u8; 32], _> =
        URL_SAFE_NO_PAD.decode(public_key).and_then(|bytes| {
            bytes
                .try_into()
                .map_err(|_| base64::DecodeError::InvalidLength(0))
        })
    else {
        return false;
    };
    let Ok(_encryption_public_key): Result<[u8; 32], _> = URL_SAFE_NO_PAD
        .decode(&certificate.encryption_public_key)
        .and_then(|bytes| {
            bytes
                .try_into()
                .map_err(|_| base64::DecodeError::InvalidLength(0))
        })
    else {
        return false;
    };
    if hex::encode(Sha256::digest(root_public_key)) != asserted_identity_id {
        return false;
    }
    let Ok(certificate_signature): Result<[u8; 64], _> = URL_SAFE_NO_PAD
        .decode(&certificate.signature)
        .and_then(|bytes| {
            bytes
                .try_into()
                .map_err(|_| base64::DecodeError::InvalidLength(0))
        })
    else {
        return false;
    };
    let Ok(root_key) = VerifyingKey::from_bytes(&root_public_key) else {
        return false;
    };
    if root_key
        .verify(
            &canonical_device_certificate_bytes(certificate),
            &Signature::from_bytes(&certificate_signature),
        )
        .is_err()
    {
        return false;
    }

    let Ok(operation_signature): Result<[u8; 64], _> =
        URL_SAFE_NO_PAD.decode(signature).and_then(|bytes| {
            bytes
                .try_into()
                .map_err(|_| base64::DecodeError::InvalidLength(0))
        })
    else {
        return false;
    };
    VerifyingKey::from_bytes(&signing_public_key)
        .and_then(|key| key.verify(message, &Signature::from_bytes(&operation_signature)))
        .is_ok()
}

#[cfg(test)]
pub(crate) fn test_device_certificate(
    root_key: &ed25519_dalek::SigningKey,
    device_key: &ed25519_dalek::SigningKey,
    device_id: &str,
) -> DeviceCertificate {
    test_device_certificate_with_encryption(
        root_key,
        device_key,
        device_id,
        URL_SAFE_NO_PAD.encode([99_u8; 32]),
    )
}

#[cfg(test)]
pub(crate) fn test_device_certificate_with_encryption(
    root_key: &ed25519_dalek::SigningKey,
    device_key: &ed25519_dalek::SigningKey,
    device_id: &str,
    encryption_public_key: String,
) -> DeviceCertificate {
    use ed25519_dalek::Signer as _;

    let root_public_key = root_key.verifying_key().to_bytes();
    let mut certificate = DeviceCertificate {
        version: PROTOCOL_VERSION,
        identity_id: hex::encode(Sha256::digest(root_public_key)),
        device_id: device_id.into(),
        root_public_key: URL_SAFE_NO_PAD.encode(root_public_key),
        signing_public_key: URL_SAFE_NO_PAD.encode(device_key.verifying_key().to_bytes()),
        encryption_public_key,
        issuance_sequence: 1,
        issued_at: "2026-07-26T12:00:00.000Z".into(),
        expires_at: None,
        signature: String::new(),
    };
    certificate.signature = URL_SAFE_NO_PAD.encode(
        root_key
            .sign(&canonical_device_certificate_bytes(&certificate))
            .to_bytes(),
    );
    certificate
}

pub fn canonical_message_bytes(operation: &MessageOperation) -> Vec<u8> {
    let mut output = Vec::with_capacity(operation.content.len() + 512);
    frame(b"nexus:message-operation:v2", &mut output);
    frame_number(operation.protocol_version, &mut output);
    frame_text(&operation.operation_id, &mut output);
    frame_text(&operation.message_id, &mut output);
    frame_text(&operation.channel_id, &mut output);
    frame_text(&operation.author_id, &mut output);
    frame_text(&operation.author_device_id, &mut output);
    frame_number(operation.actor_sequence, &mut output);
    frame_text(&operation.created_at, &mut output);
    frame_text(&operation.client_generated_order, &mut output);
    frame_text(&operation.content, &mut output);
    frame_text(
        operation.reply_to.as_deref().unwrap_or_default(),
        &mut output,
    );
    frame_text(&operation.attachment_references.join("\u{1f}"), &mut output);
    let encryption = operation
        .encryption_metadata
        .as_ref()
        .map(|metadata| format!("{}:{}", metadata.suite, metadata.epoch))
        .unwrap_or_default();
    frame_text(&encryption, &mut output);
    frame_number(operation.edit_version, &mut output);
    frame_bool(operation.deletion_tombstone, &mut output);
    output
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

pub fn verify_operation(operation: &MessageOperation) -> Result<(), ProtocolError> {
    let encoded = serde_json::to_vec(operation)
        .map_err(|error| ProtocolError::Malformed(error.to_string()))?;
    if encoded.len() > MAX_MESSAGE_OPERATION_BYTES {
        return Err(ProtocolError::Malformed("operation is too large".into()));
    }
    if operation.protocol_version != PROTOCOL_VERSION
        || !valid_ulid(&operation.operation_id)
        || !valid_ulid(&operation.message_id)
        || !valid_ulid(&operation.channel_id)
        || !valid_ulid(&operation.client_generated_order)
        || operation.actor_sequence == 0
        || operation.author_device_id.is_empty()
        || operation.author_device_id.len() > 128
        || operation.created_at.is_empty()
        || operation.created_at.len() > 64
        || operation.content.len() > MAX_MESSAGE_CONTENT_BYTES
        || operation.attachment_references.len() > 8
        || operation
            .attachment_references
            .iter()
            .any(|reference| reference.len() < 16 || reference.len() > 256)
    {
        return Err(ProtocolError::Malformed(
            "operation field is outside its validated bounds".into(),
        ));
    }

    if !verify_device_signature(
        &operation.device_certificate,
        &operation.public_key,
        &operation.signature,
        &canonical_message_bytes(operation),
        &operation.author_id,
        &operation.author_device_id,
    ) {
        return Err(ProtocolError::InvalidSignature);
    }
    Ok(())
}

fn winning_operation<'a>(
    left: &'a MessageOperation,
    right: &'a MessageOperation,
) -> &'a MessageOperation {
    if left.edit_version != right.edit_version {
        return if left.edit_version > right.edit_version {
            left
        } else {
            right
        };
    }
    if left.deletion_tombstone != right.deletion_tombstone {
        return if left.deletion_tombstone { left } else { right };
    }
    if left.operation_id >= right.operation_id {
        left
    } else {
        right
    }
}

pub fn apply_operation(
    state: &mut SegmentState,
    operation: MessageOperation,
) -> Result<(), ProtocolError> {
    verify_operation(&operation)?;
    if state.seen_operation_ids.contains(&operation.operation_id) {
        return Ok(());
    }
    state
        .seen_operation_ids
        .insert(operation.operation_id.clone());
    match state.messages.get(&operation.message_id) {
        Some(current) if winning_operation(current, &operation) == current => {}
        _ => {
            state
                .messages
                .insert(operation.message_id.clone(), operation);
        }
    }
    normalize_state(state);
    ensure_state_size(state)
}

pub fn merge_states(
    destination: &mut SegmentState,
    source: SegmentState,
) -> Result<(), ProtocolError> {
    for operation in source.messages.into_values() {
        apply_operation(destination, operation)?;
    }
    destination
        .seen_operation_ids
        .extend(source.seen_operation_ids);
    normalize_state(destination);
    ensure_state_size(destination)
}

pub fn validate_state(state: &SegmentState) -> Result<(), ProtocolError> {
    if state.schema_version != PROTOCOL_VERSION {
        return Err(ProtocolError::Malformed(
            "unsupported segment schema".into(),
        ));
    }
    for (message_id, operation) in &state.messages {
        if message_id != &operation.message_id
            || !state.seen_operation_ids.contains(&operation.operation_id)
        {
            return Err(ProtocolError::Malformed(
                "state index does not match its signed operation".into(),
            ));
        }
        verify_operation(operation)?;
    }
    ensure_state_size(state)
}

pub fn summarize(state: &SegmentState) -> SegmentSummary {
    SegmentSummary {
        message_versions: state
            .messages
            .iter()
            .map(|(message_id, operation)| (message_id.clone(), operation.operation_id.clone()))
            .collect(),
    }
}

pub fn delta_for(state: &SegmentState, remote: &SegmentSummary) -> SegmentDelta {
    SegmentDelta {
        operations: state
            .messages
            .iter()
            .filter_map(|(message_id, operation)| {
                (remote.message_versions.get(message_id) != Some(&operation.operation_id))
                    .then_some(operation.clone())
            })
            .collect(),
    }
}

pub fn normalize_state(state: &mut SegmentState) {
    state.schema_version = PROTOCOL_VERSION;
    if state.messages.len() > SEGMENT_MESSAGE_TARGET {
        let mut ranked: Vec<_> = state
            .messages
            .iter()
            .map(|(message_id, operation)| {
                (operation.client_generated_order.clone(), message_id.clone())
            })
            .collect();
        ranked.sort();
        let remove_count = ranked.len() - SEGMENT_MESSAGE_TARGET;
        for (_, message_id) in ranked.into_iter().take(remove_count) {
            state.messages.remove(&message_id);
        }
    }
    while state.seen_operation_ids.len() > MAX_SEEN_OPERATION_IDS {
        let Some(first) = state.seen_operation_ids.first().cloned() else {
            break;
        };
        state.seen_operation_ids.remove(&first);
    }
}

fn ensure_state_size(state: &SegmentState) -> Result<(), ProtocolError> {
    let bytes =
        serde_json::to_vec(state).map_err(|error| ProtocolError::Malformed(error.to_string()))?;
    if bytes.len() > SEGMENT_STATE_HARD_LIMIT {
        return Err(ProtocolError::StateTooLarge);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::{Signer, SigningKey};

    fn signed_operation(
        signing_key: &SigningKey,
        message_id: &str,
        operation_id: &str,
        content: &str,
        edit_version: u64,
        deleted: bool,
    ) -> MessageOperation {
        let public_key = signing_key.verifying_key().to_bytes();
        let mut operation = MessageOperation {
            protocol_version: PROTOCOL_VERSION,
            operation_id: operation_id.into(),
            message_id: message_id.into(),
            channel_id: "01K10KJ6P20S58KQBV5P4E3T9C".into(),
            author_id: hex::encode(Sha256::digest(public_key)),
            author_device_id: "01K10KJ6P20S58KQBV5P4E3T9D".into(),
            actor_sequence: edit_version + 1,
            created_at: "2026-07-26T12:00:00.000Z".into(),
            client_generated_order: operation_id.into(),
            content: content.into(),
            reply_to: None,
            attachment_references: vec![],
            encryption_metadata: None,
            edit_version,
            deletion_tombstone: deleted,
            public_key: URL_SAFE_NO_PAD.encode(public_key),
            device_certificate: test_device_certificate(
                signing_key,
                signing_key,
                "01K10KJ6P20S58KQBV5P4E3T9D",
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

    #[test]
    fn opposite_update_orders_converge() {
        let key = SigningKey::from_bytes(&[7; 32]);
        let first = signed_operation(
            &key,
            "01K10KJ6P20S58KQBV5P4E3T91",
            "01K10KJ6P20S58KQBV5P4E3TA1",
            "first",
            0,
            false,
        );
        let second = signed_operation(
            &key,
            "01K10KJ6P20S58KQBV5P4E3T92",
            "01K10KJ6P20S58KQBV5P4E3TA2",
            "second",
            0,
            false,
        );
        let mut forward = SegmentState::default();
        apply_operation(&mut forward, first.clone()).unwrap();
        apply_operation(&mut forward, second.clone()).unwrap();
        let mut reverse = SegmentState::default();
        apply_operation(&mut reverse, second).unwrap();
        apply_operation(&mut reverse, first).unwrap();
        assert_eq!(forward, reverse);
    }

    #[test]
    fn deletion_wins_equal_edit_version() {
        let key = SigningKey::from_bytes(&[8; 32]);
        let message_id = "01K10KJ6P20S58KQBV5P4E3T93";
        let visible = signed_operation(
            &key,
            message_id,
            "01K10KJ6P20S58KQBV5P4E3TA3",
            "visible",
            2,
            false,
        );
        let deleted = signed_operation(&key, message_id, "01K10KJ6P20S58KQBV5P4E3TA4", "", 2, true);
        let mut state = SegmentState::default();
        apply_operation(&mut state, visible).unwrap();
        apply_operation(&mut state, deleted).unwrap();
        assert!(state.messages[message_id].deletion_tombstone);
    }

    #[test]
    fn invalid_signature_is_rejected() {
        let key = SigningKey::from_bytes(&[9; 32]);
        let mut operation = signed_operation(
            &key,
            "01K10KJ6P20S58KQBV5P4E3T94",
            "01K10KJ6P20S58KQBV5P4E3TA5",
            "signed",
            0,
            false,
        );
        operation.content = "tampered".into();
        assert_eq!(
            verify_operation(&operation),
            Err(ProtocolError::InvalidSignature)
        );
    }

    #[test]
    fn root_certified_device_is_accepted_and_cannot_claim_a_sibling_id() {
        let root = SigningKey::from_bytes(&[31; 32]);
        let device = SigningKey::from_bytes(&[32; 32]);
        let mut operation = signed_operation(
            &device,
            "01K10KJ6P20S58KQBV5P4E3T96",
            "01K10KJ6P20S58KQBV5P4E3TA6",
            "certified device",
            0,
            false,
        );
        operation.author_id = hex::encode(Sha256::digest(root.verifying_key().to_bytes()));
        operation.device_certificate =
            test_device_certificate(&root, &device, "01K10KJ6P20S58KQBV5P4E3T9D");
        operation.signature =
            URL_SAFE_NO_PAD.encode(device.sign(&canonical_message_bytes(&operation)).to_bytes());
        assert_eq!(verify_operation(&operation), Ok(()));

        operation.author_device_id = "01K10KJ6P20S58KQBV5P4E3T9E".into();
        operation.signature =
            URL_SAFE_NO_PAD.encode(device.sign(&canonical_message_bytes(&operation)).to_bytes());
        assert_eq!(
            verify_operation(&operation),
            Err(ProtocolError::InvalidSignature)
        );
    }

    #[test]
    fn browser_generated_protocol_v2_signature_is_accepted() {
        let operation: MessageOperation = serde_json::from_str(include_str!(
            "../../../tests/fixtures/protocol-v2-message.json"
        ))
        .unwrap();
        assert_eq!(verify_operation(&operation), Ok(()));
    }

    #[test]
    fn summary_delta_repairs_a_replica() {
        let key = SigningKey::from_bytes(&[10; 32]);
        let first = signed_operation(
            &key,
            "01K10KJ6P20S58KQBV5P4E3T95",
            "01K10KJ6P20S58KQBV5P4E3TA6",
            "first",
            0,
            false,
        );
        let second = signed_operation(
            &key,
            "01K10KJ6P20S58KQBV5P4E3T96",
            "01K10KJ6P20S58KQBV5P4E3TA7",
            "second",
            0,
            false,
        );
        let mut source = SegmentState::default();
        apply_operation(&mut source, first.clone()).unwrap();
        apply_operation(&mut source, second).unwrap();
        let mut destination = SegmentState::default();
        apply_operation(&mut destination, first).unwrap();
        for operation in delta_for(&source, &summarize(&destination)).operations {
            apply_operation(&mut destination, operation).unwrap();
        }
        assert_eq!(source, destination);
    }
}
