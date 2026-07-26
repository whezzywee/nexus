import { describe, expect, it, vi } from "vitest";
import { ReliabilityReporter } from "./reliability";

describe("data-minimized reliability reporting", () => {
  it("is inert by default and clears retained events when disabled", () => {
    let payload: string | null = null;
    const reporter = new ReliabilityReporter({
      surface: "web",
      store: {
        load: () => payload,
        save: (next) => {
          payload = next;
        },
        clear: () => {
          payload = null;
        },
      },
    });
    reporter.record("client_error");
    expect(payload).toBeNull();
    reporter.setEnabled(true);
    reporter.record("client_error");
    expect(payload).not.toContain("message");
    expect(reporter.queuedCount()).toBe(1);
    reporter.setEnabled(false);
    expect(payload).toBeNull();
  });

  it("sends only the bounded event schema and clears after acceptance", async () => {
    let payload: string | null = null;
    let sentBody: BodyInit | null | undefined;
    const fetcher = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      sentBody = init?.body;
      return new Response(null, { status: 204 });
    }) as typeof fetch;
    const reporter = new ReliabilityReporter({
      surface: "desktop",
      endpoint: "https://reliability.example.test/events",
      fetcher,
      store: {
        load: () => payload,
        save: (next) => {
          payload = next;
        },
        clear: () => {
          payload = null;
        },
      },
    });
    reporter.setEnabled(true);
    reporter.record("runtime_disconnected");
    await expect(reporter.flush()).resolves.toBe(true);
    expect(fetcher).toHaveBeenCalledOnce();
    expect(String(sentBody)).not.toContain("identity");
    expect(payload).toBeNull();
  });
});
