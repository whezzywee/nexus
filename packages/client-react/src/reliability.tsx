import { ReliabilityReporter } from "@nexus/app-runtime";
import { useEffect, useMemo, useRef, useState } from "react";

export interface ReliabilityReportingOptions {
  surface: "web" | "desktop";
  endpoint?: string;
  connected: boolean;
  storage: Storage;
  storagePrefix?: string;
}

export interface ReliabilityReportingState {
  enabled: boolean;
  queued: number;
  toggle(): void;
}

export function useReliabilityReporting({
  surface,
  endpoint,
  connected,
  storage,
  storagePrefix = "nexus-reliability",
}: ReliabilityReportingOptions): ReliabilityReportingState {
  const consentKey = `${storagePrefix}-consent-v1`;
  const eventsKey = `${storagePrefix}-events-v1`;
  const reporter = useMemo(
    () =>
      new ReliabilityReporter({
        surface,
        ...(endpoint ? { endpoint } : {}),
        store: {
          load: () => storage.getItem(eventsKey),
          save: (payload) => storage.setItem(eventsKey, payload),
          clear: () => storage.removeItem(eventsKey),
        },
      }),
    [endpoint, eventsKey, storage, surface],
  );
  const [enabled, setEnabled] = useState(false);
  const [queued, setQueued] = useState(0);
  const previousConnected = useRef<boolean | null>(null);

  useEffect(() => {
    const consented = storage.getItem(consentKey) === "on";
    reporter.setEnabled(consented);
    setEnabled(consented);
    setQueued(reporter.queuedCount());
    const record = (category: "client_error" | "unhandled_rejection") => {
      reporter.record(category);
      setQueued(reporter.queuedCount());
      void reporter.flush().then(() => setQueued(reporter.queuedCount()));
    };
    const onError = () => record("client_error");
    const onUnhandled = () => record("unhandled_rejection");
    window.addEventListener("error", onError);
    window.addEventListener("unhandledrejection", onUnhandled);
    if (consented) void reporter.flush().then(() => setQueued(reporter.queuedCount()));
    return () => {
      window.removeEventListener("error", onError);
      window.removeEventListener("unhandledrejection", onUnhandled);
    };
  }, [consentKey, reporter, storage]);

  useEffect(() => {
    if (previousConnected.current === connected) return;
    previousConnected.current = connected;
    reporter.record(connected ? "runtime_connected" : "runtime_disconnected");
    setQueued(reporter.queuedCount());
    void reporter.flush().then(() => setQueued(reporter.queuedCount()));
  }, [connected, reporter]);

  return {
    enabled,
    queued,
    toggle() {
      const next = !enabled;
      reporter.setEnabled(next);
      storage.setItem(consentKey, next ? "on" : "off");
      setEnabled(next);
      setQueued(reporter.queuedCount());
      if (next) void reporter.flush().then(() => setQueued(reporter.queuedCount()));
    },
  };
}

export function ReliabilityControls({ state }: { state: ReliabilityReportingState }) {
  return (
    <>
      <summary>Diagnostics sharing · {state.enabled ? "On" : "Off"}</summary>
      <p>
        Share anonymous app events. Messages, identities, files, and addresses are never included.
      </p>
      <button type="button" onClick={state.toggle}>
        {state.enabled ? "Turn off and clear" : "Share diagnostics"}
      </button>
      {state.enabled && <span>{state.queued} locally queued</span>}
    </>
  );
}
