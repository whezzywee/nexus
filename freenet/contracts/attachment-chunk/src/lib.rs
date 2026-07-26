use freenet_stdlib::prelude::*;
use sha2::{Digest, Sha256};

const MAX_STORED_CHUNK_BYTES: usize = 256 * 1024 + 2048;

struct AttachmentChunkContract;

fn valid_chunk(parameters: &[u8], state: &[u8]) -> bool {
    parameters.len() == 32
        && state.len() <= MAX_STORED_CHUNK_BYTES
        && Sha256::digest(state).as_slice() == parameters
}

fn accept_identical_update(
    current: &[u8],
    candidate: &[u8],
    parameters: &[u8],
) -> Result<(), ContractError> {
    if candidate == current && valid_chunk(parameters, candidate) {
        Ok(())
    } else {
        Err(ContractError::InvalidUpdateWithInfo {
            reason: "attachment chunks are immutable and must match their SHA-256 parameters"
                .into(),
        })
    }
}

#[contract]
impl ContractInterface for AttachmentChunkContract {
    fn validate_state(
        parameters: Parameters<'static>,
        state: State<'static>,
        _related: RelatedContracts<'static>,
    ) -> Result<ValidateResult, ContractError> {
        Ok(if valid_chunk(parameters.as_ref(), state.as_ref()) {
            ValidateResult::Valid
        } else {
            ValidateResult::Invalid
        })
    }

    fn update_state(
        parameters: Parameters<'static>,
        state: State<'static>,
        updates: Vec<UpdateData<'static>>,
    ) -> Result<UpdateModification<'static>, ContractError> {
        for update in updates {
            match update {
                UpdateData::Delta(candidate) => accept_identical_update(
                    state.as_ref(),
                    candidate.as_ref(),
                    parameters.as_ref(),
                )?,
                UpdateData::State(candidate) => accept_identical_update(
                    state.as_ref(),
                    candidate.as_ref(),
                    parameters.as_ref(),
                )?,
                UpdateData::StateAndDelta {
                    state: candidate,
                    delta,
                } => {
                    accept_identical_update(
                        state.as_ref(),
                        candidate.as_ref(),
                        parameters.as_ref(),
                    )?;
                    accept_identical_update(state.as_ref(), delta.as_ref(), parameters.as_ref())?;
                }
                _ => return Err(ContractError::InvalidUpdate),
            }
        }
        Ok(UpdateModification::valid(state))
    }

    fn summarize_state(
        _parameters: Parameters<'static>,
        state: State<'static>,
    ) -> Result<StateSummary<'static>, ContractError> {
        Ok(StateSummary::from(Sha256::digest(state.as_ref()).to_vec()))
    }

    fn get_state_delta(
        _parameters: Parameters<'static>,
        state: State<'static>,
        summary: StateSummary<'static>,
    ) -> Result<StateDelta<'static>, ContractError> {
        let hash = Sha256::digest(state.as_ref());
        Ok(if summary.as_ref() == hash.as_slice() {
            StateDelta::from(Vec::<u8>::new())
        } else {
            StateDelta::from(state.as_ref().to_vec())
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn content_hash_parameters_bind_an_immutable_chunk() {
        let bytes = b"content addressed attachment";
        let hash = Sha256::digest(bytes);
        assert!(valid_chunk(hash.as_slice(), bytes));
        assert!(!valid_chunk(hash.as_slice(), b"tampered"));
    }
}
