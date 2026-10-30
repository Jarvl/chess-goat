import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { games, jobs } from '../../src/db/schema';
import { lichessJobHandlers } from '../../src/jobs/handlers/lichess';
import { enqueue } from '../../src/jobs/queue';
import { JobWorker } from '../../src/jobs/worker';
import { testConfig } from '../helpers/config';
import { openTestDb, testDeps, truncateAll } from '../helpers/db';
import { insertGame, insertGroup, insertUser, played } from '../helpers/fixtures';

class FakeLichess {
  requests: { headers: IncomingHttpHeaders; body: string }[] = [];
  url = '';
  private queue: number[] = [];
  private readonly server: Server;

  private constructor() {
    this.server = createServer((req, res) => {
      let body = '';
      req.setEncoding('utf8');
      req.on('data', (chunk: string) => (body += chunk));
      req.on('end', () => {
        this.requests.push({ headers: req.headers, body });
        const status = this.queue.shift() ?? 200;
        res.statusCode = status;
        res.setHeader('content-type', 'application/json');
        res.end(
          status === 200
            ? JSON.stringify({ id: 'abcd1234', url: 'https://lichess.org/abcd1234' })
            : JSON.stringify({ error: 'no' }),
        );
      });
    });
  }

  static async start(): Promise<FakeLichess> {
    const fake = new FakeLichess();
    await new Promise<void>((resolve) => fake.server.listen(0, '127.0.0.1', () => resolve()));
    fake.url = `http://127.0.0.1:${(fake.server.address() as { port: number }).port}`;
    return fake;
  }

  failNext(status: number): void {
    this.queue.push(status);
  }

  reset(): void {
    this.requests = [];
    this.queue = [];
  }

  stop(): Promise<void> {
    return new Promise((resolve) => this.server.close(() => resolve()));
  }
}

const { db, close } = openTestDb();
const deps = testDeps(db);
let lichess: FakeLichess;

const workerWith = (options: { spacingMs?: number; pauseMs?: number; token?: string } = {}) =>
  new JobWorker({
    db,
    log: deps.log,
    workerId: 'l',
    handlers: lichessJobHandlers({
      deps,
      config: testConfig({ LICHESS_API_URL: lichess.url, LICHESS_TOKEN: options.token }),
      spacingMs: options.spacingMs ?? 0,
      pauseMs: options.pauseMs,
    }),
  });

beforeAll(async () => {
  lichess = await FakeLichess.start();
});
beforeEach(async () => {
  await truncateAll(db);
  lichess.reset();
});
afterAll(async () => {
  await lichess.stop();
  await close();
});

async function finishedGame() {
  const group = await insertGroup(db, { title: 'Chess Club' });
  const alice = await insertUser(db, { firstName: 'Alice' });
  const bob = await insertUser(db, { firstName: 'Bob' });
  const game = await insertGame(db, group.id, alice.id, bob.id, {
    status: 'finished',
    result: '1-0',
    endReason: 'resignation',
    finishedAt: new Date(),
    lichessImportStatus: 'pending',
  });
  return played(db, game, ['e2e4', 'c7c5']);
}

const importJob = (gameId: number, publicId: string) =>
  enqueue(db, { kind: 'lichess_import', payload: { gameId }, dedupKey: `lichess:${publicId}` });
const jobRows = () => db.select().from(jobs).orderBy(jobs.id);
const gameRow = async (id: number) => (await db.select().from(games).where(eq(games.id, id)))[0]!;

describe('lichess_import', () => {
  it('posts the PGN with the bearer token, stores the url and re-edits the card', async () => {
    const game = await finishedGame();
    await importJob(game.id, game.publicId);
    await workerWith({ token: 'tok' }).runOnce();
    const [request] = lichess.requests;
    expect(request?.headers.authorization).toBe('Bearer tok');
    expect(request?.headers['content-type']).toContain('application/x-www-form-urlencoded');
    const pgn = new URLSearchParams(request?.body).get('pgn') ?? '';
    expect(pgn).toContain('[Event "Chess Goat"]');
    expect(pgn).toContain('[Site "Chess Club"]');
    expect(pgn).toContain('1. e4 c5 1-0');
    const after = await gameRow(game.id);
    expect(after.lichessUrl).toBe('https://lichess.org/abcd1234');
    expect(after.lichessImportStatus).toBe('done');
    const pending = (await jobRows()).filter((job) => job.doneAt === null);
    expect(pending.map((job) => [job.kind, job.dedupKey])).toEqual([
      ['edit_card', `card:g:${game.publicId}`],
    ]);
  });

  it('sends no authorization header without a token', async () => {
    const game = await finishedGame();
    await importJob(game.id, game.publicId);
    await workerWith().runOnce();
    expect(lichess.requests[0]?.headers.authorization).toBeUndefined();
  });

  it('counts a 429 as an attempt, retries hours later and holds other imports for a minute', async () => {
    const first = await finishedGame();
    const second = await finishedGame();
    await importJob(first.id, first.publicId);
    lichess.failNext(429);
    const worker = workerWith();
    await worker.runOnce();
    const [job] = await jobRows();
    expect(job?.attempts).toBe(1);
    expect(job?.doneAt).toBeNull();
    expect(job?.lastError).toBe('lichess 429');
    expect(job!.runAt.getTime()).toBeGreaterThan(Date.now() + 2 * 3_600_000);
    expect((await gameRow(first.id)).lichessImportStatus).toBe('pending');

    await importJob(second.id, second.publicId);
    await worker.runOnce();
    expect(lichess.requests).toHaveLength(1);
    const held = (await jobRows()).find((row) => row.dedupKey === `lichess:${second.publicId}`);
    expect(held?.lastError).toBe('lichess pacing');
    expect(held?.doneAt).toBeNull();
  });

  it('keeps one request in flight and spaces the next one', async () => {
    const first = await finishedGame();
    const second = await finishedGame();
    await importJob(first.id, first.publicId);
    await importJob(second.id, second.publicId);
    await workerWith({ spacingMs: 400 }).runOnce();
    expect(lichess.requests).toHaveLength(1);
    const rows = await jobRows();
    expect(rows[0]?.doneAt).not.toBeNull();
    expect(rows[1]?.doneAt).toBeNull();
    expect(rows[1]?.lastError).toBe('lichess pacing');
    expect(rows[1]!.runAt.getTime()).toBeLessThanOrEqual(Date.now() + 1_000);
  });

  it('retries a server error with backoff before the last attempt', async () => {
    const game = await finishedGame();
    await importJob(game.id, game.publicId);
    lichess.failNext(500);
    await workerWith().runOnce();
    const [job] = await jobRows();
    expect(job?.attempts).toBe(1);
    expect(job?.doneAt).toBeNull();
    expect(job?.lastError).toBe('lichess HTTP 500');
    expect(job!.runAt.getTime()).toBeGreaterThan(Date.now() + 2 * 3_600_000);
    expect((await gameRow(game.id)).lichessImportStatus).toBe('pending');
  });

  it('marks the game failed on the eighth failure so the card keeps the fallback link', async () => {
    const game = await finishedGame();
    await db.insert(jobs).values({
      kind: 'lichess_import',
      payload: { gameId: game.id },
      attempts: 7,
      maxAttempts: 8,
    });
    lichess.failNext(503);
    await workerWith().runOnce();
    const [job] = await jobRows();
    expect(job?.failedAt).not.toBeNull();
    expect(job?.lastError).toBe('lichess HTTP 503');
    expect((await gameRow(game.id)).lichessImportStatus).toBe('failed');
  });

  it('marks the game failed after the eighth rate limit', async () => {
    const game = await finishedGame();
    await db.insert(jobs).values({
      kind: 'lichess_import',
      payload: { gameId: game.id },
      attempts: 7,
      maxAttempts: 8,
    });
    lichess.failNext(429);
    await workerWith().runOnce();
    const [job] = await jobRows();
    expect(job?.failedAt).not.toBeNull();
    expect(job?.lastError).toBe('lichess 429');
    expect((await gameRow(game.id)).lichessImportStatus).toBe('failed');
  });

  it('skips a game that is not waiting for an import', async () => {
    const game = await finishedGame();
    await db
      .update(games)
      .set({ lichessImportStatus: 'done', lichessUrl: 'https://lichess.org/x' })
      .where(eq(games.id, game.id));
    await importJob(game.id, game.publicId);
    await workerWith().runOnce();
    expect(lichess.requests).toHaveLength(0);
    expect((await jobRows())[0]?.doneAt).not.toBeNull();
    expect(
      await db
        .select()
        .from(jobs)
        .where(sql`${jobs.kind} = 'edit_card'`),
    ).toHaveLength(0);
  });
});
