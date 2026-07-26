use freenet_stdlib::prelude::*;
use nexus_protocol::{
    ConversationControllerTransferOperation, ConversationDelta, ConversationState,
    ConversationSummary, EpochRotationOperation, apply_conversation_controller_transfer,
    apply_epoch_rotation, conversation_delta_for, merge_conversation_states,
    summarize_conversation, validate_conversation_state,
};

struct PrivateConversationContract;

fn decode_state(bytes: &[u8]) -> Result<ConversationState, ContractError> {
    serde_json::from_slice(bytes).map_err(|error| ContractError::Deser(error.to_string()))
}

fn encode_state(state: &ConversationState) -> Result<Vec<u8>, ContractError> {
    serde_json::to_vec(state).map_err(|error| ContractError::Other(error.to_string()))
}

fn invalid_update(error: impl std::fmt::Display) -> ContractError {
    ContractError::InvalidUpdateWithInfo {
        reason: error.to_string(),
    }
}

fn apply_delta_bytes(state: &mut ConversationState, bytes: &[u8]) -> Result<(), ContractError> {
    if bytes.is_empty() {
        return Ok(());
    }
    if let Ok(rotation) = serde_json::from_slice::<EpochRotationOperation>(bytes) {
        return apply_epoch_rotation(state, rotation).map_err(invalid_update);
    }
    if let Ok(transfer) = serde_json::from_slice::<ConversationControllerTransferOperation>(bytes) {
        return apply_conversation_controller_transfer(state, transfer).map_err(invalid_update);
    }
    let delta = serde_json::from_slice::<ConversationDelta>(bytes)
        .map_err(|error| ContractError::Deser(error.to_string()))?;
    for rotation in delta.rotations {
        apply_epoch_rotation(state, rotation).map_err(invalid_update)?;
    }
    for transfer in delta.transfers {
        apply_conversation_controller_transfer(state, transfer).map_err(invalid_update)?;
    }
    Ok(())
}

#[contract]
impl ContractInterface for PrivateConversationContract {
    fn validate_state(
        _parameters: Parameters<'static>,
        state: State<'static>,
        _related: RelatedContracts<'static>,
    ) -> Result<ValidateResult, ContractError> {
        let decoded = decode_state(state.as_ref())?;
        Ok(if validate_conversation_state(&decoded).is_ok() {
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
                    validate_conversation_state(&incoming).map_err(invalid_update)?;
                    merge_conversation_states(&mut current, incoming).map_err(invalid_update)?;
                }
                UpdateData::StateAndDelta { state, delta } => {
                    let incoming = decode_state(state.as_ref())?;
                    validate_conversation_state(&incoming).map_err(invalid_update)?;
                    merge_conversation_states(&mut current, incoming).map_err(invalid_update)?;
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
        let bytes = serde_json::to_vec(&summarize_conversation(&decode_state(state.as_ref())?))
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
            ConversationSummary::default()
        } else {
            serde_json::from_slice(summary.as_ref())
                .map_err(|error| ContractError::Deser(error.to_string()))?
        };
        let bytes = serde_json::to_vec(&conversation_delta_for(&state, &remote))
            .map_err(|error| ContractError::Other(error.to_string()))?;
        Ok(StateDelta::from(bytes))
    }
}
