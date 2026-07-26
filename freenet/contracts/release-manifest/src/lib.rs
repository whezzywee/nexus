use freenet_stdlib::prelude::*;
use nexus_protocol::{
    CoreCompatibilityPin, ReleaseDelta, ReleaseRecord, ReleaseRevocation, ReleaseState,
    ReleaseSummary, apply_core_compatibility_pin, apply_release_record, apply_release_revocation,
    merge_release_states, release_delta_for, summarize_releases, validate_release_state,
};

struct ReleaseManifestContract;

fn decode_state(bytes: &[u8]) -> Result<ReleaseState, ContractError> {
    serde_json::from_slice(bytes).map_err(|error| ContractError::Deser(error.to_string()))
}

fn invalid_update(error: impl std::fmt::Display) -> ContractError {
    ContractError::InvalidUpdateWithInfo {
        reason: error.to_string(),
    }
}

fn apply_delta_bytes(state: &mut ReleaseState, bytes: &[u8]) -> Result<(), ContractError> {
    if let Ok(release) = serde_json::from_slice::<ReleaseRecord>(bytes) {
        return apply_release_record(state, release).map_err(invalid_update);
    }
    if let Ok(revocation) = serde_json::from_slice::<ReleaseRevocation>(bytes) {
        return apply_release_revocation(state, revocation).map_err(invalid_update);
    }
    if let Ok(pin) = serde_json::from_slice::<CoreCompatibilityPin>(bytes) {
        return apply_core_compatibility_pin(state, pin).map_err(invalid_update);
    }
    let delta = serde_json::from_slice::<ReleaseDelta>(bytes)
        .map_err(|error| ContractError::Deser(error.to_string()))?;
    for release in delta.releases {
        apply_release_record(state, release).map_err(invalid_update)?;
    }
    for revocation in delta.revocations {
        apply_release_revocation(state, revocation).map_err(invalid_update)?;
    }
    for pin in delta.compatibility_pins {
        apply_core_compatibility_pin(state, pin).map_err(invalid_update)?;
    }
    Ok(())
}

#[contract]
impl ContractInterface for ReleaseManifestContract {
    fn validate_state(
        _parameters: Parameters<'static>,
        state: State<'static>,
        _related: RelatedContracts<'static>,
    ) -> Result<ValidateResult, ContractError> {
        Ok(
            if validate_release_state(&decode_state(state.as_ref())?).is_ok() {
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
                    validate_release_state(&incoming).map_err(invalid_update)?;
                    merge_release_states(&mut current, incoming).map_err(invalid_update)?;
                }
                UpdateData::StateAndDelta { state, delta } => {
                    let incoming = decode_state(state.as_ref())?;
                    validate_release_state(&incoming).map_err(invalid_update)?;
                    merge_release_states(&mut current, incoming).map_err(invalid_update)?;
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
        let bytes = serde_json::to_vec(&summarize_releases(&decode_state(state.as_ref())?))
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
            ReleaseSummary::default()
        } else {
            serde_json::from_slice(summary.as_ref())
                .map_err(|error| ContractError::Deser(error.to_string()))?
        };
        let bytes = serde_json::to_vec(&release_delta_for(&state, &remote))
            .map_err(|error| ContractError::Other(error.to_string()))?;
        Ok(StateDelta::from(bytes))
    }
}
