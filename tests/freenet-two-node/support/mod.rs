#![allow(dead_code)]

use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use ed25519_dalek::{Signer, SigningKey};
use nexus_protocol::{DeviceCertificate, PROTOCOL_VERSION, canonical_device_certificate_bytes};
use sha2::{Digest, Sha256};

pub fn device_certificate(key: &SigningKey, device_id: &str) -> DeviceCertificate {
    device_certificate_with_encryption(key, device_id, URL_SAFE_NO_PAD.encode([99_u8; 32]))
}

pub fn device_certificate_with_encryption(
    key: &SigningKey,
    device_id: &str,
    encryption_public_key: String,
) -> DeviceCertificate {
    device_certificate_for(key, key, device_id, encryption_public_key)
}

pub fn device_certificate_for(
    root_key: &SigningKey,
    device_key: &SigningKey,
    device_id: &str,
    encryption_public_key: String,
) -> DeviceCertificate {
    let root_public_key = root_key.verifying_key().to_bytes();
    let mut certificate = DeviceCertificate {
        version: PROTOCOL_VERSION,
        identity_id: hex::encode(Sha256::digest(root_public_key)),
        device_id: device_id.into(),
        root_public_key: URL_SAFE_NO_PAD.encode(root_public_key),
        signing_public_key: URL_SAFE_NO_PAD.encode(device_key.verifying_key().to_bytes()),
        encryption_public_key,
        issuance_sequence: 1,
        issued_at: "2026-07-26T12:00:00.000Z".into(),
        expires_at: None,
        signature: String::new(),
    };
    certificate.signature = URL_SAFE_NO_PAD.encode(
        root_key
            .sign(&canonical_device_certificate_bytes(&certificate))
            .to_bytes(),
    );
    certificate
}
