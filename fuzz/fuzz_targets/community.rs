#![no_main]

use libfuzzer_sys::fuzz_target;
use nexus_protocol::*;

fuzz_target!(|data: &[u8]| {
    if let Ok(mut state) = serde_json::from_slice::<CommunityState>(data) {
        let _ = validate_community_state(&state);
        let summary = summarize_community(&state);
        let delta = community_delta_for(&state, &summary);
        for operation in delta.operations {
            let _ = apply_membership_operation(&mut state, operation);
        }
        let replica = state.clone();
        let _ = merge_community_states(&mut state, replica);
    }
    if let Ok(operation) = serde_json::from_slice::<MembershipOperation>(data) {
        let _ = verify_membership_operation(&operation);
    }
    let _ = serde_json::from_slice::<CommunityDelta>(data);
    let _ = serde_json::from_slice::<CommunitySummary>(data);
});
