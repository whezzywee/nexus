export type ReliabilityCategory =
  | "client_error"
  | "unhandled_rejection"
  | "runtime_connected"
  | "runtime_disconnected";

export interface ReliabilityEvent {
  schemaVersion: 1;
  eventId: string;
  createdAt: string;
  category: ReliabilityCategory;
  surface: "web" | "desktop";
}

export interface ReliabilityStore {
  load(): string | null;
  save(payload: string): void;
  clear(): void;
}

export interface ReliabilityReporterOptions {
  surface: "web" | "desktop";
  endpoint?: string;
  store: ReliabilityStore;
  fetcher?: typeof fetch;
  now?: () => number;
}

const RETENTION_MS = 14 * 24 * 60 * 60 * 1_000;
const MAX_EVENTS = 100;

export class ReliabilityReporter {
  private enabled = false;
  private readonly fetcher: typeof fetch;
  private readonly now: () => number;

  constructor(private readonly options: ReliabilityReporterOptions) {
    this.fetcher = options.fetcher ?? fetch;
    this.now = options.now ?? Date.now;
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    if (!enabled) this.options.store.clear();
  }

  queuedCount(): number {
    return this.readEvents().length;
  }

  record(category: ReliabilityCategory): void {
    if (!this.enabled) return;
    const events = this.readEvents();
    events.push({
      schemaVersion: 1,
      eventId: crypto.randomUUID(),
      createdAt: new Date(this.now()).toISOString(),
      category,
      surface: this.options.surface,
    });
    this.writeEvents(events);
  }

  async flush(): Promise<boolean> {
    if (!this.enabled || !this.options.endpoint) return false;
    const events = this.readEvents();
    if (events.length === 0) return true;
    const response = await this.fetcher(this.options.endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        schemaVersion: 1,
        retentionDays: 14,
        events,
      }),
    });
    if (!response.ok) return false;
    this.options.store.clear();
    return true;
  }

  private readEvents(): ReliabilityEvent[] {
    const cutoff = this.now() - RETENTION_MS;
    try {
      const parsed = JSON.parse(this.options.store.load() ?? "[]") as ReliabilityEvent[];
      return parsed
        .filter(
          (event) =>
            event.schemaVersion === 1 &&
            ["web", "desktop"].includes(event.surface) &&
            Number.isFinite(Date.parse(event.createdAt)) &&
            Date.parse(event.createdAt) >= cutoff,
        )
        .slice(-MAX_EVENTS);
    } catch {
      this.options.store.clear();
      return [];
    }
  }

  private writeEvents(events: ReliabilityEvent[]): void {
    this.options.store.save(JSON.stringify(events.slice(-MAX_EVENTS)));
  }
}
