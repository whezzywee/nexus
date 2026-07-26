use std::{env, fs, path::PathBuf};

use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use ed25519_dalek::{Signer, SigningKey};
use nexus_protocol::{
    CoreCompatibilityPin, canonical_core_compatibility_pin_bytes, verify_core_compatibility_pin,
};

fn main() -> Result<(), String> {
    let mut args = env::args_os().skip(1);
    let unsigned_path = PathBuf::from(args.next().ok_or(
        "usage: sign_core_compatibility_pin <unsigned.json> <private-key-file> <signed.json>",
    )?);
    let private_key_path = PathBuf::from(args.next().ok_or(
        "usage: sign_core_compatibility_pin <unsigned.json> <private-key-file> <signed.json>",
    )?);
    let output_path = PathBuf::from(args.next().ok_or(
        "usage: sign_core_compatibility_pin <unsigned.json> <private-key-file> <signed.json>",
    )?);
    if args.next().is_some() {
        return Err("sign_core_compatibility_pin accepts exactly three paths".into());
    }
    if output_path == private_key_path {
        return Err("signed output cannot overwrite the private key".into());
    }

    let mut pin: CoreCompatibilityPin = serde_json::from_slice(
        &fs::read(&unsigned_path)
            .map_err(|error| format!("could not read unsigned compatibility pin: {error}"))?,
    )
    .map_err(|error| format!("unsigned compatibility pin is malformed: {error}"))?;
    if !pin.signature.is_empty() || !pin.signer_public_key.is_empty() {
        return Err(
            "unsigned compatibility pin must have empty signerPublicKey and signature".into(),
        );
    }
    let encoded_key = fs::read_to_string(&private_key_path)
        .map_err(|error| format!("could not read offline release key: {error}"))?;
    let key_bytes: [u8; 32] = URL_SAFE_NO_PAD
        .decode(encoded_key.trim())
        .map_err(|_| "offline release key must be an unpadded base64url Ed25519 seed")?
        .try_into()
        .map_err(|_| "offline release key must contain exactly 32 bytes")?;
    let signing_key = SigningKey::from_bytes(&key_bytes);
    pin.signer_public_key = URL_SAFE_NO_PAD.encode(signing_key.verifying_key().to_bytes());
    pin.signature = URL_SAFE_NO_PAD.encode(
        signing_key
            .sign(&canonical_core_compatibility_pin_bytes(&pin))
            .to_bytes(),
    );
    verify_core_compatibility_pin(&pin.signer_public_key, &pin)
        .map_err(|error| format!("signed compatibility pin failed verification: {error}"))?;

    let parent = output_path
        .parent()
        .ok_or("signed compatibility pin output must have a parent directory")?;
    fs::create_dir_all(parent)
        .map_err(|error| format!("could not create signed compatibility pin directory: {error}"))?;
    let staging = output_path.with_extension("json.pending");
    fs::write(
        &staging,
        serde_json::to_vec_pretty(&pin)
            .map_err(|error| format!("could not encode signed compatibility pin: {error}"))?,
    )
    .map_err(|error| format!("could not stage signed compatibility pin: {error}"))?;
    fs::rename(&staging, &output_path)
        .map_err(|error| format!("could not activate signed compatibility pin: {error}"))?;
    println!("{}", pin.signer_public_key);
    Ok(())
}
