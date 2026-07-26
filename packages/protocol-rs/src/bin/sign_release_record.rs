use std::{env, fs, path::PathBuf};

use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use ed25519_dalek::{Signer, SigningKey};
use nexus_protocol::{ReleaseRecord, canonical_release_bytes, verify_release_record};

fn main() -> Result<(), String> {
    let mut args = env::args_os().skip(1);
    let unsigned_path = PathBuf::from(
        args.next()
            .ok_or("usage: sign_release_record <unsigned.json> <private-key-file> <signed.json>")?,
    );
    let private_key_path = PathBuf::from(
        args.next()
            .ok_or("usage: sign_release_record <unsigned.json> <private-key-file> <signed.json>")?,
    );
    let output_path = PathBuf::from(
        args.next()
            .ok_or("usage: sign_release_record <unsigned.json> <private-key-file> <signed.json>")?,
    );
    if args.next().is_some() {
        return Err("sign_release_record accepts exactly three paths".into());
    }
    if output_path == private_key_path {
        return Err("signed output cannot overwrite the private key".into());
    }

    let mut record: ReleaseRecord = serde_json::from_slice(
        &fs::read(&unsigned_path)
            .map_err(|error| format!("could not read unsigned release record: {error}"))?,
    )
    .map_err(|error| format!("unsigned release record is malformed: {error}"))?;
    if !record.signature.is_empty() || !record.signer_public_key.is_empty() {
        return Err("unsigned release record must have empty signerPublicKey and signature".into());
    }
    let encoded_key = fs::read_to_string(&private_key_path)
        .map_err(|error| format!("could not read offline release key: {error}"))?;
    let key_bytes: [u8; 32] = URL_SAFE_NO_PAD
        .decode(encoded_key.trim())
        .map_err(|_| "offline release key must be an unpadded base64url Ed25519 seed")?
        .try_into()
        .map_err(|_| "offline release key must contain exactly 32 bytes")?;
    let signing_key = SigningKey::from_bytes(&key_bytes);
    record.signer_public_key = URL_SAFE_NO_PAD.encode(signing_key.verifying_key().to_bytes());
    record.signature = URL_SAFE_NO_PAD.encode(
        signing_key
            .sign(&canonical_release_bytes(&record))
            .to_bytes(),
    );
    verify_release_record(&record.signer_public_key, &record.product, &record)
        .map_err(|error| format!("signed release record failed verification: {error}"))?;

    let parent = output_path
        .parent()
        .ok_or("signed release output must have a parent directory")?;
    fs::create_dir_all(parent)
        .map_err(|error| format!("could not create signed release directory: {error}"))?;
    let staging = output_path.with_extension("json.pending");
    fs::write(
        &staging,
        serde_json::to_vec_pretty(&record)
            .map_err(|error| format!("could not encode signed release record: {error}"))?,
    )
    .map_err(|error| format!("could not stage signed release record: {error}"))?;
    fs::rename(&staging, &output_path)
        .map_err(|error| format!("could not activate signed release record: {error}"))?;
    println!("{}", record.signer_public_key);
    Ok(())
}
