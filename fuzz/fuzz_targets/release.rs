#![no_main]

use libfuzzer_sys::fuzz_target;
use nexus_protocol::*;

fuzz_target!(|data: &[u8]| {
    if let Ok(mut state) = serde_json::from_slice::<ReleaseState>(data) {
        let _ = validate_release_state(&state);
        let summary = summarize_releases(&state);
        let delta = release_delta_for(&state, &summary);
        for release in delta.releases {
            let _ = apply_release_record(&mut state, release);
        }
        for revocation in delta.revocations {
            let _ = apply_release_revocation(&mut state, revocation);
        }
        let replica = state.clone();
        let _ = merge_release_states(&mut state, replica);
    }
    if let Ok(release) = serde_json::from_slice::<ReleaseRecord>(data) {
        let _ = canonical_release_bytes(&release);
    }
    if let Ok(revocation) = serde_json::from_slice::<ReleaseRevocation>(data) {
        let _ = canonical_revocation_bytes(&revocation);
    }
    let _ = serde_json::from_slice::<ReleaseDelta>(data);
    let _ = serde_json::from_slice::<ReleaseSummary>(data);
});
