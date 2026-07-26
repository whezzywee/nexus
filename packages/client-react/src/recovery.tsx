import {
  createRecoveryFile,
  type RecoveryRehearsal,
  rehearseRecoveryFile,
} from "@nexus/app-runtime";
import type { LocalIdentity } from "@nexus/identity";
import { useEffect, useRef, useState } from "react";

export interface RecoveryWorkflowOptions {
  identity?: LocalIdentity;
  install(payload: string, passphrase: string): Promise<void>;
}

export interface RecoveryWorkflowState {
  passphrase: string;
  payload: string;
  status: string | null;
  busy: boolean;
  setPassphrase(value: string): void;
  selectFile(file?: File): Promise<void>;
  exportBundle(): Promise<void>;
  rehearse(): Promise<void>;
  install(): Promise<void>;
}

export function useRecoveryWorkflow({
  identity,
  install,
}: RecoveryWorkflowOptions): RecoveryWorkflowState {
  const [passphrase, setPassphrase] = useState("");
  const [payload, setPayload] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const installRef = useRef(install);
  useEffect(() => {
    installRef.current = install;
  }, [install]);

  async function run<T>(
    task: () => Promise<T>,
    success: (result: T) => string | null,
    fallback: string,
  ): Promise<T | undefined> {
    setBusy(true);
    setStatus(null);
    try {
      const result = await task();
      setStatus(success(result));
      return result;
    } catch (error) {
      setStatus(error instanceof Error ? error.message : fallback);
      return undefined;
    } finally {
      setBusy(false);
    }
  }

  return {
    passphrase,
    payload,
    status,
    busy,
    setPassphrase,
    async selectFile(file) {
      setPayload(file ? await file.text() : "");
      setStatus(null);
    },
    async exportBundle() {
      if (!identity) return;
      await run(
        async () => {
          const contents = await createRecoveryFile(identity, passphrase);
          const url = URL.createObjectURL(new Blob([contents], { type: "application/json" }));
          const link = document.createElement("a");
          link.href = url;
          link.download = `nexus-recovery-${identity.identityId.slice(0, 12)}.json`;
          link.click();
          URL.revokeObjectURL(url);
          setPassphrase("");
        },
        () => "Encrypted recovery file exported. Store it separately from its phrase.",
        "Recovery export failed",
      );
    },
    async rehearse() {
      if (!identity || !payload) return;
      await run<RecoveryRehearsal>(
        () => rehearseRecoveryFile(payload, passphrase, identity.identityId),
        (result) => {
          setPassphrase("");
          return result.matchesCurrentIdentity
            ? `Recovery rehearsal passed for ${result.displayName}. No local data changed.`
            : "This recovery file belongs to a different identity.";
        },
        "Recovery rehearsal failed",
      );
    },
    async install() {
      if (
        !payload ||
        !window.confirm(
          "Replace this local profile with a recovered linked device? Unsynced local work may be lost and the new device will require approval.",
        )
      ) {
        return;
      }
      await run(
        () => installRef.current(payload, passphrase),
        () => {
          setPassphrase("");
          return "Recovered device installed. Reloading…";
        },
        "Device recovery failed",
      );
    },
  };
}

export function RecoveryControls({ state }: { state: RecoveryWorkflowState }) {
  return (
    <>
      <summary>Recovery and lost-device tools</summary>
      <p>Export an encrypted identity file, then rehearse opening it before you need it.</p>
      <label>
        Recovery phrase
        <input
          type="password"
          autoComplete="new-password"
          value={state.passphrase}
          onChange={(event) => state.setPassphrase(event.target.value)}
          placeholder="At least 12 characters"
        />
      </label>
      <button
        type="button"
        disabled={state.busy || state.passphrase.length < 12}
        onClick={() => void state.exportBundle()}
      >
        Export encrypted recovery file
      </button>
      <label>
        Recovery file
        <input
          type="file"
          accept="application/json,.json"
          onChange={(event) => void state.selectFile(event.target.files?.[0])}
        />
      </label>
      <button
        type="button"
        disabled={state.busy || !state.payload || !state.passphrase}
        onClick={() => void state.rehearse()}
      >
        Rehearse recovery safely
      </button>
      <button
        type="button"
        disabled={state.busy || !state.payload || !state.passphrase}
        onClick={() => void state.install()}
      >
        Recover onto this device
      </button>
      {state.status && <span aria-live="polite">{state.status}</span>}
    </>
  );
}
