use freenet_stdlib::prelude::*;
use nexus_protocol::{
    AttachmentIndexDelta, AttachmentIndexOperation, AttachmentIndexState, AttachmentIndexSummary,
    apply_attachment_index_operation, attachment_index_delta_for, merge_attachment_index_states,
    summarize_attachment_index, validate_attachment_index_state,
};

struct AttachmentIndexContract;

fn decode_state(bytes: &[u8]) -> Result<AttachmentIndexState, ContractError> {
    if bytes.is_empty() {
        return Ok(AttachmentIndexState::default());
    }
    serde_json::from_slice(bytes).map_err(|error| ContractError::Deser(error.to_string()))
}

fn invalid_update(error: impl std::fmt::Display) -> ContractError {
    ContractError::InvalidUpdateWithInfo {
        reason: error.to_string(),
    }
}

fn apply_delta_bytes(state: &mut AttachmentIndexState, bytes: &[u8]) -> Result<(), ContractError> {
    if bytes.is_empty() {
        return Ok(());
    }
    if let Ok(operation) = serde_json::from_slice::<AttachmentIndexOperation>(bytes) {
        return apply_attachment_index_operation(state, operation).map_err(invalid_update);
    }
    let delta = serde_json::from_slice::<AttachmentIndexDelta>(bytes)
        .map_err(|error| ContractError::Deser(error.to_string()))?;
    for operation in delta.operations {
        apply_attachment_index_operation(state, operation).map_err(invalid_update)?;
    }
    Ok(())
}

#[contract]
impl ContractInterface for AttachmentIndexContract {
    fn validate_state(
        _parameters: Parameters<'static>,
        state: State<'static>,
        _related: RelatedContracts<'static>,
    ) -> Result<ValidateResult, ContractError> {
        Ok(
            if validate_attachment_index_state(&decode_state(state.as_ref())?).is_ok() {
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
                    validate_attachment_index_state(&incoming).map_err(invalid_update)?;
                    merge_attachment_index_states(&mut current, incoming)
                        .map_err(invalid_update)?;
                }
                UpdateData::StateAndDelta { state, delta } => {
                    let incoming = decode_state(state.as_ref())?;
                    validate_attachment_index_state(&incoming).map_err(invalid_update)?;
                    merge_attachment_index_states(&mut current, incoming)
                        .map_err(invalid_update)?;
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
        let bytes = serde_json::to_vec(&summarize_attachment_index(&decode_state(state.as_ref())?))
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
            AttachmentIndexSummary::default()
        } else {
            serde_json::from_slice(summary.as_ref())
                .map_err(|error| ContractError::Deser(error.to_string()))?
        };
        let bytes = serde_json::to_vec(&attachment_index_delta_for(&state, &remote))
            .map_err(|error| ContractError::Other(error.to_string()))?;
        Ok(StateDelta::from(bytes))
    }
}
