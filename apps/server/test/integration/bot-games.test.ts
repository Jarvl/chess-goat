import { t } from '@chess-goat/shared';
import { eq } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { challenges, games, jobs, type GameRow } from '../../src/db/schema';
import { replyFor } from '../../src/bot/replies';
import { addBotToGroup } from '../../src/domain/botGroups';
import { acceptChallenge, declineChallenge } from '../../src/domain/challenges';
import { offerDraw } from '../../src/domain/draws';
import { playMove, resign, voidGame } from '../../src/domain/games';
import { activeGames, listFinished, pendingChallenges } from '../../src/domain/lobby';
import { touchMember } from '../../src/domain/members';
import { openTestDb, testDeps, truncateAll } from '../helpers/db';
import {
  insertBot,
  insertChallenge,
  insertGame,
  insertGroup,
  insertUser,
} from '../helpers/fixtures';

const { db, close } = openTestDb();
const deps = testDeps(db);

beforeEach(() => truncateAll(db));
afterAll(() => close());

/**
 * A group with a human and two bots of different owners. Everyone has DMs on, bots included, so
 * the tests show that a bot is never DMed or reminded even when its row says it could be.
 */
async function setup() {
  const group = await insertGroup(db);
  const human = await insertUser(db, { username: 'human', dmAllowed: true });
  const owner = await insertUser(db);
  const otherOwner = await insertUser(db);
  const bot = await insertBot(db, owner, { dmAllowed: true });
  const rival = await insertBot(db, otherOwner, { dmAllowed: true });
  for (const user of [human, owner, otherOwner]) await touchMember(db, group.id, user.id);
  await addBotToGroup(db, owner.id, bot.id, group.id);
  await addBotToGroup(db, otherOwner.id, rival.id, group.id);
  return { group, human, owner, otherOwner, bot, rival };
}

let moveCounter = 0;
async function move(game: GameRow, userId: number, uci: string) {
  const [row] = await db.select().from(games).where(eq(games.id, game.id));
  moveCounter += 1;
  return playMove(deps, {
    gameId: game.publicId,
    userId,
    uci,
    expectedPly: row!.plyCount,
    clientMoveId: `m${moveCounter}`,
  });
}

const allJobs = () => db.select().from(jobs).orderBy(jobs.id);
const jobKinds = async () => (await allJobs()).map((j) => j.kind);
const reminderAt = async (gameId: number) =>
  (await db.select().from(games).where(eq(games.id, gameId)))[0]!.reminderAt;
const dmJobsFor = async (userId: number) =>
  (await allJobs()).filter(
    (j) => j.kind === 'send_dm' && (j.payload as { userId: number }).userId === userId,
  );

const reason = async (p: Promise<unknown>) => {
  const error = await p.then(
    () => null,
    (e: unknown) => e as { code: string; details?: { reason?: string } },
  );
  expect(error).not.toBeNull();
  return error!.details?.reason;
};

describe('bot games', () => {
  it('a bot-vs-bot game posts nothing', async () => {
    const { group, bot, rival } = await setup();
    const game = await insertGame(db, group.id, bot.id, rival.id, { botPlayers: 2 });
    await move(game, bot.id, 'e2e4');
    expect(await reminderAt(game.id)).toBeNull();
    await move(game, rival.id, 'e7e5');
    expect(await reminderAt(game.id)).toBeNull();
    await offerDraw(deps, { gameId: game.publicId, userId: bot.id });
    await move(game, bot.id, 'g1f3');
    expect(await reminderAt(game.id)).toBeNull();
    await resign(deps, { gameId: game.publicId, userId: rival.id });
    const kinds = await jobKinds();
    expect(kinds).not.toContain('edit_card');
    expect(kinds).not.toContain('send_result_photo');
    expect(kinds).not.toContain('send_dm');
    // Games with a bot in them are never imported to Lichess; the Analyse button opens the board.
    expect(kinds).not.toContain('lichess_import');
    expect(await reminderAt(game.id)).toBeNull();
  });

  it('a bot-vs-bot accept sets no reminder and edits no card', async () => {
    const { group, bot, rival } = await setup();
    const challenge = await insertChallenge(db, group.id, bot.id, rival.id, {
      botPlayers: 2,
      challengerColour: 'white',
    });
    const { game } = await acceptChallenge(deps, { challengeId: challenge.id, userId: rival.id });
    expect(game.reminderAt).toBeNull();
    expect(await jobKinds()).toEqual([]);
  });

  it('a human-vs-bot accept reminds only the human', async () => {
    const { group, human, bot } = await setup();
    const asBotWhite = await insertChallenge(db, group.id, human.id, bot.id, {
      botPlayers: 1,
      challengerColour: 'black',
    });
    const first = await acceptChallenge(deps, { challengeId: asBotWhite.id, userId: bot.id });
    expect(first.game.whiteId).toBe(bot.id);
    expect(first.game.reminderAt).toBeNull();
    expect(await dmJobsFor(bot.id)).toEqual([]);

    const asHumanWhite = await insertChallenge(db, group.id, human.id, bot.id, {
      botPlayers: 1,
      challengerColour: 'white',
    });
    const second = await acceptChallenge(deps, { challengeId: asHumanWhite.id, userId: bot.id });
    expect(second.game.whiteId).toBe(human.id);
    expect(second.game.reminderAt).not.toBeNull();
  });

  it('a human-vs-bot game edits the card and posts a result photo, and DMs only the human', async () => {
    const { group, human, bot } = await setup();
    const game = await insertGame(db, group.id, bot.id, human.id, { botPlayers: 1 });
    await move(game, bot.id, 'e2e4');
    expect(await jobKinds()).toContain('edit_card');
    const turnDms = (await dmJobsFor(human.id)).filter(
      (j) => (j.payload as { template: string }).template === 'turn',
    );
    expect(turnDms).toHaveLength(1);
    expect(await reminderAt(game.id)).not.toBeNull();

    await move(game, human.id, 'e7e5');
    expect(await dmJobsFor(bot.id)).toEqual([]);
    expect(await reminderAt(game.id)).toBeNull();

    // The human's draw offer, made while the bot is to move, is no DM to the bot.
    await move(game, bot.id, 'g1f3');
    await move(game, human.id, 'b8c6');
    await offerDraw(deps, { gameId: game.publicId, userId: human.id });
    expect(await dmJobsFor(bot.id)).toEqual([]);

    await resign(deps, { gameId: game.publicId, userId: human.id });
    expect((await jobKinds()).filter((k) => k === 'send_result_photo')).toHaveLength(1);
    expect(await dmJobsFor(bot.id)).toEqual([]);
    expect(await jobKinds()).not.toContain('lichess_import');
    const [finished] = await db.select().from(games).where(eq(games.id, game.id));
    expect(finished!.lichessImportStatus).toBeNull();
  });

  it('voiding a bot-vs-bot game edits no card', async () => {
    const { group, owner, bot, rival } = await setup();
    const game = await insertGame(db, group.id, bot.id, rival.id, { botPlayers: 2 });
    await voidGame(deps, { gameId: game.publicId, adminUserId: owner.id });
    expect(await jobKinds()).not.toContain('edit_card');
  });

  it('the lobby leaves out bot-vs-bot games but lists human-vs-bot ones', async () => {
    const { group, human, bot, rival } = await setup();
    const both = await insertGame(db, group.id, bot.id, rival.id, { botPlayers: 2 });
    const one = await insertGame(db, group.id, human.id, bot.id, { botPlayers: 1 });
    const bothDone = await insertGame(db, group.id, rival.id, bot.id, {
      botPlayers: 2,
      status: 'finished',
      result: '1-0',
      endReason: 'resignation',
      finishedAt: new Date(),
    });
    const oneDone = await insertGame(db, group.id, bot.id, human.id, {
      botPlayers: 1,
      status: 'finished',
      result: '0-1',
      endReason: 'resignation',
      finishedAt: new Date(),
    });
    const active = (await activeGames(db, group.id, human.id)).map((g) => g.id);
    expect(active).toEqual([one.publicId]);
    expect(active).not.toContain(both.publicId);
    const finished = (await listFinished(deps, group.id, human.id, null)).items.map((g) => g.id);
    expect(finished).toEqual([oneDone.publicId]);
    expect(finished).not.toContain(bothDone.publicId);
  });

  it('the lobby leaves out bot-vs-bot challenges but lists human-vs-bot ones', async () => {
    const { group, human, bot, rival } = await setup();
    await insertChallenge(db, group.id, bot.id, rival.id, { botPlayers: 2 });
    const one = await insertChallenge(db, group.id, human.id, bot.id, { botPlayers: 1 });
    const pending = await pendingChallenges(db, group.id, human);
    expect(pending.map((c) => c.id)).toEqual([one.publicId]);
  });
});

describe('bots and challenge buttons', () => {
  it('a bot cannot take an open challenge', async () => {
    const { group, human, bot } = await setup();
    const open = await insertChallenge(db, group.id, human.id, null);
    expect(await reason(acceptChallenge(deps, { challengeId: open.id, userId: bot.id }))).toBe(
      'open_challenges_are_for_people',
    );
    const error = await acceptChallenge(deps, { challengeId: open.id, userId: bot.id }).catch(
      (e: unknown) => e,
    );
    expect(error).toMatchObject({ code: 'forbidden' });
    const reply = replyFor(error);
    expect(reply && t(reply.key, reply.params)).toBe("Bots can't take open challenges.");
    const [row] = await db.select().from(challenges).where(eq(challenges.id, open.id));
    expect(row?.status).toBe('pending');
  });

  it('someone else tapping Cancel on a challenge to a bot is told only the challenger can', async () => {
    const { group, human, owner, bot, rival } = await setup();
    const created = await insertChallenge(db, group.id, human.id, bot.id, { botPlayers: 1 });
    const error = declineChallenge(deps, { challengeId: created.id, userId: owner.id });
    expect(await reason(error)).toBe('not_the_challenger');
    // The bot itself may still decline.
    await declineChallenge(deps, { challengeId: created.id, userId: bot.id });
    const silent = await insertChallenge(db, group.id, bot.id, rival.id, { botPlayers: 2 });
    expect(await reason(declineChallenge(deps, { challengeId: silent.id, userId: human.id }))).toBe(
      'not_the_challenger',
    );
  });
});
