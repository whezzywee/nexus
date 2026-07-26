import {
  createLinkedDeviceState,
  type DeviceSecretStore,
  exportStoredDeviceState,
  type LocalDeviceState,
} from "@nexus/device";
import {
  createIdentityRecoveryBundle,
  type LocalIdentity,
  restoreIdentityRecoveryBundle,
  type SupportedIdentityRecoveryBundle,
} from "@nexus/identity";

export interface RecoveryRehearsal {
  identityId: string;
  displayName: string;
  matchesCurrentIdentity: boolean;
}

export async function createRecoveryFile(
  identity: LocalIdentity,
  passphrase: string,
): Promise<string> {
  const bundle = await createIdentityRecoveryBundle(identity, passphrase);
  return JSON.stringify(bundle, null, 2);
}

export async function rehearseRecoveryFile(
  payload: string,
  passphrase: string,
  expectedIdentityId: string,
): Promise<RecoveryRehearsal> {
  const restored = await restoreIdentityRecoveryBundle(parseRecoveryBundle(payload), passphrase);
  return {
    identityId: restored.identityId,
    displayName: restored.displayName,
    matchesCurrentIdentity: restored.identityId === expectedIdentityId,
  };
}

export async function installRecoveredLinkedDevice(
  payload: string,
  passphrase: string,
  store: DeviceSecretStore,
  profile: string,
): Promise<LocalDeviceState> {
  const restored = await restoreIdentityRecoveryBundle(parseRecoveryBundle(payload), passphrase);
  const linked = await createLinkedDeviceState(restored);
  await store.save(profile, JSON.stringify(await exportStoredDeviceState(linked)));
  return linked;
}

function parseRecoveryBundle(payload: string): SupportedIdentityRecoveryBundle {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    throw new Error("Recovery file is not valid JSON");
  }
  if (!parsed || typeof parsed !== "object" || !("version" in parsed)) {
    throw new Error("Recovery file is malformed");
  }
  return parsed as SupportedIdentityRecoveryBundle;
}
