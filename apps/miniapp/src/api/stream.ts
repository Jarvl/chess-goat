import { GameDtoSchema, type GameDto } from '@chess-goat/shared';

export type EventSourceLike = {
  readonly readyState: number;
  close(): void;
  addEventListener(type: string, listener: (event: MessageEvent | Event) => void): void;
};

type DocumentLike = Pick<Document, 'visibilityState' | 'addEventListener' | 'removeEventListener'>;
type WindowLike = Pick<Window, 'addEventListener' | 'removeEventListener'>;

export type StreamOptions = {
  url: string;
  /** `GET /api/games/:id`; runs on every resume so a missed event cannot leave stale state. */
  refresh: () => Promise<GameDto>;
  onState: (dto: GameDto) => void;
  /** Called once when no connection opened within `failureTimeoutMs` (telemetry `sse_failed`). */
  onFailure?: () => void;
  createEventSource?: (url: string) => EventSourceLike;
  failureTimeoutMs?: number;
  doc?: DocumentLike;
  win?: WindowLike;
};

const CLOSED = 2;
const BACKOFF_START_MS = 2_000;
const BACKOFF_MAX_MS = 30_000;

/** Spec §6.4: state snapshots over SSE, reconnect on visibility and network changes, refresh each time. */
export class GameStream {
  private source: EventSourceLike | null = null;
  private opened = false;
  private failed = false;
  private stopped = true;
  private backoffMs = BACKOFF_START_MS;
  private reopenTimer: ReturnType<typeof setTimeout> | null = null;
  private failureTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly doc: DocumentLike;
  private readonly win: WindowLike;

  constructor(private readonly options: StreamOptions) {
    this.doc = options.doc ?? document;
    this.win = options.win ?? window;
  }

  get connected(): boolean {
    return this.opened && this.source !== null && this.source.readyState !== CLOSED;
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.doc.addEventListener('visibilitychange', this.onVisibility);
    this.win.addEventListener('online', this.onOnline);
    this.failureTimer = setTimeout(() => {
      if (!this.opened && !this.failed) {
        this.failed = true;
        this.options.onFailure?.();
      }
    }, this.options.failureTimeoutMs ?? 30_000);
    this.open();
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.doc.removeEventListener('visibilitychange', this.onVisibility);
    this.win.removeEventListener('online', this.onOnline);
    if (this.reopenTimer) clearTimeout(this.reopenTimer);
    if (this.failureTimer) clearTimeout(this.failureTimer);
    this.reopenTimer = null;
    this.failureTimer = null;
    this.source?.close();
    this.source = null;
    this.opened = false;
  }

  private open(): void {
    this.source?.close();
    this.opened = false;
    const create = this.options.createEventSource ?? ((url: string) => new EventSource(url));
    const source = create(this.options.url);
    this.source = source;
    source.addEventListener('open', () => {
      this.opened = true;
      this.backoffMs = BACKOFF_START_MS;
    });
    source.addEventListener('state', (event) => {
      if (!('data' in event) || typeof event.data !== 'string') return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(event.data);
      } catch {
        return;
      }
      const dto = GameDtoSchema.safeParse(parsed);
      if (dto.success) this.options.onState(dto.data);
    });
    source.addEventListener('error', () => {
      // The browser retries on its own unless it gave up (readyState CLOSED); then we do.
      if (source.readyState === CLOSED && !this.stopped && this.source === source) {
        this.scheduleReopen();
      }
    });
  }

  private scheduleReopen(): void {
    if (this.reopenTimer) return;
    const delay = this.backoffMs;
    this.backoffMs = Math.min(this.backoffMs * 2, BACKOFF_MAX_MS);
    this.reopenTimer = setTimeout(() => {
      this.reopenTimer = null;
      if (!this.stopped) this.open();
    }, delay);
  }

  private readonly onVisibility = (): void => {
    if (this.doc.visibilityState === 'visible') void this.resume();
  };

  private readonly onOnline = (): void => {
    void this.resume();
  };

  /** One GET so a missed event during background cannot leave stale state, then a live stream again. */
  private async resume(): Promise<void> {
    if (this.stopped) return;
    try {
      this.options.onState(await this.options.refresh());
    } catch {
      // The stream, once it reopens, sends the state anyway.
    }
    if (this.stopped) return;
    if (!this.source || this.source.readyState === CLOSED) {
      if (this.reopenTimer) clearTimeout(this.reopenTimer);
      this.reopenTimer = null;
      this.open();
    }
  }
}
