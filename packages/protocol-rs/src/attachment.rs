use std::collections::{BTreeMap, BTreeSet};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use thiserror::Error;

use crate::{DeviceCertificate, PROTOCOL_VERSION, verify_device_signature};

pub const ATTACHMENT_CHUNK_BYTES: u64 = 256 * 1024;
pub const MAX_ATTACHMENT_BYTES: u64 = 25 * 1024 * 1024;
pub const MAX_ATTACHMENT_STORED_CHUNK_BYTES: u64 =
    (ATTACHMENT_CHUNK_BYTES + 16).div_ceil(3) * 4 + 512;
pub const MAX_ATTACHMENT_CHUNKS: usize = (MAX_ATTACHMENT_BYTES / ATTACHMENT_CHUNK_BYTES) as usize;
pub const MAX_ATTACHMENT_INDEX_ENTRIES: usize = 1024;
pub const ATTACHMENT_INDEX_STATE_HARD_LIMIT: usize = 8 * 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AttachmentChunk {
    pub index: u64,
    pub plaintext_bytes: u64,
    pub stored_bytes: u64,
    pub sha256: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AttachmentManifest {
    pub version: u64,
    pub attachment_id: String,
    pub file_name: String,
    pub media_type: String,
    pub total_bytes: u64,
    pub content_sha256: String,
    pub chunk_bytes: u64,
    pub encrypted: bool,
    pub chunks: Vec<AttachmentChunk>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AttachmentIndexOperation {
    pub protocol_version: u64,
    pub operation_id: String,
    pub target_id: String,
    pub author_id: String,
    pub author_device_id: String,
    pub actor_sequence: u64,
    pub reference: String,
    pub manifest: AttachmentManifest,
    pub created_at: String,
    pub public_key: String,
    pub device_certificate: DeviceCertificate,
    pub signature: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AttachmentIndexState {
    pub schema_version: u64,
    #[serde(default)]
    pub attachments: BTreeMap<String, AttachmentIndexOperation>,
    #[serde(default)]
    pub seen_operation_ids: BTreeSet<String>,
}

impl Default for AttachmentIndexState {
    fn default() -> Self {
        Self {
            schema_version: PROTOCOL_VERSION,
            attachments: BTreeMap::new(),
            seen_operation_ids: BTreeSet::new(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct AttachmentIndexSummary {
    #[serde(default)]
    pub attachment_versions: BTreeMap<String, String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct AttachmentIndexDelta {
    #[serde(default)]
    pub operations: Vec<AttachmentIndexOperation>,
}

#[derive(Debug, Error, PartialEq, Eq)]
pub enum AttachmentProtocolError {
    #[error("malformed attachment index operation: {0}")]
    Malformed(String),
    #[error("invalid attachment index signature")]
    InvalidSignature,
    #[error("attachment index entry limit reached")]
    EntryLimit,
    #[error("attachment index state exceeds the hard size limit")]
    StateTooLarge,
}

pub fn canonical_attachment_index_bytes(operation: &AttachmentIndexOperation) -> Vec<u8> {
    let fields = [
        operation.protocol_version.to_string(),
        operation.operation_id.clone(),
        operation.target_id.clone(),
        operation.author_id.clone(),
        operation.author_device_id.clone(),
        operation.actor_sequence.to_string(),
        operation.reference.clone(),
        operation.created_at.clone(),
    ];
    let mut output = Vec::with_capacity(1024);
    frame(b"nexus:attachment-index-operation:v2", &mut output);
    for field in fields {
        frame(field.as_bytes(), &mut output);
    }
    output
}

pub fn verify_attachment_index_operation(
    operation: &AttachmentIndexOperation,
) -> Result<(), AttachmentProtocolError> {
    let encoded = serde_json::to_vec(operation)
        .map_err(|error| AttachmentProtocolError::Malformed(error.to_string()))?;
    if encoded.len() > 128 * 1024
        || operation.protocol_version != PROTOCOL_VERSION
        || !valid_ulid(&operation.operation_id)
        || !valid_ulid(&operation.target_id)
        || operation.author_id.len() != 64
        || !operation
            .author_id
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit())
        || operation.author_device_id.is_empty()
        || operation.author_device_id.len() > 128
        || operation.actor_sequence == 0
        || operation.created_at.is_empty()
        || operation.created_at.len() > 64
    {
        return Err(AttachmentProtocolError::Malformed(
            "attachment index field is outside its validated bounds".into(),
        ));
    }
    validate_attachment_manifest(&operation.reference, &operation.manifest)?;

    if !verify_device_signature(
        &operation.device_certificate,
        &operation.public_key,
        &operation.signature,
        &canonical_attachment_index_bytes(operation),
        &operation.author_id,
        &operation.author_device_id,
    ) {
        return Err(AttachmentProtocolError::InvalidSignature);
    }
    Ok(())
}

pub fn validate_attachment_manifest(
    reference: &str,
    manifest: &AttachmentManifest,
) -> Result<(), AttachmentProtocolError> {
    if manifest.version != PROTOCOL_VERSION
        || !valid_ulid(&manifest.attachment_id)
        || manifest.file_name.trim().is_empty()
        || manifest.file_name.len() > 255
        || manifest.media_type.len() > 128
        || manifest.total_bytes > MAX_ATTACHMENT_BYTES
        || manifest.chunk_bytes != ATTACHMENT_CHUNK_BYTES
        || manifest.chunks.is_empty()
        || manifest.chunks.len() > MAX_ATTACHMENT_CHUNKS
        || !valid_hash(&manifest.content_sha256)
    {
        return Err(AttachmentProtocolError::Malformed(
            "attachment manifest metadata is invalid".into(),
        ));
    }
    let mut total = 0_u64;
    for (index, chunk) in manifest.chunks.iter().enumerate() {
        if chunk.index != index as u64
            || chunk.plaintext_bytes > ATTACHMENT_CHUNK_BYTES
            || (manifest.total_bytes > 0 && chunk.plaintext_bytes == 0)
            || chunk.stored_bytes > MAX_ATTACHMENT_STORED_CHUNK_BYTES
            || !valid_hash(&chunk.sha256)
        {
            return Err(AttachmentProtocolError::Malformed(
                "attachment chunk manifest is invalid".into(),
            ));
        }
        total = total
            .checked_add(chunk.plaintext_bytes)
            .ok_or_else(|| AttachmentProtocolError::Malformed("attachment size overflow".into()))?;
    }
    if total != manifest.total_bytes {
        return Err(AttachmentProtocolError::Malformed(
            "attachment chunk lengths do not match the total".into(),
        ));
    }
    let manifest_bytes = serde_json::to_vec(manifest)
        .map_err(|error| AttachmentProtocolError::Malformed(error.to_string()))?;
    let expected = format!(
        "nexus-attachment:{}",
        hex::encode(Sha256::digest(manifest_bytes))
    );
    if reference != expected {
        return Err(AttachmentProtocolError::Malformed(
            "attachment reference does not match its manifest".into(),
        ));
    }
    Ok(())
}

pub fn apply_attachment_index_operation(
    state: &mut AttachmentIndexState,
    operation: AttachmentIndexOperation,
) -> Result<(), AttachmentProtocolError> {
    verify_attachment_index_operation(&operation)?;
    if state.seen_operation_ids.contains(&operation.operation_id) {
        return Ok(());
    }
    if state.attachments.len() >= MAX_ATTACHMENT_INDEX_ENTRIES
        && !state.attachments.contains_key(&operation.reference)
    {
        return Err(AttachmentProtocolError::EntryLimit);
    }
    state
        .seen_operation_ids
        .insert(operation.operation_id.clone());
    match state.attachments.get(&operation.reference) {
        Some(current) if current.operation_id >= operation.operation_id => {}
        _ => {
            state
                .attachments
                .insert(operation.reference.clone(), operation);
        }
    }
    ensure_attachment_index_size(state)
}

pub fn merge_attachment_index_states(
    destination: &mut AttachmentIndexState,
    source: AttachmentIndexState,
) -> Result<(), AttachmentProtocolError> {
    for operation in source.attachments.into_values() {
        apply_attachment_index_operation(destination, operation)?;
    }
    destination
        .seen_operation_ids
        .extend(source.seen_operation_ids);
    while destination.seen_operation_ids.len() > 4096 {
        let Some(first) = destination.seen_operation_ids.first().cloned() else {
            break;
        };
        destination.seen_operation_ids.remove(&first);
    }
    ensure_attachment_index_size(destination)
}

pub fn validate_attachment_index_state(
    state: &AttachmentIndexState,
) -> Result<(), AttachmentProtocolError> {
    if state.schema_version != PROTOCOL_VERSION
        || state.attachments.len() > MAX_ATTACHMENT_INDEX_ENTRIES
        || state.seen_operation_ids.len() > 4096
    {
        return Err(AttachmentProtocolError::Malformed(
            "attachment index state bounds are invalid".into(),
        ));
    }
    for (reference, operation) in &state.attachments {
        if reference != &operation.reference
            || !state.seen_operation_ids.contains(&operation.operation_id)
        {
            return Err(AttachmentProtocolError::Malformed(
                "attachment index does not match its signed operation".into(),
            ));
        }
        verify_attachment_index_operation(operation)?;
    }
    ensure_attachment_index_size(state)
}

pub fn summarize_attachment_index(state: &AttachmentIndexState) -> AttachmentIndexSummary {
    AttachmentIndexSummary {
        attachment_versions: state
            .attachments
            .iter()
            .map(|(reference, operation)| (reference.clone(), operation.operation_id.clone()))
            .collect(),
    }
}

pub fn attachment_index_delta_for(
    state: &AttachmentIndexState,
    remote: &AttachmentIndexSummary,
) -> AttachmentIndexDelta {
    AttachmentIndexDelta {
        operations: state
            .attachments
            .iter()
            .filter_map(|(reference, operation)| {
                (remote.attachment_versions.get(reference) != Some(&operation.operation_id))
                    .then_some(operation.clone())
            })
            .collect(),
    }
}

fn valid_hash(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || matches!(byte, b'a'..=b'f'))
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

fn frame(bytes: &[u8], output: &mut Vec<u8>) {
    output.extend_from_slice(&(bytes.len() as u32).to_be_bytes());
    output.extend_from_slice(bytes);
}

fn ensure_attachment_index_size(
    state: &AttachmentIndexState,
) -> Result<(), AttachmentProtocolError> {
    let bytes = serde_json::to_vec(state)
        .map_err(|error| AttachmentProtocolError::Malformed(error.to_string()))?;
    if bytes.len() > ATTACHMENT_INDEX_STATE_HARD_LIMIT {
        return Err(AttachmentProtocolError::StateTooLarge);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
    use ed25519_dalek::{Signer, SigningKey};

    fn operation(key: &SigningKey) -> AttachmentIndexOperation {
        let manifest = AttachmentManifest {
            version: PROTOCOL_VERSION,
            attachment_id: "01K10KJ6P20S58KQBV5P4E3TD1".into(),
            file_name: "orbit.txt".into(),
            media_type: "text/plain".into(),
            total_bytes: 5,
            content_sha256: hex::encode(Sha256::digest(b"orbit")),
            chunk_bytes: ATTACHMENT_CHUNK_BYTES,
            encrypted: false,
            chunks: vec![AttachmentChunk {
                index: 0,
                plaintext_bytes: 5,
                stored_bytes: 5,
                sha256: hex::encode(Sha256::digest(b"orbit")),
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
            author_device_id: "attachment-device".into(),
            actor_sequence: 1,
            reference,
            manifest,
            created_at: "2026-07-26T12:00:00.000Z".into(),
            public_key: URL_SAFE_NO_PAD.encode(public_key),
            device_certificate: crate::test_device_certificate(key, key, "attachment-device"),
            signature: String::new(),
        };
        operation.signature = URL_SAFE_NO_PAD.encode(
            key.sign(&canonical_attachment_index_bytes(&operation))
                .to_bytes(),
        );
        operation
    }

    #[test]
    fn accepts_a_signed_content_addressed_manifest() {
        let key = SigningKey::from_bytes(&[61; 32]);
        let mut state = AttachmentIndexState::default();
        let operation = operation(&key);
        apply_attachment_index_operation(&mut state, operation.clone()).unwrap();
        assert_eq!(
            state.attachments[&operation.reference].manifest.file_name,
            "orbit.txt"
        );
        validate_attachment_index_state(&state).unwrap();
    }

    #[test]
    fn rejects_a_manifest_modified_after_reference_creation() {
        let key = SigningKey::from_bytes(&[62; 32]);
        let mut operation = operation(&key);
        operation.manifest.file_name = "tampered.txt".into();
        assert!(matches!(
            verify_attachment_index_operation(&operation),
            Err(AttachmentProtocolError::Malformed(_))
                | Err(AttachmentProtocolError::InvalidSignature)
        ));
    }
}
