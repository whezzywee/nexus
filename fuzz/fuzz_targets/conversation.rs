#![no_main]

use libfuzzer_sys::fuzz_target;
use nexus_protocol::*;

fuzz_target!(|data: &[u8]| {
    if let Ok(mut state) = serde_json::from_slice::<ConversationState>(data) {
        let _ = validate_conversation_state(&state);
        let summary = summarize_conversation(&state);
        let delta = conversation_delta_for(&state, &summary);
        for operation in delta.rotations {
            let _ = apply_epoch_rotation(&mut state, operation);
        }
        let replica = state.clone();
        let _ = merge_conversation_states(&mut state, replica);
    }
    if let Ok(operation) = serde_json::from_slice::<EpochRotationOperation>(data) {
        let _ = verify_epoch_rotation(&operation);
    }
    let _ = serde_json::from_slice::<ConversationDelta>(data);
    let _ = serde_json::from_slice::<ConversationSummary>(data);
});
