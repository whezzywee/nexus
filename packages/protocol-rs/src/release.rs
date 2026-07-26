use std::collections::{BTreeMap, BTreeSet};

use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use ed25519_dalek::{Signature, Verifier, VerifyingKey};
use semver::Version;
use serde::{Deserialize, Serialize};
use thiserror::Error;

pub const RELEASE_SCHEMA_VERSION: u64 = 1;

pub const MAX_RELEASES: usize = 128;
pub const RELEASE_STATE_HARD_LIMIT: usize = 2 * 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReleaseArtifact {
    pub name: String,
    pub platform: String,
    pub bytes: u64,
    pub sha256: String,
    pub url: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReleaseRecord {
    pub schema_version: u64,
    pub release_id: String,
    pub product: String,
    pub version: String,
    pub published_at: String,
    pub core_compatibility: String,
    #[serde(default)]
    pub artifacts: Vec<ReleaseArtifact>,
    pub signer_public_key: String,
    pub signature: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReleaseRevocation {
    pub schema_version: u64,
    pub revocation_id: String,
    pub release_id: String,
    pub reason: String,
    pub created_at: String,
    pub signer_public_key: String,
    pub signature: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CoreCompatibilityPin {
    pub schema_version: u64,
    pub pin_id: String,
    pub release_id: String,
    pub current_core_compatibility: String,
    pub next_core_compatibility: String,
    pub created_at: String,
    pub signer_public_key: String,
    pub signature: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReleaseState {
    pub schema_version: u64,
    pub product: String,
    pub trust_root_public_key: String,
    #[serde(default)]
    pub releases: BTreeMap<String, ReleaseRecord>,
    #[serde(default)]
    pub revocations: BTreeMap<String, ReleaseRevocation>,
    #[serde(default)]
    pub compatibility_pins: BTreeMap<String, CoreCompatibilityPin>,
}

impl ReleaseState {
    pub fn new(product: String, trust_root_public_key: String) -> Self {
        Self {
            schema_version: RELEASE_SCHEMA_VERSION,
            product,
            trust_root_public_key,
            releases: BTreeMap::new(),
            revocations: BTreeMap::new(),
            compatibility_pins: BTreeMap::new(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ReleaseSummary {
    #[serde(default)]
    pub release_ids: BTreeSet<String>,
    #[serde(default)]
    pub revocation_ids: BTreeSet<String>,
    #[serde(default)]
    pub compatibility_pin_ids: BTreeSet<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ReleaseDelta {
    #[serde(default)]
    pub releases: Vec<ReleaseRecord>,
    #[serde(default)]
    pub revocations: Vec<ReleaseRevocation>,
    #[serde(default)]
    pub compatibility_pins: Vec<CoreCompatibilityPin>,
}

#[derive(Debug, Error, PartialEq, Eq)]
pub enum ReleaseProtocolError {
    #[error("malformed release state or record: {0}")]
    Malformed(String),
    #[error("release signature is invalid or not from the trust root")]
    InvalidSignature,
    #[error("release record limit reached")]
    ReleaseLimit,
    #[error("release state exceeds the hard size limit")]
    StateTooLarge,
}

pub fn canonical_release_bytes(record: &ReleaseRecord) -> Vec<u8> {
    let mut artifacts = record.artifacts.clone();
    artifacts.sort();
    let artifact_records = artifacts
        .iter()
        .map(|artifact| {
            [
                artifact.name.as_str(),
                artifact.platform.as_str(),
                &artifact.bytes.to_string(),
                artifact.sha256.as_str(),
                artifact.url.as_str(),
            ]
            .join("\u{1f}")
        })
        .collect::<Vec<_>>()
        .join("\u{1e}");
    let fields = [
        "nexus:release-record:v1".to_string(),
        record.schema_version.to_string(),
        record.release_id.clone(),
        record.product.clone(),
        record.version.clone(),
        record.published_at.clone(),
        record.core_compatibility.clone(),
        artifact_records,
    ];
    frame_fields(fields)
}

pub fn canonical_revocation_bytes(record: &ReleaseRevocation) -> Vec<u8> {
    frame_fields([
        "nexus:release-revocation:v1".to_string(),
        record.schema_version.to_string(),
        record.revocation_id.clone(),
        record.release_id.clone(),
        record.reason.clone(),
        record.created_at.clone(),
    ])
}

pub fn canonical_core_compatibility_pin_bytes(record: &CoreCompatibilityPin) -> Vec<u8> {
    frame_fields([
        "nexus:core-compatibility-pin:v1".to_string(),
        record.schema_version.to_string(),
        record.pin_id.clone(),
        record.release_id.clone(),
        record.current_core_compatibility.clone(),
        record.next_core_compatibility.clone(),
        record.created_at.clone(),
    ])
}

pub fn verify_release_record(
    trust_root: &str,
    product: &str,
    record: &ReleaseRecord,
) -> Result<(), ReleaseProtocolError> {
    if record.schema_version != RELEASE_SCHEMA_VERSION
        || !valid_ulid(&record.release_id)
        || record.product != product
        || record.product.is_empty()
        || record.product.len() > 64
        || !valid_version(&record.version)
        || record.published_at.is_empty()
        || record.published_at.len() > 64
        || record.core_compatibility.is_empty()
        || record.core_compatibility.len() > 64
        || record.artifacts.is_empty()
        || record.artifacts.len() > 32
    {
        return Err(ReleaseProtocolError::Malformed(
            "release record metadata is invalid".into(),
        ));
    }
    let mut names = BTreeSet::new();
    for artifact in &record.artifacts {
        if artifact.name.is_empty()
            || artifact.name.len() > 255
            || artifact.platform.is_empty()
            || artifact.platform.len() > 64
            || artifact.bytes == 0
            || !valid_hash(&artifact.sha256)
            || (!artifact.url.starts_with("https://")
                && !artifact.url.starts_with("nexus-artifact:"))
            || !names.insert((&artifact.name, &artifact.platform))
        {
            return Err(ReleaseProtocolError::Malformed(
                "release artifact metadata is invalid".into(),
            ));
        }
    }
    verify_root_signature(
        trust_root,
        &record.signer_public_key,
        &record.signature,
        &canonical_release_bytes(record),
    )
}

pub fn verify_release_revocation(
    trust_root: &str,
    record: &ReleaseRevocation,
) -> Result<(), ReleaseProtocolError> {
    if record.schema_version != RELEASE_SCHEMA_VERSION
        || !valid_ulid(&record.revocation_id)
        || !valid_ulid(&record.release_id)
        || record.reason.is_empty()
        || record.reason.len() > 512
        || record.created_at.is_empty()
        || record.created_at.len() > 64
    {
        return Err(ReleaseProtocolError::Malformed(
            "release revocation metadata is invalid".into(),
        ));
    }
    verify_root_signature(
        trust_root,
        &record.signer_public_key,
        &record.signature,
        &canonical_revocation_bytes(record),
    )
}

pub fn verify_core_compatibility_pin(
    trust_root: &str,
    record: &CoreCompatibilityPin,
) -> Result<(), ReleaseProtocolError> {
    if record.schema_version != RELEASE_SCHEMA_VERSION
        || !valid_ulid(&record.pin_id)
        || !valid_ulid(&record.release_id)
        || !valid_version(&record.current_core_compatibility)
        || !valid_version(&record.next_core_compatibility)
        || record.current_core_compatibility == record.next_core_compatibility
        || record.created_at.is_empty()
        || record.created_at.len() > 64
    {
        return Err(ReleaseProtocolError::Malformed(
            "Core compatibility pin metadata is invalid".into(),
        ));
    }
    verify_root_signature(
        trust_root,
        &record.signer_public_key,
        &record.signature,
        &canonical_core_compatibility_pin_bytes(record),
    )
}

pub fn apply_release_record(
    state: &mut ReleaseState,
    record: ReleaseRecord,
) -> Result<(), ReleaseProtocolError> {
    verify_release_record(&state.trust_root_public_key, &state.product, &record)?;
    if state.releases.contains_key(&record.release_id) {
        return Ok(());
    }
    if state.releases.len() >= MAX_RELEASES {
        return Err(ReleaseProtocolError::ReleaseLimit);
    }
    state.releases.insert(record.release_id.clone(), record);
    ensure_release_size(state)
}

pub fn apply_release_revocation(
    state: &mut ReleaseState,
    record: ReleaseRevocation,
) -> Result<(), ReleaseProtocolError> {
    verify_release_revocation(&state.trust_root_public_key, &record)?;
    if !state.releases.contains_key(&record.release_id) {
        return Err(ReleaseProtocolError::Malformed(
            "release revocation targets an unknown release".into(),
        ));
    }
    if !state.revocations.contains_key(&record.revocation_id)
        && state.revocations.len() >= MAX_RELEASES
    {
        return Err(ReleaseProtocolError::ReleaseLimit);
    }
    state
        .revocations
        .insert(record.revocation_id.clone(), record);
    ensure_release_size(state)
}

pub fn apply_core_compatibility_pin(
    state: &mut ReleaseState,
    record: CoreCompatibilityPin,
) -> Result<(), ReleaseProtocolError> {
    verify_core_compatibility_pin(&state.trust_root_public_key, &record)?;
    if state.compatibility_pins.contains_key(&record.pin_id) {
        return Ok(());
    }
    if state.compatibility_pins.len() >= MAX_RELEASES {
        return Err(ReleaseProtocolError::ReleaseLimit);
    }
    state
        .compatibility_pins
        .insert(record.pin_id.clone(), record);
    ensure_release_size(state)
}

pub fn merge_release_states(
    destination: &mut ReleaseState,
    source: ReleaseState,
) -> Result<(), ReleaseProtocolError> {
    if destination.product != source.product
        || destination.trust_root_public_key != source.trust_root_public_key
    {
        return Err(ReleaseProtocolError::Malformed(
            "release trust root does not match".into(),
        ));
    }
    for release in source.releases.into_values() {
        apply_release_record(destination, release)?;
    }
    for revocation in source.revocations.into_values() {
        apply_release_revocation(destination, revocation)?;
    }
    for pin in source.compatibility_pins.into_values() {
        apply_core_compatibility_pin(destination, pin)?;
    }
    ensure_release_size(destination)
}

pub fn validate_release_state(state: &ReleaseState) -> Result<(), ReleaseProtocolError> {
    if state.schema_version != RELEASE_SCHEMA_VERSION
        || state.product.is_empty()
        || state.product.len() > 64
        || !matches!(
            URL_SAFE_NO_PAD.decode(&state.trust_root_public_key),
            Ok(bytes) if bytes.len() == 32
        )
        || state.releases.len() > MAX_RELEASES
        || state.revocations.len() > MAX_RELEASES
        || state.compatibility_pins.len() > MAX_RELEASES
    {
        return Err(ReleaseProtocolError::Malformed(
            "release state bootstrap is invalid".into(),
        ));
    }
    for (release_id, release) in &state.releases {
        if release_id != &release.release_id {
            return Err(ReleaseProtocolError::Malformed(
                "release index is invalid".into(),
            ));
        }
        verify_release_record(&state.trust_root_public_key, &state.product, release)?;
    }
    for (revocation_id, revocation) in &state.revocations {
        if revocation_id != &revocation.revocation_id
            || !state.releases.contains_key(&revocation.release_id)
        {
            return Err(ReleaseProtocolError::Malformed(
                "release revocation index is invalid".into(),
            ));
        }
        verify_release_revocation(&state.trust_root_public_key, revocation)?;
    }
    for (pin_id, pin) in &state.compatibility_pins {
        if pin_id != &pin.pin_id
            || state
                .releases
                .get(&pin.release_id)
                .is_none_or(|release| release.core_compatibility != pin.next_core_compatibility)
        {
            return Err(ReleaseProtocolError::Malformed(
                "Core compatibility pin index or target is invalid".into(),
            ));
        }
        verify_core_compatibility_pin(&state.trust_root_public_key, pin)?;
    }
    ensure_release_size(state)
}

pub fn summarize_releases(state: &ReleaseState) -> ReleaseSummary {
    ReleaseSummary {
        release_ids: state.releases.keys().cloned().collect(),
        revocation_ids: state.revocations.keys().cloned().collect(),
        compatibility_pin_ids: state.compatibility_pins.keys().cloned().collect(),
    }
}

pub fn release_delta_for(state: &ReleaseState, remote: &ReleaseSummary) -> ReleaseDelta {
    ReleaseDelta {
        releases: state
            .releases
            .iter()
            .filter_map(|(id, release)| {
                (!remote.release_ids.contains(id)).then_some(release.clone())
            })
            .collect(),
        revocations: state
            .revocations
            .iter()
            .filter_map(|(id, revocation)| {
                (!remote.revocation_ids.contains(id)).then_some(revocation.clone())
            })
            .collect(),
        compatibility_pins: state
            .compatibility_pins
            .iter()
            .filter_map(|(id, pin)| {
                (!remote.compatibility_pin_ids.contains(id)).then_some(pin.clone())
            })
            .collect(),
    }
}

fn verify_root_signature(
    trust_root: &str,
    signer: &str,
    signature: &str,
    message: &[u8],
) -> Result<(), ReleaseProtocolError> {
    if signer != trust_root {
        return Err(ReleaseProtocolError::InvalidSignature);
    }
    let key_bytes: [u8; 32] = URL_SAFE_NO_PAD
        .decode(signer)
        .map_err(|_| ReleaseProtocolError::InvalidSignature)?
        .try_into()
        .map_err(|_| ReleaseProtocolError::InvalidSignature)?;
    let signature_bytes: [u8; 64] = URL_SAFE_NO_PAD
        .decode(signature)
        .map_err(|_| ReleaseProtocolError::InvalidSignature)?
        .try_into()
        .map_err(|_| ReleaseProtocolError::InvalidSignature)?;
    VerifyingKey::from_bytes(&key_bytes)
        .map_err(|_| ReleaseProtocolError::InvalidSignature)?
        .verify(message, &Signature::from_bytes(&signature_bytes))
        .map_err(|_| ReleaseProtocolError::InvalidSignature)
}

fn frame_fields(fields: impl IntoIterator<Item = String>) -> Vec<u8> {
    let mut output = Vec::with_capacity(2048);
    for field in fields {
        output.extend_from_slice(&(field.len() as u32).to_be_bytes());
        output.extend_from_slice(field.as_bytes());
    }
    output
}

fn valid_hash(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || matches!(byte, b'a'..=b'f'))
}

fn valid_version(value: &str) -> bool {
    value.len() <= 64 && Version::parse(value).is_ok()
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

fn ensure_release_size(state: &ReleaseState) -> Result<(), ReleaseProtocolError> {
    if serde_json::to_vec(state)
        .map_err(|error| ReleaseProtocolError::Malformed(error.to_string()))?
        .len()
        > RELEASE_STATE_HARD_LIMIT
    {
        return Err(ReleaseProtocolError::StateTooLarge);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::{Signer, SigningKey};

    fn release(key: &SigningKey) -> ReleaseRecord {
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
                bytes: 42,
                sha256: "a".repeat(64),
                url: "https://updates.example/Nexus.exe".into(),
            }],
            signer_public_key: URL_SAFE_NO_PAD.encode(key.verifying_key().to_bytes()),
            signature: String::new(),
        };
        record.signature =
            URL_SAFE_NO_PAD.encode(key.sign(&canonical_release_bytes(&record)).to_bytes());
        record
    }

    #[test]
    fn accepts_root_signed_release_and_revocation() {
        let key = SigningKey::from_bytes(&[91; 32]);
        let public = URL_SAFE_NO_PAD.encode(key.verifying_key().to_bytes());
        let mut state = ReleaseState::new("Nexus".into(), public.clone());
        let release = release(&key);
        apply_release_record(&mut state, release.clone()).unwrap();
        let mut revocation = ReleaseRevocation {
            schema_version: 1,
            revocation_id: "01K10KJ6P20S58KQBV5P4E3TF2".into(),
            release_id: release.release_id.clone(),
            reason: "superseded after security review".into(),
            created_at: "2026-07-26T13:00:00.000Z".into(),
            signer_public_key: public.clone(),
            signature: String::new(),
        };
        revocation.signature = URL_SAFE_NO_PAD.encode(
            key.sign(&canonical_revocation_bytes(&revocation))
                .to_bytes(),
        );
        apply_release_revocation(&mut state, revocation).unwrap();
        let mut next = release.clone();
        next.release_id = "01K10KJ6P20S58KQBV5P4E3TF3".into();
        next.version = "0.3.0".into();
        next.core_compatibility = "0.2.108".into();
        next.signature =
            URL_SAFE_NO_PAD.encode(key.sign(&canonical_release_bytes(&next)).to_bytes());
        apply_release_record(&mut state, next.clone()).unwrap();
        let mut pin = CoreCompatibilityPin {
            schema_version: 1,
            pin_id: "01K10KJ6P20S58KQBV5P4E3TF4".into(),
            release_id: next.release_id,
            current_core_compatibility: "0.2.107".into(),
            next_core_compatibility: "0.2.108".into(),
            created_at: "2026-07-26T14:00:00.000Z".into(),
            signer_public_key: public,
            signature: String::new(),
        };
        pin.signature = URL_SAFE_NO_PAD.encode(
            key.sign(&canonical_core_compatibility_pin_bytes(&pin))
                .to_bytes(),
        );
        apply_core_compatibility_pin(&mut state, pin).unwrap();
        validate_release_state(&state).unwrap();
    }
}
