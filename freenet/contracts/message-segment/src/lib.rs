use freenet_stdlib::prelude::*;
use nexus_protocol::{
    MessageOperation, SegmentDelta, SegmentState, SegmentSummary, apply_operation, delta_for,
    merge_states, summarize, validate_state as validate_segment_state,
};

struct MessageSegmentContract;

fn decode_state(bytes: &[u8]) -> Result<SegmentState, ContractError> {
    if bytes.is_empty() {
        return Ok(SegmentState::default());
    }
    serde_json::from_slice(bytes).map_err(|error| ContractError::Deser(error.to_string()))
}

fn encode_state(state: &SegmentState) -> Result<Vec<u8>, ContractError> {
    serde_json::to_vec(state).map_err(|error| ContractError::Other(error.to_string()))
}

fn apply_delta_bytes(state: &mut SegmentState, bytes: &[u8]) -> Result<(), ContractError> {
    if bytes.is_empty() {
        return Ok(());
    }
    if let Ok(operation) = serde_json::from_slice::<MessageOperation>(bytes) {
        return apply_operation(state, operation).map_err(|error| {
            ContractError::InvalidUpdateWithInfo {
                reason: error.to_string(),
            }
        });
    }
    let delta = serde_json::from_slice::<SegmentDelta>(bytes)
        .map_err(|error| ContractError::Deser(error.to_string()))?;
    for operation in delta.operations {
        apply_operation(state, operation).map_err(|error| {
            ContractError::InvalidUpdateWithInfo {
                reason: error.to_string(),
            }
        })?;
    }
    Ok(())
}

#[contract]
impl ContractInterface for MessageSegmentContract {
    fn validate_state(
        _parameters: Parameters<'static>,
        state: State<'static>,
        _related: RelatedContracts<'static>,
    ) -> Result<ValidateResult, ContractError> {
        let decoded = decode_state(state.as_ref())?;
        Ok(if validate_segment_state(&decoded).is_ok() {
            ValidateResult::Valid
        } else {
            ValidateResult::Invalid
        })
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
                    validate_segment_state(&incoming).map_err(|error| {
                        ContractError::InvalidUpdateWithInfo {
                            reason: error.to_string(),
                        }
                    })?;
                    merge_states(&mut current, incoming).map_err(|error| {
                        ContractError::InvalidUpdateWithInfo {
                            reason: error.to_string(),
                        }
                    })?;
                }
                UpdateData::StateAndDelta { state, delta } => {
                    let incoming = decode_state(state.as_ref())?;
                    validate_segment_state(&incoming).map_err(|error| {
                        ContractError::InvalidUpdateWithInfo {
                            reason: error.to_string(),
                        }
                    })?;
                    merge_states(&mut current, incoming).map_err(|error| {
                        ContractError::InvalidUpdateWithInfo {
                            reason: error.to_string(),
                        }
                    })?;
                    apply_delta_bytes(&mut current, delta.as_ref())?;
                }
                _ => return Err(ContractError::InvalidUpdate),
            }
        }
        Ok(UpdateModification::valid(State::from(encode_state(
            &current,
        )?)))
    }

    fn summarize_state(
        _parameters: Parameters<'static>,
        state: State<'static>,
    ) -> Result<StateSummary<'static>, ContractError> {
        let summary = summarize(&decode_state(state.as_ref())?);
        let bytes = serde_json::to_vec(&summary)
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
            SegmentSummary::default()
        } else {
            serde_json::from_slice(summary.as_ref())
                .map_err(|error| ContractError::Deser(error.to_string()))?
        };
        let bytes = serde_json::to_vec(&delta_for(&state, &remote))
            .map_err(|error| ContractError::Other(error.to_string()))?;
        Ok(StateDelta::from(bytes))
    }
}
