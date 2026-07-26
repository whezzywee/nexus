use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};

const MAX_PROTECTED_STATE_BYTES: usize = 2 * 1024 * 1024;

#[tauri::command]
pub async fn load_identity_secret(
    app: AppHandle,
    profile: String,
) -> Result<Option<String>, String> {
    let path = identity_path(&app, &profile)?;
    let backup = backup_path(&path);
    let encrypted = match tokio::fs::read(&path).await {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            match tokio::fs::read(&backup).await {
                Ok(bytes) => bytes,
                Err(backup_error) if backup_error.kind() == std::io::ErrorKind::NotFound => {
                    return Ok(None);
                }
                Err(backup_error) => {
                    return Err(format!(
                        "Could not read the identity backup: {backup_error}"
                    ));
                }
            }
        }
        Err(error) => return Err(format!("Could not read the protected identity: {error}")),
    };
    let plaintext = unprotect_for_current_user(&encrypted)?;
    String::from_utf8(plaintext)
        .map(Some)
        .map_err(|_| "Protected identity is not valid UTF-8".into())
}

#[tauri::command]
pub async fn store_identity_secret(
    app: AppHandle,
    profile: String,
    payload: String,
) -> Result<(), String> {
    if payload.len() > MAX_PROTECTED_STATE_BYTES {
        return Err("Protected device state exceeds the 2 MiB limit".into());
    }
    let path = identity_path(&app, &profile)?;
    let parent = path
        .parent()
        .ok_or_else(|| "Identity vault path has no parent".to_owned())?;
    tokio::fs::create_dir_all(parent)
        .await
        .map_err(|error| format!("Could not create the identity vault: {error}"))?;
    let encrypted = protect_for_current_user(payload.as_bytes())?;
    replace_with_backup(&path, &encrypted).await
}

fn identity_path(app: &AppHandle, profile: &str) -> Result<PathBuf, String> {
    validate_profile(profile)?;
    let root = app
        .path()
        .app_local_data_dir()
        .map_err(|error| format!("Could not resolve local application data: {error}"))?;
    Ok(root.join("identity-vault").join(format!("{profile}.dpapi")))
}

fn validate_profile(profile: &str) -> Result<(), String> {
    if profile.is_empty()
        || profile.len() > 64
        || !profile
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
    {
        return Err(
            "Identity profile must use 1-64 letters, digits, dashes, or underscores".into(),
        );
    }
    Ok(())
}

async fn replace_with_backup(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let staging = staging_path(path);
    let backup = backup_path(path);
    tokio::fs::write(&staging, bytes)
        .await
        .map_err(|error| format!("Could not stage the protected identity: {error}"))?;
    if backup.exists() {
        tokio::fs::remove_file(&backup)
            .await
            .map_err(|error| format!("Could not clear the old identity backup: {error}"))?;
    }
    if path.exists() {
        tokio::fs::rename(path, &backup)
            .await
            .map_err(|error| format!("Could not back up the protected identity: {error}"))?;
    }
    if let Err(error) = tokio::fs::rename(&staging, path).await {
        if backup.exists() {
            let _ = tokio::fs::rename(&backup, path).await;
        }
        return Err(format!(
            "Could not activate the protected identity: {error}"
        ));
    }
    if backup.exists() {
        tokio::fs::remove_file(&backup)
            .await
            .map_err(|error| format!("Could not clear the identity backup: {error}"))?;
    }
    Ok(())
}

fn staging_path(path: &Path) -> PathBuf {
    path.with_extension("dpapi.staging")
}

fn backup_path(path: &Path) -> PathBuf {
    path.with_extension("dpapi.backup")
}

#[cfg(target_os = "windows")]
mod platform {
    use std::{ffi::c_void, ptr, slice};

    const CRYPTPROTECT_UI_FORBIDDEN: u32 = 0x1;
    const NEXUS_ENTROPY: &[u8] = b"Nexus identity vault v1";

    #[repr(C)]
    struct DataBlob {
        size: u32,
        data: *mut u8,
    }

    #[link(name = "Crypt32")]
    unsafe extern "system" {
        fn CryptProtectData(
            input: *const DataBlob,
            description: *const u16,
            entropy: *const DataBlob,
            reserved: *mut c_void,
            prompt: *mut c_void,
            flags: u32,
            output: *mut DataBlob,
        ) -> i32;
        fn CryptUnprotectData(
            input: *const DataBlob,
            description: *mut *mut u16,
            entropy: *const DataBlob,
            reserved: *mut c_void,
            prompt: *mut c_void,
            flags: u32,
            output: *mut DataBlob,
        ) -> i32;
    }

    #[link(name = "Kernel32")]
    unsafe extern "system" {
        fn LocalFree(memory: *mut c_void) -> *mut c_void;
    }

    pub fn protect(bytes: &[u8]) -> Result<Vec<u8>, String> {
        transform(bytes, true)
    }

    pub fn unprotect(bytes: &[u8]) -> Result<Vec<u8>, String> {
        transform(bytes, false)
    }

    fn transform(bytes: &[u8], encrypt: bool) -> Result<Vec<u8>, String> {
        let input = blob(bytes);
        let entropy = blob(NEXUS_ENTROPY);
        let mut output = DataBlob {
            size: 0,
            data: ptr::null_mut(),
        };
        let success = unsafe {
            if encrypt {
                CryptProtectData(
                    &input,
                    ptr::null(),
                    &entropy,
                    ptr::null_mut(),
                    ptr::null_mut(),
                    CRYPTPROTECT_UI_FORBIDDEN,
                    &mut output,
                )
            } else {
                CryptUnprotectData(
                    &input,
                    ptr::null_mut(),
                    &entropy,
                    ptr::null_mut(),
                    ptr::null_mut(),
                    CRYPTPROTECT_UI_FORBIDDEN,
                    &mut output,
                )
            }
        };
        if success == 0 {
            return Err(format!(
                "Windows DPAPI rejected the identity material: {}",
                std::io::Error::last_os_error()
            ));
        }
        let result = unsafe { slice::from_raw_parts(output.data, output.size as usize).to_vec() };
        unsafe {
            LocalFree(output.data.cast());
        }
        Ok(result)
    }

    fn blob(bytes: &[u8]) -> DataBlob {
        DataBlob {
            size: bytes.len() as u32,
            data: bytes.as_ptr().cast_mut(),
        }
    }
}

#[cfg(target_os = "windows")]
fn protect_for_current_user(bytes: &[u8]) -> Result<Vec<u8>, String> {
    platform::protect(bytes)
}

#[cfg(target_os = "windows")]
fn unprotect_for_current_user(bytes: &[u8]) -> Result<Vec<u8>, String> {
    platform::unprotect(bytes)
}

#[cfg(not(target_os = "windows"))]
fn protect_for_current_user(_bytes: &[u8]) -> Result<Vec<u8>, String> {
    Err("The OS-backed identity vault is not implemented on this platform".into())
}

#[cfg(not(target_os = "windows"))]
fn unprotect_for_current_user(_bytes: &[u8]) -> Result<Vec<u8>, String> {
    Err("The OS-backed identity vault is not implemented on this platform".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn profile_names_cannot_escape_the_vault() {
        assert!(validate_profile("primary-device").is_ok());
        assert!(validate_profile("../outside").is_err());
        assert!(validate_profile("").is_err());
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn dpapi_round_trip_is_bound_to_the_current_user() {
        let plaintext = b"private identity fixture";
        let encrypted = protect_for_current_user(plaintext).expect("DPAPI encryption should work");
        assert_ne!(encrypted, plaintext);
        assert_eq!(
            unprotect_for_current_user(&encrypted).expect("DPAPI decryption should work"),
            plaintext
        );
    }
}
