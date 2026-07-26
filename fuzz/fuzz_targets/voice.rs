#![no_main]

use libfuzzer_sys::fuzz_target;
use nexus_protocol::*;

fuzz_target!(|data: &[u8]| {
    if let Ok(mut state) = serde_json::from_slice::<VoiceSessionState>(data) {
        let _ = validate_voice_session(&state);
        let summary = summarize_voice_session(&state);
        let delta = voice_session_delta_for(&state, &summary);
        for signal in delta.signals {
            let _ = apply_call_signal(&mut state, signal);
        }
        let replica = state.clone();
        let _ = merge_voice_sessions(&mut state, replica);
    }
    if let Ok(signal) = serde_json::from_slice::<CallSignalEnvelope>(data) {
        let _ = verify_call_signal(&signal);
    }
    let _ = serde_json::from_slice::<VoiceSessionDelta>(data);
    let _ = serde_json::from_slice::<VoiceSessionSummary>(data);
});
