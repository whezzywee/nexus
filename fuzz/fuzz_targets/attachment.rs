#![no_main]

use libfuzzer_sys::fuzz_target;
use nexus_protocol::*;

fuzz_target!(|data: &[u8]| {
    if let Ok(mut state) = serde_json::from_slice::<AttachmentIndexState>(data) {
        let _ = validate_attachment_index_state(&state);
        let summary = summarize_attachment_index(&state);
        let delta = attachment_index_delta_for(&state, &summary);
        for operation in delta.operations {
            let _ = apply_attachment_index_operation(&mut state, operation);
        }
        let replica = state.clone();
        let _ = merge_attachment_index_states(&mut state, replica);
    }
    if let Ok(operation) = serde_json::from_slice::<AttachmentIndexOperation>(data) {
        let _ = verify_attachment_index_operation(&operation);
    }
    let _ = serde_json::from_slice::<AttachmentIndexDelta>(data);
    let _ = serde_json::from_slice::<AttachmentIndexSummary>(data);
});
