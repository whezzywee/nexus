use std::collections::{BTreeMap, BTreeSet};

use serde::{Deserialize, Serialize};
use thiserror::Error;

use crate::{DeviceCertificate, PROTOCOL_VERSION, verify_device_signature};

pub const MAX_VOICE_PARTICIPANTS: usize = 12;
pub const MAX_SIGNALS_PER_ROUTE: usize = 64;
pub const VOICE_STATE_HARD_LIMIT: usize = 4 * 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VoiceParticipant {
    pub identity_id: String,
    pub device_id: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CallSignalType {
    Offer,
    Answer,
    Ice,
    Leave,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CallSignalEnvelope {
    pub version: u64,
    pub signal_id: String,
    pub call_id: String,
    pub call_epoch: u64,
    pub sender_identity_id: String,
    pub sender_device_id: String,
    pub recipient_device_id: String,
    pub sequence: u64,
    pub expires_at: u64,
    #[serde(rename = "type")]
    pub signal_type: CallSignalType,
    pub ciphertext: String,
    pub public_key: String,
    pub device_certificate: DeviceCertificate,
    pub signature: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VoiceSessionState {
    pub schema_version: u64,
    pub call_id: String,
    pub call_epoch: u64,
    #[serde(default)]
    pub participants: BTreeMap<String, VoiceParticipant>,
    #[serde(default)]
    pub signals: BTreeMap<String, CallSignalEnvelope>,
    #[serde(default)]
    pub sender_sequences: BTreeMap<String, u64>,
}

impl VoiceSessionState {
    pub fn new(call_id: String, call_epoch: u64, participants: Vec<VoiceParticipant>) -> Self {
        Self {
            schema_version: PROTOCOL_VERSION,
            call_id,
            call_epoch,
            participants: participants
                .into_iter()
                .map(|participant| (participant.device_id.clone(), participant))
                .collect(),
            signals: BTreeMap::new(),
            sender_sequences: BTreeMap::new(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct VoiceSessionSummary {
    #[serde(default)]
    pub signal_ids: BTreeSet<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct VoiceSessionDelta {
    #[serde(default)]
    pub signals: Vec<CallSignalEnvelope>,
}

#[derive(Debug, Error, PartialEq, Eq)]
pub enum VoiceProtocolError {
    #[error("malformed voice session or signal: {0}")]
    Malformed(String),
    #[error("invalid call signal signature")]
    InvalidSignature,
    #[error("call signal is outside this session roster or epoch")]
    OutsideSession,
    #[error("voice session state exceeds the hard size limit")]
    StateTooLarge,
}

pub fn canonical_call_signal_bytes(envelope: &CallSignalEnvelope) -> Vec<u8> {
    let fields = [
        "nexus:call-signal:v2".to_string(),
        envelope.signal_id.clone(),
        envelope.call_id.clone(),
        envelope.call_epoch.to_string(),
        envelope.sender_identity_id.clone(),
        envelope.sender_device_id.clone(),
        envelope.recipient_device_id.clone(),
        envelope.sequence.to_string(),
        envelope.expires_at.to_string(),
        match envelope.signal_type {
            CallSignalType::Offer => "offer",
            CallSignalType::Answer => "answer",
            CallSignalType::Ice => "ice",
            CallSignalType::Leave => "leave",
        }
        .into(),
        envelope.ciphertext.clone(),
    ];
    let mut output = Vec::with_capacity(envelope.ciphertext.len() + 768);
    for field in fields {
        frame(field.as_bytes(), &mut output);
    }
    output
}

pub fn verify_call_signal(envelope: &CallSignalEnvelope) -> Result<(), VoiceProtocolError> {
    let encoded = serde_json::to_vec(envelope)
        .map_err(|error| VoiceProtocolError::Malformed(error.to_string()))?;
    if encoded.len() > 96 * 1024
        || envelope.version != PROTOCOL_VERSION
        || !valid_ulid(&envelope.signal_id)
        || !valid_ulid(&envelope.call_id)
        || envelope.call_epoch == 0
        || !valid_identity(&envelope.sender_identity_id)
        || envelope.sender_device_id.is_empty()
        || envelope.sender_device_id.len() > 128
        || envelope.recipient_device_id.is_empty()
        || envelope.recipient_device_id.len() > 128
        || envelope.sequence == 0
        || envelope.expires_at == 0
        || envelope.ciphertext.is_empty()
        || envelope.ciphertext.len() > 64 * 1024
    {
        return Err(VoiceProtocolError::Malformed(
            "call signal field is outside its validated bounds".into(),
        ));
    }
    if !verify_device_signature(
        &envelope.device_certificate,
        &envelope.public_key,
        &envelope.signature,
        &canonical_call_signal_bytes(envelope),
        &envelope.sender_identity_id,
        &envelope.sender_device_id,
    ) {
        return Err(VoiceProtocolError::InvalidSignature);
    }
    Ok(())
}

pub fn apply_call_signal(
    state: &mut VoiceSessionState,
    envelope: CallSignalEnvelope,
) -> Result<(), VoiceProtocolError> {
    verify_call_signal(&envelope)?;
    if envelope.call_id != state.call_id
        || envelope.call_epoch != state.call_epoch
        || state
            .participants
            .get(&envelope.sender_device_id)
            .is_none_or(|participant| participant.identity_id != envelope.sender_identity_id)
        || !state
            .participants
            .contains_key(&envelope.recipient_device_id)
    {
        return Err(VoiceProtocolError::OutsideSession);
    }
    state.signals.insert(envelope.signal_id.clone(), envelope);
    normalize_voice_session(state);
    ensure_voice_size(state)
}

pub fn merge_voice_sessions(
    destination: &mut VoiceSessionState,
    source: VoiceSessionState,
) -> Result<(), VoiceProtocolError> {
    if destination.call_id != source.call_id
        || destination.call_epoch != source.call_epoch
        || destination.participants != source.participants
    {
        return Err(VoiceProtocolError::Malformed(
            "voice session bootstrap roster does not match".into(),
        ));
    }
    for signal in source.signals.into_values() {
        apply_call_signal(destination, signal)?;
    }
    normalize_voice_session(destination);
    ensure_voice_size(destination)
}

pub fn validate_voice_session(state: &VoiceSessionState) -> Result<(), VoiceProtocolError> {
    if state.schema_version != PROTOCOL_VERSION
        || !valid_ulid(&state.call_id)
        || state.call_epoch == 0
        || state.participants.len() < 2
        || state.participants.len() > MAX_VOICE_PARTICIPANTS
    {
        return Err(VoiceProtocolError::Malformed(
            "voice session bootstrap is invalid".into(),
        ));
    }
    for (device_id, participant) in &state.participants {
        if device_id != &participant.device_id
            || device_id.is_empty()
            || device_id.len() > 128
            || !valid_identity(&participant.identity_id)
        {
            return Err(VoiceProtocolError::Malformed(
                "voice participant roster is invalid".into(),
            ));
        }
    }
    for (signal_id, signal) in &state.signals {
        if signal_id != &signal.signal_id {
            return Err(VoiceProtocolError::Malformed(
                "voice signal index is invalid".into(),
            ));
        }
        verify_call_signal(signal)?;
        if signal.call_id != state.call_id
            || signal.call_epoch != state.call_epoch
            || state
                .participants
                .get(&signal.sender_device_id)
                .is_none_or(|participant| participant.identity_id != signal.sender_identity_id)
            || !state.participants.contains_key(&signal.recipient_device_id)
        {
            return Err(VoiceProtocolError::OutsideSession);
        }
    }
    let mut expected = state.clone();
    normalize_voice_session(&mut expected);
    if expected.signals != state.signals || expected.sender_sequences != state.sender_sequences {
        return Err(VoiceProtocolError::Malformed(
            "voice inbox is not deterministically normalized".into(),
        ));
    }
    ensure_voice_size(state)
}

pub fn summarize_voice_session(state: &VoiceSessionState) -> VoiceSessionSummary {
    VoiceSessionSummary {
        signal_ids: state.signals.keys().cloned().collect(),
    }
}

pub fn voice_session_delta_for(
    state: &VoiceSessionState,
    remote: &VoiceSessionSummary,
) -> VoiceSessionDelta {
    VoiceSessionDelta {
        signals: state
            .signals
            .iter()
            .filter_map(|(signal_id, signal)| {
                (!remote.signal_ids.contains(signal_id)).then_some(signal.clone())
            })
            .collect(),
    }
}

pub fn normalize_voice_session(state: &mut VoiceSessionState) {
    state.schema_version = PROTOCOL_VERSION;
    let mut routes: BTreeMap<String, BTreeMap<u64, String>> = BTreeMap::new();
    for (signal_id, signal) in &state.signals {
        let current = routes
            .entry(route_key(signal))
            .or_default()
            .entry(signal.sequence)
            .or_default();
        if signal_id > current {
            *current = signal_id.clone();
        }
    }
    let mut retained = BTreeSet::new();
    for signals in routes.values() {
        retained.extend(signals.values().rev().take(MAX_SIGNALS_PER_ROUTE).cloned());
    }
    state
        .signals
        .retain(|signal_id, _| retained.contains(signal_id));
    state.sender_sequences =
        state
            .signals
            .values()
            .fold(BTreeMap::new(), |mut sequences, signal| {
                let entry = sequences.entry(route_key(signal)).or_default();
                *entry = (*entry).max(signal.sequence);
                sequences
            });
}

fn route_key(signal: &CallSignalEnvelope) -> String {
    format!(
        "{}:{}:{}",
        signal.sender_identity_id, signal.sender_device_id, signal.recipient_device_id
    )
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

fn frame(bytes: &[u8], output: &mut Vec<u8>) {
    output.extend_from_slice(&(bytes.len() as u32).to_be_bytes());
    output.extend_from_slice(bytes);
}

fn ensure_voice_size(state: &VoiceSessionState) -> Result<(), VoiceProtocolError> {
    let bytes = serde_json::to_vec(state)
        .map_err(|error| VoiceProtocolError::Malformed(error.to_string()))?;
    if bytes.len() > VOICE_STATE_HARD_LIMIT {
        return Err(VoiceProtocolError::StateTooLarge);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
    use ed25519_dalek::{Signer, SigningKey};
    use sha2::{Digest, Sha256};

    const CALL_ID: &str = "01K10KJ6P20S58KQBV5P4E3TE1";

    fn identity(key: &SigningKey) -> String {
        hex::encode(Sha256::digest(key.verifying_key().to_bytes()))
    }

    fn signal(
        key: &SigningKey,
        sender_device: &str,
        recipient: &str,
        sequence: u64,
        signal_id: &str,
    ) -> CallSignalEnvelope {
        let public_key = key.verifying_key().to_bytes();
        let mut signal = CallSignalEnvelope {
            version: PROTOCOL_VERSION,
            signal_id: signal_id.into(),
            call_id: CALL_ID.into(),
            call_epoch: 1,
            sender_identity_id: identity(key),
            sender_device_id: sender_device.into(),
            recipient_device_id: recipient.into(),
            sequence,
            expires_at: 1_800_000_000_000,
            signal_type: CallSignalType::Offer,
            ciphertext: "recipient-encrypted-sdp".into(),
            public_key: URL_SAFE_NO_PAD.encode(public_key),
            device_certificate: crate::test_device_certificate(key, key, sender_device),
            signature: String::new(),
        };
        signal.signature =
            URL_SAFE_NO_PAD.encode(key.sign(&canonical_call_signal_bytes(&signal)).to_bytes());
        signal
    }

    #[test]
    fn accepts_roster_bound_signals_and_rejects_outsiders() {
        let mara = SigningKey::from_bytes(&[71; 32]);
        let theo = SigningKey::from_bytes(&[72; 32]);
        let mut state = VoiceSessionState::new(
            CALL_ID.into(),
            1,
            vec![
                VoiceParticipant {
                    identity_id: identity(&mara),
                    device_id: "mara-device".into(),
                },
                VoiceParticipant {
                    identity_id: identity(&theo),
                    device_id: "theo-device".into(),
                },
            ],
        );
        apply_call_signal(
            &mut state,
            signal(
                &mara,
                "mara-device",
                "theo-device",
                1,
                "01K10KJ6P20S58KQBV5P4E3TE2",
            ),
        )
        .unwrap();
        assert_eq!(state.signals.len(), 1);
        let outsider = SigningKey::from_bytes(&[73; 32]);
        assert_eq!(
            apply_call_signal(
                &mut state,
                signal(
                    &outsider,
                    "outsider-device",
                    "theo-device",
                    1,
                    "01K10KJ6P20S58KQBV5P4E3TE3",
                ),
            ),
            Err(VoiceProtocolError::OutsideSession)
        );
    }
}
