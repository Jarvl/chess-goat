import { INITIAL_FEN, type TimePerMove } from '@chess-goat/shared';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { generatePublicId } from '../../src/db/ids';
import { games, users, type UserRow } from '../../src/db/schema';
import { addBotToGroup } from '../../src/domain/botGroups';
import { MAX_LIVE_GAMES_PER_BOT } from '../../src/domain/limits';
import { blockUser, markLeft, touchMember } from '../../src/domain/members';
import type { GameMix } from '../../src/domain/gameMix';
import { checkPairing, isFindableBot, mayPlay } from '../../src/domain/pairing';
import { openTestDb, truncateAll } from '../helpers/db';
import { insertBot, insertGroup, insertUser } from '../helpers/fixtures';

const { db, close } = openTestDb();

beforeEach(() => truncateAll(db));
afterAll(() => close());

/** A group with an admin, a human, two owners in it, two bots of `owner` and one of `otherOwner`. */
async function setup() {
  const group = await insertGroup(db);
  const admin = await insertUser(db);
  const human = await insertUser(db);
  const owner = await insertUser(db);
  const otherOwner = await insertUser(db);
  for (const user of [admin, human, owner, otherOwner]) await touchMember(db, group.id, user.id);
  const bot = await insertBot(db, owner);
  const sibling = await insertBot(db, owner);
  const rival = await insertBot(db, otherOwner);
  for (const b of [bot, sibling]) await addBotToGroup(db, owner.id, b.id, group.id);
  await addBotToGroup(db, otherOwner.id, rival.id, group.id);
  return { group, admin, human, owner, otherOwner, bot, sibling, rival };
}
type World = Awaited<ReturnType<typeof setup>>;

const reload = async (user: UserRow) =>
  (await db.select().from(users).where(eq(users.id, user.id)))[0]!;

/** The reason `p` was refused with, or null when it succeeded. */
const outcome = (p: Promise<unknown>) =>
  p.then(
    () => null,
    (e: { details?: { reason?: string } }) => e.details?.reason ?? String(e),
  );

/** `count` active games for `userId`, seeded in one insert. */
async function busy(groupId: number, userId: number, opponentId: number, count: number) {
  await db.insert(games).values(
    Array.from({ length: count }, () => ({
      publicId: generatePublicId(),
      groupId,
      whiteId: userId,
      blackId: opponentId,
      timePerMove: 86400,
      rated: true,
      fen: INITIAL_FEN,
      deadlineAt: sql`now() + interval '1 day'`,
    })),
  );
}

describe('mayPlay and findableIn agree on every bot', () => {
  const cases: { name: string; arrange: (w: World) => Promise<void>; reason: string | null }[] = [
    { name: 'a bot in the group, its owner too', arrange: async () => {}, reason: null },
    {
      name: 'a bot that left the group',
      arrange: (w) => markLeft(db, w.group.id, w.bot.id),
      reason: 'bot_not_in_group',
    },
    {
      name: 'a bot whose owner left',
      arrange: (w) => markLeft(db, w.group.id, w.owner.id),
      reason: 'owner_not_member',
    },
    {
      name: 'a blocked bot',
      arrange: (w) => blockUser(db, w.group.id, w.bot.id, w.admin.id),
      reason: 'blocked',
    },
    {
      name: 'a bot whose owner is blocked',
      arrange: (w) => blockUser(db, w.group.id, w.owner.id, w.admin.id),
      reason: 'blocked',
    },
    {
      name: 'a deleted bot',
      arrange: async (w) => {
        await db.update(users).set({ deletedAt: new Date() }).where(eq(users.id, w.bot.id));
      },
      reason: 'opponent_gone',
    },
  ];

  for (const c of cases) {
    it(c.name, async () => {
      const w = await setup();
      await c.arrange(w);
      const bot = await reload(w.bot);
      expect(await outcome(mayPlay(db, w.group.id, bot))).toBe(c.reason);
      expect(await isFindableBot(db, w.group.id, bot.id)).toBe(c.reason === null);
    });
  }

  it('a bot never added to the group', async () => {
    const w = await setup();
    const outsider = await insertBot(db, w.owner);
    expect(await outcome(mayPlay(db, w.group.id, outsider))).toBe('bot_not_in_group');
    expect(await isFindableBot(db, w.group.id, outsider.id)).toBe(false);
  });
});

describe('mayPlay for people', () => {
  it('needs no membership row: a challenge by username names someone not yet seen', async () => {
    const w = await setup();
    const stranger = await insertUser(db);
    expect(await outcome(mayPlay(db, w.group.id, stranger))).toBeNull();
  });

  it('refuses a blocked person, and a deleted one', async () => {
    const w = await setup();
    await blockUser(db, w.group.id, w.human.id, w.admin.id);
    expect(await outcome(mayPlay(db, w.group.id, w.human))).toBe('blocked');
    const gone = await insertUser(db, { deletedAt: new Date() });
    expect(await outcome(mayPlay(db, w.group.id, gone))).toBe('opponent_gone');
  });
});

describe('checkPairing', () => {
  type Who = 'human' | 'owner' | 'bot' | 'sibling' | 'rival' | null;
  const cases: {
    name: string;
    challenger: Exclude<Who, null>;
    opponent: Who;
    open?: boolean;
    timePerMove?: TimePerMove;
    expected: string | { mix: GameMix; rated: boolean };
  }[] = [
    {
      name: 'person v person',
      challenger: 'human',
      opponent: 'owner',
      expected: { mix: 'humans', rated: true },
    },
    {
      name: 'person v bot',
      challenger: 'human',
      opponent: 'bot',
      expected: { mix: 'mixed', rated: true },
    },
    {
      name: 'person v bot needs a clock',
      challenger: 'human',
      opponent: 'bot',
      timePerMove: null,
      expected: 'bot_games_need_clock',
    },
    {
      name: 'bot v bot needs no clock',
      challenger: 'bot',
      opponent: 'rival',
      timePerMove: null,
      expected: { mix: 'bots', rated: true },
    },
    {
      name: 'owner v own bot is casual',
      challenger: 'owner',
      opponent: 'bot',
      expected: { mix: 'mixed', rated: false },
    },
    {
      name: 'sibling bots are casual',
      challenger: 'bot',
      opponent: 'sibling',
      expected: { mix: 'bots', rated: false },
    },
    {
      name: 'bots never challenge people',
      challenger: 'bot',
      opponent: 'human',
      expected: 'bots_challenge_bots_only',
    },
    {
      name: 'bots never make open challenges',
      challenger: 'bot',
      opponent: null,
      open: true,
      expected: 'bots_challenge_bots_only',
    },
    {
      name: 'bots never take open challenges',
      challenger: 'human',
      opponent: 'bot',
      open: true,
      expected: 'open_challenges_are_for_people',
    },
    { name: 'nobody plays themselves', challenger: 'human', opponent: 'human', expected: 'self' },
    {
      name: 'an open challenge from a person',
      challenger: 'human',
      opponent: null,
      open: true,
      expected: { mix: 'humans', rated: true },
    },
  ];

  for (const c of cases) {
    it(c.name, async () => {
      const w = await setup();
      const pick = (who: Who) => (who === null ? null : w[who]);
      const result = checkPairing(
        db,
        w.group.id,
        { challenger: pick(c.challenger)!, opponent: pick(c.opponent), open: c.open ?? false },
        { timePerMove: c.timePerMove === undefined ? 86400 : c.timePerMove, rated: true },
      );
      if (typeof c.expected === 'string') expect(await outcome(result)).toBe(c.expected);
      else expect(await result).toEqual(c.expected);
    });
  }

  it('casual stays casual', async () => {
    const w = await setup();
    const pair = { challenger: w.human, opponent: w.bot, open: false };
    expect(await checkPairing(db, w.group.id, pair, { timePerMove: 86400, rated: false })).toEqual({
      mix: 'mixed',
      rated: false,
    });
  });

  it('checks both players may play here', async () => {
    const w = await setup();
    await markLeft(db, w.group.id, w.otherOwner.id);
    const terms = { timePerMove: 86400, rated: true } as const;
    expect(
      await outcome(
        checkPairing(db, w.group.id, { challenger: w.bot, opponent: w.rival, open: false }, terms),
      ),
    ).toBe('owner_not_member');
    expect(
      await outcome(
        checkPairing(db, w.group.id, { challenger: w.rival, opponent: w.bot, open: false }, terms),
      ),
    ).toBe('owner_not_member');
  });

  it(`a bot with ${MAX_LIVE_GAMES_PER_BOT} live games is busy, on either side, and says which`, async () => {
    const w = await setup();
    const terms = { timePerMove: 86400, rated: true } as const;
    await busy(w.group.id, w.rival.id, w.human.id, MAX_LIVE_GAMES_PER_BOT - 1);
    expect(
      await checkPairing(
        db,
        w.group.id,
        { challenger: w.bot, opponent: w.rival, open: false },
        terms,
      ),
    ).toMatchObject({ mix: 'bots' });
    await busy(w.group.id, w.rival.id, w.human.id, 1);
    for (const pair of [
      { challenger: w.bot, opponent: w.rival, open: false },
      { challenger: w.rival, opponent: w.bot, open: false },
      { challenger: w.human, opponent: w.rival, open: false },
    ]) {
      await expect(checkPairing(db, w.group.id, pair, terms)).rejects.toMatchObject({
        code: 'limit_exceeded',
        details: {
          reason: 'too_many_live_games',
          limit: MAX_LIVE_GAMES_PER_BOT,
          subjectId: w.rival.id,
        },
      });
    }
  });
});
