import { INITIAL_FEN, type TimePerMove } from '@group-chess/shared';
import { eq, sql } from 'drizzle-orm';
import type { DbOrTx } from '../../src/db/client';
import { generatePublicId } from '../../src/db/ids';
import { touchMember } from '../../src/domain/members';
import {
  challenges,
  dmMessages,
  games,
  groups,
  jobs,
  moves,
  users,
  type ChallengeRow,
  type GameRow,
  type GroupRow,
  type UserRow,
} from '../../src/db/schema';
import { play } from './chess';

let counter = 0;

export async function insertUser(
  db: DbOrTx,
  overrides: Partial<typeof users.$inferInsert> = {},
): Promise<UserRow> {
  counter += 1;
  const [row] = await db
    .insert(users)
    .values({ telegramUserId: 1_000_000 + counter, firstName: `User${counter}`, ...overrides })
    .returning();
  return row!;
}

export async function insertGroup(
  db: DbOrTx,
  overrides: Partial<typeof groups.$inferInsert> = {},
): Promise<GroupRow> {
  counter += 1;
  const [row] = await db
    .insert(groups)
    .values({
      publicId: generatePublicId(),
      telegramChatId: -1_000_000_000_000 - counter,
      title: `Group ${counter}`,
      type: 'supergroup',
      ...overrides,
    })
    .returning();
  return row!;
}

export type GameOverrides = Partial<typeof games.$inferInsert> & {
  /** Seconds relative to now; negative means already passed. */
  deadlineInSeconds?: number;
  reminderInSeconds?: number;
};

export async function insertGame(
  db: DbOrTx,
  groupId: number,
  whiteId: number,
  blackId: number,
  overrides: GameOverrides = {},
): Promise<GameRow> {
  const { deadlineInSeconds, reminderInSeconds, ...rest } = overrides;
  const timePerMove: TimePerMove =
    rest.timePerMove === undefined ? 86400 : (rest.timePerMove as TimePerMove);
  const [row] = await db
    .insert(games)
    .values({
      publicId: generatePublicId(),
      groupId,
      whiteId,
      blackId,
      timePerMove,
      rated: true,
      fen: INITIAL_FEN,
      deadlineAt:
        deadlineInSeconds === undefined
          ? timePerMove === null
            ? null
            : sql`now() + make_interval(secs => ${timePerMove})`
          : sql`now() + make_interval(secs => ${deadlineInSeconds})`,
      reminderAt:
        reminderInSeconds === undefined
          ? null
          : sql`now() + make_interval(secs => ${reminderInSeconds})`,
      ...rest,
    })
    .returning();
  return row!;
}

export async function insertMove(
  db: DbOrTx,
  gameId: number,
  ply: number,
  uci: string,
  san: string,
  fenAfter: string,
): Promise<void> {
  await db
    .insert(moves)
    .values({ gameId, ply, uci, san, fenAfter, clientMoveId: `fixture-${gameId}-${ply}` });
}

export async function insertChallenge(
  db: DbOrTx,
  groupId: number,
  challengerId: number,
  opponentId: number | null,
  overrides: Partial<typeof challenges.$inferInsert> & { expiresInSeconds?: number } = {},
): Promise<ChallengeRow> {
  const { expiresInSeconds = 86_400, ...rest } = overrides;
  const [row] = await db
    .insert(challenges)
    .values({
      publicId: generatePublicId(),
      groupId,
      challengerId,
      opponentId,
      timePerMove: 86400,
      challengerColour: 'random',
      rated: true,
      expiresAt: sql`now() + make_interval(secs => ${expiresInSeconds})`,
      ...rest,
    })
    .returning();
  return row!;
}

export type World = {
  group: GroupRow;
  alice: UserRow;
  bob: UserRow;
  carol: UserRow;
  game: GameRow;
};

type WorldOptions = {
  /** Telegram ids 11, 22 and 33, as the API tests' sessions and the fake Bot API use. */
  telegramIds?: boolean;
  /** Members Telegram has confirmed, as the API requires. */
  verified?: boolean;
};

/**
 * A group with three members, Alice, Bob and Carol, and their game: Alice White, Bob Black, Carol
 * watching. `game: false` leaves the game out.
 */
export function world(db: DbOrTx, opts?: WorldOptions & { game?: GameOverrides }): Promise<World>;
export function world(
  db: DbOrTx,
  opts: WorldOptions & { game: false },
): Promise<Omit<World, 'game'>>;
export async function world(
  db: DbOrTx,
  opts: WorldOptions & { game?: GameOverrides | false } = {},
): Promise<World | Omit<World, 'game'>> {
  const group = await insertGroup(db);
  const person = (firstName: string, telegramUserId: number) =>
    insertUser(db, { firstName, ...(opts.telegramIds ? { telegramUserId } : {}) });
  const alice = await person('Alice', 11);
  const bob = await person('Bob', 22);
  const carol = await person('Carol', 33);
  for (const user of [alice, bob, carol])
    await touchMember(db, group.id, user.id, opts.verified ? { verified: true } : undefined);
  if (opts.game === false) return { group, alice, bob, carol };
  const game = await insertGame(db, group.id, alice.id, bob.id, opts.game);
  return { group, alice, bob, carol, game };
}

/**
 * Plays `ucis` on `game` with the shared arbiter: inserts the move rows after its last ply and
 * moves its position and ply count on. The version is left alone, as `insertGame` leaves it.
 */
export async function played(db: DbOrTx, game: GameRow, ucis: readonly string[]): Promise<GameRow> {
  const rows = play(game.fen, ...ucis);
  for (const row of rows)
    await insertMove(db, game.id, game.plyCount + row.ply, row.uci, row.san, row.fenAfter);
  const [moved] = await db
    .update(games)
    .set({ fen: rows.at(-1)?.fenAfter ?? game.fen, plyCount: game.plyCount + rows.length })
    .where(eq(games.id, game.id))
    .returning();
  return moved!;
}

/** The live DM a player was last sent about a game, as dm_messages records it. */
export async function liveDm(
  db: DbOrTx,
  dm: {
    userId: number;
    gameId: number;
    kind: 'turn' | 'waiting';
    stub: string;
    telegramMessageId?: number;
  },
): Promise<void> {
  await db.insert(dmMessages).values({
    userId: dm.userId,
    chatId: dm.userId,
    gameId: dm.gameId,
    telegramMessageId: dm.telegramMessageId ?? 100 + dm.userId,
    kind: dm.kind,
    stub: dm.stub,
    sentAt: new Date(),
  });
}

/** Seconds from now to a game's deadline or reminder; null when it has none. */
export async function secondsUntil(
  db: DbOrTx,
  column: 'deadline_at' | 'reminder_at',
  gameId: number,
): Promise<number | null> {
  const [row] = await db.execute(
    sql`select extract(epoch from (${sql.raw(column)} - now())) as seconds from games where id = ${gameId}`,
  );
  return row?.seconds === null ? null : Number(row?.seconds);
}

/** Who has a result DM queued. */
export async function resultDms(db: DbOrTx): Promise<number[]> {
  return (await db.select().from(jobs))
    .filter((job) => job.kind === 'send_dm' && job.payload.template === 'result')
    .map((job) => job.payload.userId as number);
}
