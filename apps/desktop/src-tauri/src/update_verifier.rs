use std::path::PathBuf;

use nexus_protocol::{
    ReleaseArtifact, ReleaseState, validate_release_state, verify_release_record,
};
use semver::Version;
use serde::Serialize;
use sha2::{Digest, Sha256};

const CORE_COMPATIBILITY: &str = "0.2.107";

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VerifiedUpdate {
    pub release_id: String,
    pub version: String,
    pub artifact_name: String,
    pub sha256: String,
}

#[tauri::command]
pub async fn verify_update_artifact(
    release_state_json: String,
    release_id: String,
    artifact_path: String,
) -> Result<VerifiedUpdate, String> {
    let trust_root = option_env!("NEXUS_RELEASE_TRUST_ROOT_PUBLIC_KEY")
        .ok_or("This build has no pinned release trust root and cannot install updates")?;
    let state: ReleaseState = serde_json::from_str(&release_state_json)
        .map_err(|error| format!("Release state is malformed: {error}"))?;
    if state.trust_root_public_key != trust_root {
        return Err("Release state does not match the application trust root".into());
    }
    validate_release_state(&state)
        .map_err(|error| format!("Release state verification failed: {error}"))?;
    let path = PathBuf::from(artifact_path);
    let bytes = tokio::fs::read(&path)
        .await
        .map_err(|error| format!("Could not read the staged update: {error}"))?;
    verify_update_bytes(
        &state,
        &release_id,
        path.file_name()
            .and_then(|name| name.to_str())
            .ok_or("Staged update filename is invalid")?,
        &bytes,
        env!("CARGO_PKG_VERSION"),
        current_platform(),
        trust_root,
    )
}

fn verify_update_bytes(
    state: &ReleaseState,
    release_id: &str,
    artifact_name: &str,
    bytes: &[u8],
    current_version: &str,
    platform: &str,
    trust_root: &str,
) -> Result<VerifiedUpdate, String> {
    let release = state
        .releases
        .get(release_id)
        .ok_or("Release is not present in the verified manifest")?;
    verify_release_record(trust_root, &state.product, release)
        .map_err(|error| format!("Release signature verification failed: {error}"))?;
    if state
        .revocations
        .values()
        .any(|revocation| revocation.release_id == release_id)
    {
        return Err("Release has been revoked".into());
    }
    if !core_compatibility_is_authorized(state, release) {
        return Err("Release is incompatible with the managed Core pin".into());
    }
    if compare_versions(&release.version, current_version)? != std::cmp::Ordering::Greater {
        return Err("Update policy rejects same-version and rollback installation".into());
    }
    let artifact = select_artifact(release.artifacts.as_slice(), artifact_name, platform)?;
    if artifact.bytes != bytes.len() as u64 {
        return Err("Staged update length does not match the signed release".into());
    }
    let digest = hex::encode(Sha256::digest(bytes));
    if artifact.sha256 != digest {
        return Err("Staged update hash does not match the signed release".into());
    }
    Ok(VerifiedUpdate {
        release_id: release.release_id.clone(),
        version: release.version.clone(),
        artifact_name: artifact.name.clone(),
        sha256: digest,
    })
}

fn core_compatibility_is_authorized(
    state: &ReleaseState,
    release: &nexus_protocol::ReleaseRecord,
) -> bool {
    release.core_compatibility == CORE_COMPATIBILITY
        || state.compatibility_pins.values().any(|pin| {
            pin.release_id == release.release_id
                && pin.current_core_compatibility == CORE_COMPATIBILITY
                && pin.next_core_compatibility == release.core_compatibility
        })
}

fn select_artifact<'a>(
    artifacts: &'a [ReleaseArtifact],
    name: &str,
    platform: &str,
) -> Result<&'a ReleaseArtifact, String> {
    artifacts
        .iter()
        .find(|artifact| artifact.name == name && artifact.platform == platform)
        .ok_or_else(|| "Release does not contain this artifact for the current platform".into())
}

fn compare_versions(left: &str, right: &str) -> Result<std::cmp::Ordering, String> {
    let left = Version::parse(left)
        .map_err(|_| "Release version is not valid semantic versioning".to_owned())?;
    let right = Version::parse(right)
        .map_err(|_| "Current version is not valid semantic versioning".to_owned())?;
    Ok(left.cmp(&right))
}

fn current_platform() -> &'static str {
    if cfg!(all(target_os = "windows", target_arch = "x86_64")) {
        "windows-x86_64"
    } else if cfg!(all(target_os = "linux", target_arch = "x86_64")) {
        "linux-x86_64"
    } else if cfg!(all(target_os = "linux", target_arch = "aarch64")) {
        "linux-aarch64"
    } else if cfg!(all(target_os = "macos", target_arch = "x86_64")) {
        "macos-x86_64"
    } else if cfg!(all(target_os = "macos", target_arch = "aarch64")) {
        "macos-aarch64"
    } else {
        "unsupported"
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
    use ed25519_dalek::{Signer, SigningKey};
    use nexus_protocol::{
        CoreCompatibilityPin, ReleaseRecord, apply_core_compatibility_pin, apply_release_record,
        canonical_core_compatibility_pin_bytes, canonical_release_bytes,
    };

    #[test]
    fn semantic_versions_preserve_prerelease_ordering() {
        assert_eq!(
            compare_versions("1.0.0", "1.0.0-beta.2").unwrap(),
            std::cmp::Ordering::Greater
        );
        assert_eq!(
            compare_versions("1.0.0-beta.2", "1.0.0").unwrap(),
            std::cmp::Ordering::Less
        );
        assert!(compare_versions("1..0", "1.0.0").is_err());
    }

    #[test]
    fn verifies_signature_hash_version_and_revocation_policy() {
        let key = SigningKey::from_bytes(&[101; 32]);
        let trust_root = URL_SAFE_NO_PAD.encode(key.verifying_key().to_bytes());
        let bytes = b"signed installer";
        let mut record = ReleaseRecord {
            schema_version: 1,
            release_id: "01K10KJ6P20S58KQBV5P4E3TG1".into(),
            product: "Nexus".into(),
            version: "0.2.0".into(),
            published_at: "2026-07-26T12:00:00.000Z".into(),
            core_compatibility: CORE_COMPATIBILITY.into(),
            artifacts: vec![ReleaseArtifact {
                name: "Nexus.exe".into(),
                platform: "windows-x86_64".into(),
                bytes: bytes.len() as u64,
                sha256: hex::encode(Sha256::digest(bytes)),
                url: "https://updates.example/Nexus.exe".into(),
            }],
            signer_public_key: trust_root.clone(),
            signature: String::new(),
        };
        record.signature =
            URL_SAFE_NO_PAD.encode(key.sign(&canonical_release_bytes(&record)).to_bytes());
        let mut state = ReleaseState::new("Nexus".into(), trust_root.clone());
        state
            .releases
            .insert(record.release_id.clone(), record.clone());
        assert!(
            verify_update_bytes(
                &state,
                &record.release_id,
                "Nexus.exe",
                bytes,
                "0.1.0",
                "windows-x86_64",
                &trust_root,
            )
            .is_ok()
        );
        assert!(
            verify_update_bytes(
                &state,
                &record.release_id,
                "Nexus.exe",
                b"tampered",
                "0.1.0",
                "windows-x86_64",
                &trust_root,
            )
            .is_err()
        );
        assert!(
            verify_update_bytes(
                &state,
                &record.release_id,
                "Nexus.exe",
                bytes,
                "0.3.0",
                "windows-x86_64",
                &trust_root,
            )
            .is_err()
        );

        let mut next = record;
        next.release_id = "01K10KJ6P20S58KQBV5P4E3TG2".into();
        next.version = "0.3.0".into();
        next.core_compatibility = "0.2.108".into();
        next.signature =
            URL_SAFE_NO_PAD.encode(key.sign(&canonical_release_bytes(&next)).to_bytes());
        apply_release_record(&mut state, next.clone()).unwrap();
        assert!(
            verify_update_bytes(
                &state,
                &next.release_id,
                "Nexus.exe",
                bytes,
                "0.2.0",
                "windows-x86_64",
                &trust_root,
            )
            .is_err()
        );
        let mut pin = CoreCompatibilityPin {
            schema_version: 1,
            pin_id: "01K10KJ6P20S58KQBV5P4E3TG3".into(),
            release_id: next.release_id.clone(),
            current_core_compatibility: CORE_COMPATIBILITY.into(),
            next_core_compatibility: next.core_compatibility,
            created_at: "2026-07-26T13:00:00.000Z".into(),
            signer_public_key: trust_root.clone(),
            signature: String::new(),
        };
        pin.signature = URL_SAFE_NO_PAD.encode(
            key.sign(&canonical_core_compatibility_pin_bytes(&pin))
                .to_bytes(),
        );
        apply_core_compatibility_pin(&mut state, pin).unwrap();
        assert!(
            verify_update_bytes(
                &state,
                &next.release_id,
                "Nexus.exe",
                bytes,
                "0.2.0",
                "windows-x86_64",
                &trust_root,
            )
            .is_ok()
        );
    }
}
