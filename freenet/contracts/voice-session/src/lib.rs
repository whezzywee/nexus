use freenet_stdlib::prelude::*;
use nexus_protocol::{
    CallSignalEnvelope, VoiceSessionDelta, VoiceSessionState, VoiceSessionSummary,
    apply_call_signal, merge_voice_sessions, summarize_voice_session, validate_voice_session,
    voice_session_delta_for,
};

struct VoiceSessionContract;

fn decode_state(bytes: &[u8]) -> Result<VoiceSessionState, ContractError> {
    serde_json::from_slice(bytes).map_err(|error| ContractError::Deser(error.to_string()))
}

fn invalid_update(error: impl std::fmt::Display) -> ContractError {
    ContractError::InvalidUpdateWithInfo {
        reason: error.to_string(),
    }
}

fn apply_delta_bytes(state: &mut VoiceSessionState, bytes: &[u8]) -> Result<(), ContractError> {
    if let Ok(signal) = serde_json::from_slice::<CallSignalEnvelope>(bytes) {
        return apply_call_signal(state, signal).map_err(invalid_update);
    }
    let delta = serde_json::from_slice::<VoiceSessionDelta>(bytes)
        .map_err(|error| ContractError::Deser(error.to_string()))?;
    for signal in delta.signals {
        apply_call_signal(state, signal).map_err(invalid_update)?;
    }
    Ok(())
}

#[contract]
impl ContractInterface for VoiceSessionContract {
    fn validate_state(
        _parameters: Parameters<'static>,
        state: State<'static>,
        _related: RelatedContracts<'static>,
    ) -> Result<ValidateResult, ContractError> {
        Ok(
            if validate_voice_session(&decode_state(state.as_ref())?).is_ok() {
                ValidateResult::Valid
            } else {
                ValidateResult::Invalid
            },
        )
    }

    fn update_state(
        _parameters: Parameters<'static>,
        state: State<'static>,
        updates: Vec<UpdateData<'static>>,
    ) -> Result<UpdateModification<'static>, ContractError> {
        let mut current = decode_state(state.as_ref())?;
        for update in updates {
            match update {
                UpdateData::Delta(delta) => apply_delta_bytes(&mut current, delta.as_ref())?,
                UpdateData::State(state) => {
                    let incoming = decode_state(state.as_ref())?;
                    validate_voice_session(&incoming).map_err(invalid_update)?;
                    merge_voice_sessions(&mut current, incoming).map_err(invalid_update)?;
                }
                UpdateData::StateAndDelta { state, delta } => {
                    let incoming = decode_state(state.as_ref())?;
                    validate_voice_session(&incoming).map_err(invalid_update)?;
                    merge_voice_sessions(&mut current, incoming).map_err(invalid_update)?;
                    apply_delta_bytes(&mut current, delta.as_ref())?;
                }
                _ => return Err(ContractError::InvalidUpdate),
            }
        }
        let bytes = serde_json::to_vec(&current)
            .map_err(|error| ContractError::Other(error.to_string()))?;
        Ok(UpdateModification::valid(State::from(bytes)))
    }

    fn summarize_state(
        _parameters: Parameters<'static>,
        state: State<'static>,
    ) -> Result<StateSummary<'static>, ContractError> {
        let bytes = serde_json::to_vec(&summarize_voice_session(&decode_state(state.as_ref())?))
            .map_err(|error| ContractError::Other(error.to_string()))?;
        Ok(StateSummary::from(bytes))
    }

    fn get_state_delta(
        _parameters: Parameters<'static>,
        state: State<'static>,
        summary: StateSummary<'static>,
    ) -> Result<StateDelta<'static>, ContractError> {
        let state = decode_state(state.as_ref())?;
        let remote = if summary.as_ref().is_empty() {
            VoiceSessionSummary::default()
        } else {
            serde_json::from_slice(summary.as_ref())
                .map_err(|error| ContractError::Deser(error.to_string()))?
        };
        let bytes = serde_json::to_vec(&voice_session_delta_for(&state, &remote))
            .map_err(|error| ContractError::Other(error.to_string()))?;
        Ok(StateDelta::from(bytes))
    }
}
