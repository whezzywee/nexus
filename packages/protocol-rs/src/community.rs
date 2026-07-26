use std::collections::{BTreeMap, BTreeSet};

use serde::{Deserialize, Serialize};
use thiserror::Error;

use crate::{DeviceCertificate, PROTOCOL_VERSION, verify_device_signature};

pub const MAX_MEMBERSHIP_OPERATIONS: usize = 2048;
pub const COMMUNITY_STATE_HARD_LIMIT: usize = 4 * 1024 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CommunityRole {
    Owner,
    Admin,
    Moderator,
    Member,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MembershipAction {
    Add,
    Remove,
    SetRole,
    SetDevices,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommunityMember {
    pub identity_id: String,
    pub device_ids: Vec<String>,
    pub role: CommunityRole,
    pub active: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MembershipOperation {
    pub protocol_version: u64,
    pub operation_id: String,
    pub community_id: String,
    pub actor_id: String,
    pub actor_device_id: String,
    pub actor_sequence: u64,
    pub target_identity_id: String,
    #[serde(default)]
    pub target_device_ids: Vec<String>,
    pub action: MembershipAction,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub role: Option<CommunityRole>,
    pub epoch: u64,
    pub created_at: String,
    pub public_key: String,
    pub device_certificate: DeviceCertificate,
    pub signature: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommunityState {
    pub schema_version: u64,
    pub community_id: String,
    pub owner_id: String,
    #[serde(default)]
    pub owner_device_ids: Vec<String>,
    #[serde(default)]
    pub operations: BTreeMap<String, MembershipOperation>,
    #[serde(default)]
    pub epoch: u64,
    #[serde(default)]
    pub members: BTreeMap<String, CommunityMember>,
    #[serde(default)]
    pub actor_sequences: BTreeMap<String, u64>,
    #[serde(default)]
    pub revoked_device_ids: BTreeSet<String>,
}

impl CommunityState {
    pub fn new(community_id: String, owner_id: String, owner_device_ids: Vec<String>) -> Self {
        let mut state = Self {
            schema_version: PROTOCOL_VERSION,
            community_id,
            owner_id,
            owner_device_ids,
            operations: BTreeMap::new(),
            epoch: 0,
            members: BTreeMap::new(),
            actor_sequences: BTreeMap::new(),
            revoked_device_ids: BTreeSet::new(),
        };
        normalize_devices(&mut state.owner_device_ids);
        materialize_community(&mut state);
        state
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct CommunitySummary {
    #[serde(default)]
    pub operation_ids: BTreeSet<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct CommunityDelta {
    #[serde(default)]
    pub operations: Vec<MembershipOperation>,
}

#[derive(Debug, Error, PartialEq, Eq)]
pub enum CommunityProtocolError {
    #[error("malformed membership state or operation: {0}")]
    Malformed(String),
    #[error("invalid membership signature")]
    InvalidSignature,
    #[error("membership operation belongs to another community")]
    WrongCommunity,
    #[error("community membership operation limit reached")]
    OperationLimit,
    #[error("community state exceeds the hard size limit")]
    StateTooLarge,
}

pub fn canonical_membership_bytes(operation: &MembershipOperation) -> Vec<u8> {
    let mut output = Vec::with_capacity(768);
    frame(b"nexus:membership-operation:v2", &mut output);
    frame_text(&operation.protocol_version.to_string(), &mut output);
    frame_text(&operation.operation_id, &mut output);
    frame_text(&operation.community_id, &mut output);
    frame_text(&operation.actor_id, &mut output);
    frame_text(&operation.actor_device_id, &mut output);
    frame_text(&operation.actor_sequence.to_string(), &mut output);
    frame_text(&operation.target_identity_id, &mut output);
    let mut target_devices = operation.target_device_ids.clone();
    normalize_devices(&mut target_devices);
    frame_text(&target_devices.join("\u{1f}"), &mut output);
    frame_text(
        match operation.action {
            MembershipAction::Add => "add",
            MembershipAction::Remove => "remove",
            MembershipAction::SetRole => "set_role",
            MembershipAction::SetDevices => "set_devices",
        },
        &mut output,
    );
    frame_text(
        operation.role.map(role_name).unwrap_or_default(),
        &mut output,
    );
    frame_text(&operation.epoch.to_string(), &mut output);
    frame_text(&operation.created_at, &mut output);
    output
}

pub fn verify_membership_operation(
    operation: &MembershipOperation,
) -> Result<(), CommunityProtocolError> {
    let encoded = serde_json::to_vec(operation)
        .map_err(|error| CommunityProtocolError::Malformed(error.to_string()))?;
    if encoded.len() > 32 * 1024
        || operation.protocol_version != PROTOCOL_VERSION
        || !valid_ulid(&operation.operation_id)
        || !valid_ulid(&operation.community_id)
        || operation.actor_id.len() != 64
        || !operation
            .actor_id
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit())
        || operation.target_identity_id.len() != 64
        || !operation
            .target_identity_id
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit())
        || operation.actor_device_id.is_empty()
        || operation.actor_device_id.len() > 128
        || operation.actor_sequence == 0
        || operation.epoch == 0
        || operation.created_at.is_empty()
        || operation.created_at.len() > 64
        || operation.target_device_ids.len() > 64
        || operation
            .target_device_ids
            .iter()
            .any(|device| device.is_empty() || device.len() > 128)
    {
        return Err(CommunityProtocolError::Malformed(
            "membership field is outside its validated bounds".into(),
        ));
    }
    match operation.action {
        MembershipAction::Add
            if operation.role.is_none()
                || operation.role == Some(CommunityRole::Owner)
                || operation.target_device_ids.is_empty() =>
        {
            return Err(CommunityProtocolError::Malformed(
                "member add requires devices and a non-owner role".into(),
            ));
        }
        MembershipAction::Remove if operation.role.is_some() => {
            return Err(CommunityProtocolError::Malformed(
                "member removal cannot assign a role".into(),
            ));
        }
        MembershipAction::SetRole if operation.role.is_none() => {
            return Err(CommunityProtocolError::Malformed(
                "role update requires a role".into(),
            ));
        }
        MembershipAction::SetDevices
            if operation.role.is_some() || operation.target_device_ids.is_empty() =>
        {
            return Err(CommunityProtocolError::Malformed(
                "device roster update requires devices and cannot assign a role".into(),
            ));
        }
        _ => {}
    }

    if !verify_device_signature(
        &operation.device_certificate,
        &operation.public_key,
        &operation.signature,
        &canonical_membership_bytes(operation),
        &operation.actor_id,
        &operation.actor_device_id,
    ) {
        return Err(CommunityProtocolError::InvalidSignature);
    }
    Ok(())
}

pub fn apply_membership_operation(
    state: &mut CommunityState,
    operation: MembershipOperation,
) -> Result<(), CommunityProtocolError> {
    verify_membership_operation(&operation)?;
    if operation.community_id != state.community_id {
        return Err(CommunityProtocolError::WrongCommunity);
    }
    if state.operations.contains_key(&operation.operation_id) {
        return Ok(());
    }
    if state.operations.len() >= MAX_MEMBERSHIP_OPERATIONS {
        return Err(CommunityProtocolError::OperationLimit);
    }
    state
        .operations
        .insert(operation.operation_id.clone(), operation);
    materialize_community(state);
    ensure_community_size(state)
}

pub fn merge_community_states(
    destination: &mut CommunityState,
    source: CommunityState,
) -> Result<(), CommunityProtocolError> {
    if destination.community_id != source.community_id
        || destination.owner_id != source.owner_id
        || destination.owner_device_ids != source.owner_device_ids
    {
        return Err(CommunityProtocolError::Malformed(
            "community bootstrap authority does not match".into(),
        ));
    }
    for operation in source.operations.into_values() {
        apply_membership_operation(destination, operation)?;
    }
    materialize_community(destination);
    ensure_community_size(destination)
}

pub fn validate_community_state(state: &CommunityState) -> Result<(), CommunityProtocolError> {
    if state.schema_version != PROTOCOL_VERSION
        || !valid_ulid(&state.community_id)
        || state.owner_id.len() != 64
        || !state.owner_id.bytes().all(|byte| byte.is_ascii_hexdigit())
        || state.owner_device_ids.is_empty()
        || state.owner_device_ids.len() > 64
        || state
            .owner_device_ids
            .iter()
            .any(|device| device.is_empty() || device.len() > 128)
        || state.operations.len() > MAX_MEMBERSHIP_OPERATIONS
    {
        return Err(CommunityProtocolError::Malformed(
            "community bootstrap or state bounds are invalid".into(),
        ));
    }
    for (operation_id, operation) in &state.operations {
        if operation_id != &operation.operation_id || operation.community_id != state.community_id {
            return Err(CommunityProtocolError::Malformed(
                "membership operation index does not match its signed operation".into(),
            ));
        }
        verify_membership_operation(operation)?;
    }
    let mut expected = state.clone();
    materialize_community(&mut expected);
    if expected.epoch != state.epoch
        || expected.members != state.members
        || expected.actor_sequences != state.actor_sequences
        || expected.revoked_device_ids != state.revoked_device_ids
    {
        return Err(CommunityProtocolError::Malformed(
            "materialized membership view does not match its operation log".into(),
        ));
    }
    ensure_community_size(state)
}

pub fn summarize_community(state: &CommunityState) -> CommunitySummary {
    CommunitySummary {
        operation_ids: state.operations.keys().cloned().collect(),
    }
}

pub fn community_delta_for(state: &CommunityState, remote: &CommunitySummary) -> CommunityDelta {
    CommunityDelta {
        operations: state
            .operations
            .iter()
            .filter_map(|(operation_id, operation)| {
                (!remote.operation_ids.contains(operation_id)).then_some(operation.clone())
            })
            .collect(),
    }
}

pub fn materialize_community(state: &mut CommunityState) {
    normalize_devices(&mut state.owner_device_ids);
    state.schema_version = PROTOCOL_VERSION;
    state.epoch = 0;
    state.actor_sequences.clear();
    state.revoked_device_ids.clear();
    state.members.clear();
    state.members.insert(
        state.owner_id.clone(),
        CommunityMember {
            identity_id: state.owner_id.clone(),
            device_ids: state.owner_device_ids.clone(),
            role: CommunityRole::Owner,
            active: true,
        },
    );

    loop {
        let expected_epoch = state.epoch + 1;
        let candidate = state
            .operations
            .values()
            .filter(|operation| operation.epoch == expected_epoch)
            .rev()
            .find(|operation| operation_is_authorized(state, operation))
            .cloned();
        let Some(operation) = candidate else {
            break;
        };
        apply_materialized_operation(state, &operation);
    }
}

fn operation_is_authorized(state: &CommunityState, operation: &MembershipOperation) -> bool {
    let Some(actor) = state.members.get(&operation.actor_id) else {
        return false;
    };
    if !actor.active
        || !actor.device_ids.contains(&operation.actor_device_id)
        || operation.actor_sequence
            <= state
                .actor_sequences
                .get(&operation.actor_device_id)
                .copied()
                .unwrap_or_default()
    {
        return false;
    }
    let target = state.members.get(&operation.target_identity_id);
    let target_role = target.map(|member| member.role);
    let is_self_device_update = operation.action == MembershipAction::SetDevices
        && operation.actor_id == operation.target_identity_id;
    let has_authority = is_self_device_update
        || match actor.role {
            CommunityRole::Owner => true,
            CommunityRole::Admin => {
                operation.role != Some(CommunityRole::Owner)
                    && target_role != Some(CommunityRole::Owner)
            }
            CommunityRole::Moderator => {
                operation.action == MembershipAction::Remove
                    && target_role == Some(CommunityRole::Member)
            }
            CommunityRole::Member => false,
        };
    if !has_authority {
        return false;
    }
    match operation.action {
        MembershipAction::Add => {
            operation.target_identity_id != state.owner_id
                && operation.role.is_some()
                && operation.role != Some(CommunityRole::Owner)
                && !operation.target_device_ids.is_empty()
                && operation
                    .target_device_ids
                    .iter()
                    .all(|device_id| !state.revoked_device_ids.contains(device_id))
        }
        MembershipAction::Remove => {
            target.is_some_and(|member| member.active && member.role != CommunityRole::Owner)
        }
        MembershipAction::SetRole => {
            target.is_some_and(|member| member.active)
                && operation.role.is_some()
                && (operation.role != Some(CommunityRole::Owner)
                    || actor.role == CommunityRole::Owner)
        }
        MembershipAction::SetDevices => {
            target.is_some_and(|member| member.active)
                && !operation.target_device_ids.is_empty()
                && operation.role.is_none()
                && operation
                    .target_device_ids
                    .iter()
                    .all(|device_id| !state.revoked_device_ids.contains(device_id))
        }
    }
}

fn apply_materialized_operation(state: &mut CommunityState, operation: &MembershipOperation) {
    match operation.action {
        MembershipAction::Add => {
            let mut device_ids = operation.target_device_ids.clone();
            normalize_devices(&mut device_ids);
            state.members.insert(
                operation.target_identity_id.clone(),
                CommunityMember {
                    identity_id: operation.target_identity_id.clone(),
                    device_ids,
                    role: operation.role.expect("authorized add has a role"),
                    active: true,
                },
            );
        }
        MembershipAction::Remove => {
            if let Some(target) = state.members.get_mut(&operation.target_identity_id) {
                state
                    .revoked_device_ids
                    .extend(target.device_ids.iter().cloned());
                target.active = false;
                target.device_ids.clear();
            }
        }
        MembershipAction::SetRole => {
            if operation.role == Some(CommunityRole::Owner) {
                for member in state.members.values_mut() {
                    if member.active && member.role == CommunityRole::Owner {
                        member.role = CommunityRole::Admin;
                    }
                }
            }
            if let Some(target) = state.members.get_mut(&operation.target_identity_id) {
                target.role = operation.role.expect("authorized role update has a role");
            }
        }
        MembershipAction::SetDevices => {
            if let Some(target) = state.members.get_mut(&operation.target_identity_id) {
                let retained: BTreeSet<_> = operation
                    .target_device_ids
                    .iter()
                    .map(String::as_str)
                    .collect();
                state.revoked_device_ids.extend(
                    target
                        .device_ids
                        .iter()
                        .filter(|device_id| !retained.contains(device_id.as_str()))
                        .cloned(),
                );
                target.device_ids = operation.target_device_ids.clone();
                normalize_devices(&mut target.device_ids);
            }
        }
    }
    state.epoch = operation.epoch;
    state
        .actor_sequences
        .insert(operation.actor_device_id.clone(), operation.actor_sequence);
}

fn role_name(role: CommunityRole) -> &'static str {
    match role {
        CommunityRole::Owner => "owner",
        CommunityRole::Admin => "admin",
        CommunityRole::Moderator => "moderator",
        CommunityRole::Member => "member",
    }
}

fn normalize_devices(devices: &mut Vec<String>) {
    devices.sort();
    devices.dedup();
}

fn frame(bytes: &[u8], output: &mut Vec<u8>) {
    output.extend_from_slice(&(bytes.len() as u32).to_be_bytes());
    output.extend_from_slice(bytes);
}

fn frame_text(value: &str, output: &mut Vec<u8>) {
    frame(value.as_bytes(), output);
}

fn valid_ulid(value: &str) -> bool {
    value.len() == 26
        && value.bytes().all(|byte| {
            matches!(
                byte,
                b'0'..=b'9'
                    | b'A'..=b'H'
                    | b'J'
                    | b'K'
                    | b'M'
                    | b'N'
                    | b'P'..=b'T'
                    | b'V'..=b'Z'
            )
        })
}

fn ensure_community_size(state: &CommunityState) -> Result<(), CommunityProtocolError> {
    let bytes = serde_json::to_vec(state)
        .map_err(|error| CommunityProtocolError::Malformed(error.to_string()))?;
    if bytes.len() > COMMUNITY_STATE_HARD_LIMIT {
        return Err(CommunityProtocolError::StateTooLarge);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
    use ed25519_dalek::{Signer, SigningKey};
    use sha2::{Digest, Sha256};

    const COMMUNITY_ID: &str = "01K10KJ6P20S58KQBV5P4E3T9C";

    fn identity(key: &SigningKey) -> String {
        hex::encode(Sha256::digest(key.verifying_key().to_bytes()))
    }

    #[allow(clippy::too_many_arguments)]
    fn signed_operation(
        key: &SigningKey,
        actor_device_id: &str,
        actor_sequence: u64,
        target_id: String,
        target_devices: Vec<String>,
        action: MembershipAction,
        role: Option<CommunityRole>,
        epoch: u64,
        operation_id: &str,
    ) -> MembershipOperation {
        let public_key = key.verifying_key().to_bytes();
        let mut operation = MembershipOperation {
            protocol_version: PROTOCOL_VERSION,
            operation_id: operation_id.into(),
            community_id: COMMUNITY_ID.into(),
            actor_id: identity(key),
            actor_device_id: actor_device_id.into(),
            actor_sequence,
            target_identity_id: target_id,
            target_device_ids: target_devices,
            action,
            role,
            epoch,
            created_at: "2026-07-26T12:00:00.000Z".into(),
            public_key: URL_SAFE_NO_PAD.encode(public_key),
            device_certificate: crate::test_device_certificate(key, key, actor_device_id),
            signature: String::new(),
        };
        operation.signature =
            URL_SAFE_NO_PAD.encode(key.sign(&canonical_membership_bytes(&operation)).to_bytes());
        operation
    }

    #[test]
    fn removal_advances_epoch_and_revokes_devices() {
        let owner = SigningKey::from_bytes(&[21; 32]);
        let member = SigningKey::from_bytes(&[22; 32]);
        let mut state = CommunityState::new(
            COMMUNITY_ID.into(),
            identity(&owner),
            vec!["owner-device".into()],
        );
        apply_membership_operation(
            &mut state,
            signed_operation(
                &owner,
                "owner-device",
                1,
                identity(&member),
                vec!["member-device".into()],
                MembershipAction::Add,
                Some(CommunityRole::Member),
                1,
                "01K10KJ6P20S58KQBV5P4E3TA1",
            ),
        )
        .unwrap();
        apply_membership_operation(
            &mut state,
            signed_operation(
                &owner,
                "owner-device",
                2,
                identity(&member),
                vec![],
                MembershipAction::Remove,
                None,
                2,
                "01K10KJ6P20S58KQBV5P4E3TA2",
            ),
        )
        .unwrap();
        assert_eq!(state.epoch, 2);
        assert!(!state.members[&identity(&member)].active);
        assert!(state.members[&identity(&member)].device_ids.is_empty());
        validate_community_state(&state).unwrap();
    }

    #[test]
    fn unauthorized_device_is_not_materialized() {
        let owner = SigningKey::from_bytes(&[23; 32]);
        let member = SigningKey::from_bytes(&[24; 32]);
        let mut state = CommunityState::new(
            COMMUNITY_ID.into(),
            identity(&owner),
            vec!["owner-device".into()],
        );
        apply_membership_operation(
            &mut state,
            signed_operation(
                &owner,
                "stolen-device",
                1,
                identity(&member),
                vec!["member-device".into()],
                MembershipAction::Add,
                Some(CommunityRole::Member),
                1,
                "01K10KJ6P20S58KQBV5P4E3TA3",
            ),
        )
        .unwrap();
        assert_eq!(state.epoch, 0);
        assert!(!state.members.contains_key(&identity(&member)));
    }

    #[test]
    fn opposite_merge_orders_converge_on_the_same_epoch_winner() {
        let owner = SigningKey::from_bytes(&[25; 32]);
        let left_member = SigningKey::from_bytes(&[26; 32]);
        let right_member = SigningKey::from_bytes(&[27; 32]);
        let initial = CommunityState::new(
            COMMUNITY_ID.into(),
            identity(&owner),
            vec!["owner-device".into()],
        );
        let left = signed_operation(
            &owner,
            "owner-device",
            1,
            identity(&left_member),
            vec!["left-device".into()],
            MembershipAction::Add,
            Some(CommunityRole::Member),
            1,
            "01K10KJ6P20S58KQBV5P4E3TA4",
        );
        let right = signed_operation(
            &owner,
            "owner-device",
            1,
            identity(&right_member),
            vec!["right-device".into()],
            MembershipAction::Add,
            Some(CommunityRole::Member),
            1,
            "01K10KJ6P20S58KQBV5P4E3TA5",
        );
        let mut forward = initial.clone();
        apply_membership_operation(&mut forward, left.clone()).unwrap();
        apply_membership_operation(&mut forward, right.clone()).unwrap();
        let mut reverse = initial;
        apply_membership_operation(&mut reverse, right).unwrap();
        apply_membership_operation(&mut reverse, left).unwrap();
        assert_eq!(forward, reverse);
        assert!(forward.members.contains_key(&identity(&right_member)));
        assert!(!forward.members.contains_key(&identity(&left_member)));
    }

    #[test]
    fn summary_delta_repairs_a_replica() {
        let owner = SigningKey::from_bytes(&[28; 32]);
        let member = SigningKey::from_bytes(&[29; 32]);
        let initial = CommunityState::new(
            COMMUNITY_ID.into(),
            identity(&owner),
            vec!["owner-device".into()],
        );
        let operation = signed_operation(
            &owner,
            "owner-device",
            1,
            identity(&member),
            vec!["member-device".into()],
            MembershipAction::Add,
            Some(CommunityRole::Member),
            1,
            "01K10KJ6P20S58KQBV5P4E3TA6",
        );
        let mut source = initial.clone();
        apply_membership_operation(&mut source, operation).unwrap();
        let mut destination = initial;
        for operation in community_delta_for(&source, &summarize_community(&destination)).operations
        {
            apply_membership_operation(&mut destination, operation).unwrap();
        }
        assert_eq!(source, destination);
    }

    #[test]
    fn authorized_device_can_link_and_revoke_sibling_devices() {
        let owner = SigningKey::from_bytes(&[30; 32]);
        let owner_id = identity(&owner);
        let mut state = CommunityState::new(
            COMMUNITY_ID.into(),
            owner_id.clone(),
            vec!["owner-device".into()],
        );
        apply_membership_operation(
            &mut state,
            signed_operation(
                &owner,
                "owner-device",
                1,
                owner_id.clone(),
                vec!["owner-device".into(), "linked-device".into()],
                MembershipAction::SetDevices,
                None,
                1,
                "01K10KJ6P20S58KQBV5P4E3TA7",
            ),
        )
        .unwrap();
        assert_eq!(
            state.members[&owner_id].device_ids,
            ["linked-device", "owner-device"]
        );
        apply_membership_operation(
            &mut state,
            signed_operation(
                &owner,
                "owner-device",
                2,
                owner_id.clone(),
                vec!["owner-device".into()],
                MembershipAction::SetDevices,
                None,
                2,
                "01K10KJ6P20S58KQBV5P4E3TA8",
            ),
        )
        .unwrap();
        assert_eq!(state.members[&owner_id].device_ids, ["owner-device"]);
        assert!(state.revoked_device_ids.contains("linked-device"));
        apply_membership_operation(
            &mut state,
            signed_operation(
                &owner,
                "owner-device",
                3,
                owner_id.clone(),
                vec!["owner-device".into(), "linked-device".into()],
                MembershipAction::SetDevices,
                None,
                3,
                "01K10KJ6P20S58KQBV5P4E3TAB",
            ),
        )
        .unwrap();
        assert_eq!(state.epoch, 2);
        assert_eq!(state.members[&owner_id].device_ids, ["owner-device"]);
    }

    #[test]
    fn founder_can_transfer_the_materialized_owner_role() {
        let founder = SigningKey::from_bytes(&[31; 32]);
        let successor = SigningKey::from_bytes(&[32; 32]);
        let founder_id = identity(&founder);
        let successor_id = identity(&successor);
        let mut state = CommunityState::new(
            COMMUNITY_ID.into(),
            founder_id.clone(),
            vec!["founder-device".into()],
        );
        apply_membership_operation(
            &mut state,
            signed_operation(
                &founder,
                "founder-device",
                1,
                successor_id.clone(),
                vec!["successor-device".into()],
                MembershipAction::Add,
                Some(CommunityRole::Admin),
                1,
                "01K10KJ6P20S58KQBV5P4E3TA9",
            ),
        )
        .unwrap();
        apply_membership_operation(
            &mut state,
            signed_operation(
                &founder,
                "founder-device",
                2,
                successor_id.clone(),
                vec![],
                MembershipAction::SetRole,
                Some(CommunityRole::Owner),
                2,
                "01K10KJ6P20S58KQBV5P4E3TAA",
            ),
        )
        .unwrap();

        assert_eq!(state.members[&successor_id].role, CommunityRole::Owner);
        assert_eq!(state.members[&founder_id].role, CommunityRole::Admin);
        validate_community_state(&state).unwrap();
    }
}
