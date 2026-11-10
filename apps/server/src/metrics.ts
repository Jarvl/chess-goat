import { sql } from 'drizzle-orm';
import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from 'prom-client';
import type { Db } from './db/client';

type Row = Record<string, unknown>;

/** Counters and histograms from the code paths, gauges computed from the tables on scrape. */
export class Metrics {
  readonly registry = new Registry();
  readonly contentType = this.registry.contentType;
  readonly webhookUpdates = this.counter('webhook_updates_total', 'Telegram updates received', [
    'type',
  ]);
  readonly movesTotal = this.counter('moves_total', 'Moves accepted');
  readonly moveLatency = new Histogram({
    name: 'move_latency_seconds',
    help: 'Move request received to state published',
    buckets: [0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5],
    registers: [this.registry],
  });
  readonly telegramCalls = this.counter('telegram_api_calls_total', 'Bot API calls', [
    'method',
    'status',
  ]);
  readonly telegram429 = this.counter('telegram_429_total', 'Bot API rate limit responses');
  readonly jobsFailed = this.counter('jobs_failed_total', 'Jobs that exhausted their attempts', [
    'kind',
  ]);
  readonly sseStreams = new Gauge({
    name: 'sse_streams',
    help: 'Open game streams',
    registers: [this.registry],
  });
  readonly sseReconnects = this.counter(
    'sse_reconnects_total',
    'Game streams resumed with a Last-Event-ID',
  );
  readonly gameOpens = this.counter('game_opens_total', 'Game screens opened', ['role']);
  readonly lichessImports = this.counter('lichess_imports_total', 'Lichess imports', ['outcome']);
  readonly gamesFinished = this.counter('games_finished_total', 'Games finished', ['end_reason']);
  readonly miniappLoadErrors = this.counter(
    'miniapp_load_errors_total',
    'Mini App launch failures',
  );
  readonly miniappMoveFailures = this.counter(
    'miniapp_move_failures_total',
    'Mini App moves that ended in Retry',
  );
  readonly engineMoves = this.counter('engine_moves_total', 'Engine moves played');
  readonly engineMoveFailures = this.counter(
    'engine_move_failures_total',
    'Engine move attempts that failed',
  );
  readonly engineIllegalMoves = this.counter(
    'engine_illegal_moves_total',
    'Illegal moves returned by the engine; alert on any increment',
  );
  readonly engineMoveDuration = new Histogram({
    name: 'engine_move_duration_seconds',
    help: 'Time to obtain an engine move',
    buckets: [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
    registers: [this.registry],
  });
  readonly engineAvailable = new Gauge({
    name: 'engine_available',
    help: '1 when the engine binary answered at boot',
    registers: [this.registry],
  });

  constructor(options: { db?: Db } = {}) {
    collectDefaultMetrics({ register: this.registry });
    const { db } = options;
    if (db) this.registerTableGauges(db);
  }

  private counter(name: string, help: string, labelNames: string[] = []): Counter<string> {
    return new Counter({ name, help, labelNames, registers: [this.registry] });
  }

  /** Gauges the alerts need; each runs one query when /metrics is scraped. */
  private registerTableGauges(db: Db): void {
    const query = async (text: ReturnType<typeof sql>): Promise<Row[]> =>
      (await db.execute(text)) as unknown as Row[];
    const gauge = (
      name: string,
      help: string,
      labelNames: string[],
      collect: (self: Gauge<string>) => Promise<void>,
    ) =>
      new Gauge({
        name,
        help,
        labelNames,
        registers: [this.registry],
        async collect() {
          try {
            await collect(this);
          } catch {
            // A scrape must never fail because one query did; the gauge keeps its last value.
          }
        },
      });
    gauge('jobs_pending', 'Jobs not yet done', ['kind'], async (self) => {
      self.reset();
      for (const row of await query(
        sql`select kind, count(*)::int as n from jobs where done_at is null group by kind`,
      ))
        self.set({ kind: String(row.kind) }, Number(row.n));
    });
    gauge('jobs_oldest_age_seconds', 'Age of the oldest due job', ['kind'], async (self) => {
      self.reset();
      for (const row of await query(
        sql`select kind, coalesce(extract(epoch from now() - min(run_at)), 0)::float as age from jobs where done_at is null and run_at <= now() group by kind`,
      ))
        self.set({ kind: String(row.kind) }, Number(row.age));
    });
    gauge(
      'scanner_lag_seconds',
      'Age of the oldest row a scanner should have handled',
      ['scanner'],
      async (self) => {
        const [forfeit] = await query(
          sql`select coalesce(extract(epoch from now() - min(deadline_at)), 0)::float as lag from games where status = 'active' and deadline_at <= now()`,
        );
        const [reminder] = await query(
          sql`select coalesce(extract(epoch from now() - min(reminder_at)), 0)::float as lag from games where status = 'active' and reminder_at is not null and reminder_at <= now()`,
        );
        const [expiry] = await query(
          sql`select coalesce(extract(epoch from now() - min(expires_at)), 0)::float as lag from challenges where status = 'pending' and expires_at <= now()`,
        );
        self.set({ scanner: 'forfeit' }, Number(forfeit?.lag ?? 0));
        self.set({ scanner: 'reminder' }, Number(reminder?.lag ?? 0));
        self.set({ scanner: 'expiry' }, Number(expiry?.lag ?? 0));
      },
    );
    gauge('games_started', 'Games ever started', [], async (self) => {
      const [row] = await query(sql`select count(*)::int as n from games`);
      self.set(Number(row?.n ?? 0));
    });
    gauge('shares', 'Positions ever shared', [], async (self) => {
      const [row] = await query(sql`select count(*)::int as n from shares`);
      self.set(Number(row?.n ?? 0));
    });
    gauge('active_groups', 'Groups where the bot is present', [], async (self) => {
      const [row] = await query(
        sql`select count(*)::int as n from groups where bot_status <> 'left'`,
      );
      self.set(Number(row?.n ?? 0));
    });
  }

  render(): Promise<string> {
    return this.registry.metrics();
  }
}
