import { encodeStartParam } from '@chess-goat/shared';
import { eq } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { users } from '../../src/db/schema';
import { playerPage } from '../../src/domain/lobby';
import { blockUser, touchMember } from '../../src/domain/members';
import { renderChallengeCard, renderGameCard } from '../../src/telegram/cards';
import { challengeCardView, gameCardView } from '../../src/telegram/views';
import { testConfig } from '../helpers/config';
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
const config = testConfig();

beforeEach(() => truncateAll(db));
afterAll(() => close());

async function setup() {
  const group = await insertGroup(db);
  const human = await insertUser(db, { username: 'human' });
  const owner = await insertUser(db, { username: 'owner' });
  const bot = await insertBot(db, owner, { firstName: 'Rook', tagline: 'Loves endgames' });
  const rival = await insertBot(db, owner, { firstName: 'Knight' });
  for (const user of [human, owner, bot, rival]) await touchMember(db, group.id, user.id);
  return { group, human, owner, bot, rival };
}

const link = (group: { publicId: string }, bot: { id: number }) =>
  `https://t.me/TestChessBot/chess?startapp=${encodeStartParam({
    kind: 'challengeBot',
    groupId: group.publicId,
    botId: bot.id,
  })}`;

describe('bot profile page', () => {
  it('carries the bot block, and its bot-vs-bot games', async () => {
    const { group, human, bot, rival } = await setup();
    const botGame = await insertGame(db, group.id, bot.id, rival.id, {
      status: 'finished',
      result: '1-0',
      botPlayers: 2,
    });
    const humanGame = await insertGame(db, group.id, human.id, bot.id, {
      status: 'finished',
      result: '0-1',
      botPlayers: 1,
    });
    const page = await playerPage(deps, group.id, human.id, bot.id);
    expect(page.bot).toEqual({
      tagline: 'Loves endgames',
      owner: '@owner',
      lastActiveAt: null,
      isMine: false,
      findable: true,
    });
    expect(page.recentGames.map((g) => g.id).sort()).toEqual(
      [botGame.publicId, humanGame.publicId].sort(),
    );
  });

  it('marks the owner’s view as mine', async () => {
    const { group, owner, bot } = await setup();
    expect((await playerPage(deps, group.id, owner.id, bot.id)).bot?.isMine).toBe(true);
  });

  it('says the bot cannot be challenged here once it is blocked', async () => {
    const { group, human, owner, bot } = await setup();
    await blockUser(db, group.id, bot.id, owner.id);
    expect((await playerPage(deps, group.id, human.id, bot.id)).bot?.findable).toBe(false);
  });

  it("falls back to 'Unknown' for a bot with no owner name", async () => {
    const { group, human, bot } = await setup();
    await db.update(users).set({ ownerName: null }).where(eq(users.id, bot.id));
    expect((await playerPage(deps, group.id, human.id, bot.id)).bot?.owner).toBe('Unknown');
  });

  it('has no bot block for a deleted bot', async () => {
    const { group, human, bot } = await setup();
    await db.update(users).set({ deletedAt: new Date() }).where(eq(users.id, bot.id));
    const page = await playerPage(deps, group.id, human.id, bot.id);
    expect(page.bot).toBeNull();
    expect(page.deleted).toBe(true);
  });

  it('flags a deleted person, and only then', async () => {
    const { group, human, owner } = await setup();
    expect((await playerPage(deps, group.id, human.id, owner.id)).deleted).toBe(false);
    await db.update(users).set({ deletedAt: new Date() }).where(eq(users.id, owner.id));
    expect((await playerPage(deps, group.id, human.id, owner.id)).deleted).toBe(true);
  });

  it('has no bot block for a person', async () => {
    const { group, human, owner } = await setup();
    expect((await playerPage(deps, group.id, human.id, owner.id)).bot).toBeNull();
  });
});

describe('Challenge buttons on cards', () => {
  const rows = (card: { reply_markup?: { inline_keyboard: unknown[][] } }) =>
    card.reply_markup?.inline_keyboard ?? [];

  it('a finished human-vs-bot game card links to challenging that bot', async () => {
    const { group, human, bot } = await setup();
    const game = await insertGame(db, group.id, human.id, bot.id, {
      status: 'finished',
      result: '1-0',
      endReason: 'checkmate',
      botPlayers: 1,
    });
    const card = renderGameCard(await gameCardView(db, game, group, config));
    expect(rows(card)).toContainEqual([
      { text: 'Challenge 🤖 Rook (@owner)', url: link(group, bot) },
    ]);
  });

  it('a card rendered after the bot is deleted has none', async () => {
    const { group, human, bot } = await setup();
    const game = await insertGame(db, group.id, human.id, bot.id, {
      status: 'finished',
      result: '1-0',
      endReason: 'checkmate',
      botPlayers: 1,
    });
    await db.update(users).set({ deletedAt: new Date() }).where(eq(users.id, bot.id));
    const card = renderGameCard(await gameCardView(db, game, group, config));
    expect(JSON.stringify(card.reply_markup)).not.toContain('Challenge');
  });

  it('a human-vs-human game card has none', async () => {
    const { group, human, owner } = await setup();
    const game = await insertGame(db, group.id, human.id, owner.id, {
      status: 'finished',
      result: '1-0',
      endReason: 'checkmate',
    });
    const card = renderGameCard(await gameCardView(db, game, group, config));
    expect(JSON.stringify(card.reply_markup)).not.toContain('Challenge');
  });

  it('a pending challenge to a bot has none; an expired one does', async () => {
    const { group, human, bot } = await setup();
    const pending = await insertChallenge(db, group.id, human.id, bot.id, { botPlayers: 1 });
    const pendingCard = renderChallengeCard(await challengeCardView(db, pending, group, config));
    expect(JSON.stringify(pendingCard.reply_markup)).not.toContain('Challenge 🤖');
    const expired = { ...pending, status: 'expired' as const };
    const expiredCard = renderChallengeCard(await challengeCardView(db, expired, group, config));
    expect(rows(expiredCard)[0]).toEqual([
      { text: 'Challenge 🤖 Rook (@owner)', url: link(group, bot) },
    ]);
  });

  it('a settled challenge card rendered after the bot is deleted has none', async () => {
    const { group, human, bot } = await setup();
    const expired = await insertChallenge(db, group.id, human.id, bot.id, {
      botPlayers: 1,
      status: 'expired',
    });
    await db.update(users).set({ deletedAt: new Date() }).where(eq(users.id, bot.id));
    const card = renderChallengeCard(await challengeCardView(db, expired, group, config));
    expect(JSON.stringify(card.reply_markup)).not.toContain('Challenge 🤖');
  });

  it('an active human-vs-bot card shows the activity line on the bot’s turn only', async () => {
    const { group, human, bot } = await setup();
    const botTurn = await insertGame(db, group.id, human.id, bot.id, {
      plyCount: 1,
      fen: 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1',
      botPlayers: 1,
    });
    const text = renderGameCard(await gameCardView(db, botTurn, group, config)).text;
    expect(text).toContain("🤖 Rook (@owner) hasn't been active yet.");
    const myTurn = await insertGame(db, group.id, human.id, bot.id, { botPlayers: 1 });
    expect(renderGameCard(await gameCardView(db, myTurn, group, config)).text).not.toContain(
      'active',
    );
  });
});
