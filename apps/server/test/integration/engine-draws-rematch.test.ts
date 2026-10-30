import { INITIAL_FEN } from '@group-chess/shared';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { challenges, jobs } from '../../src/db/schema';
import { createRematch } from '../../src/domain/challenges';
import { offerDraw } from '../../src/domain/draws';
import { isDomainError } from '../../src/domain/errors';
import { createEngineGame } from '../../src/domain/engineGames';
import { getGameDto, requireGameByPublicId, resign } from '../../src/domain/games';
import { touchMember } from '../../src/domain/members';
import { openTestDb, testDeps, truncateAll } from '../helpers/db';
import { gameAwaitingEngine } from '../helpers/engineJob';
import { insertGame, insertGroup, insertUser } from '../helpers/fixtures';

const { db, close } = openTestDb();
const deps = testDeps(db);
let group: Awaited<ReturnType<typeof insertGroup>>;
let alice: Awaited<ReturnType<typeof insertUser>>;

beforeEach(async () => {
  await truncateAll(db);
  group = await insertGroup(db);
  alice = await insertUser(db, { firstName: 'Alice' });
  await touchMember(db, group.id, alice.id);
});
afterAll(() => close());

describe('GameDto.engineLevel', () => {
  it('carries the level in the game DTO so the app can label and rematch', async () => {
    const game = await createEngineGame(deps, {
      groupId: group.id,
      userId: alice.id,
      level: 'strong',
      colour: 'white',
    });
    const dto = await getGameDto(deps, { gameId: game.publicId, viewerUserId: alice.id });
    expect(dto.engineLevel).toBe('strong');
  });

  it('leaves engineLevel null on a human game', async () => {
    const bob = await insertUser(db, { firstName: 'Bob' });
    const game = await insertGame(db, group.id, alice.id, bob.id, { fen: INITIAL_FEN });
    const dto = await getGameDto(deps, { gameId: game.publicId, viewerUserId: alice.id });
    expect(dto.engineLevel).toBeNull();
  });
});

describe('draw offers against the bot', () => {
  it('refuses a draw offer, leaving no offer and queueing no engine job', async () => {
    const game = await gameAwaitingEngine(deps, { groupId: group.id, userId: alice.id });
    const jobsBefore = (await db.select().from(jobs)).length;
    const error = await offerDraw(deps, { gameId: game.publicId, userId: alice.id }).catch(
      (err) => err,
    );
    expect(isDomainError(error) && error.details?.reason).toBe('engine_game');
    expect((await requireGameByPublicId(db, game.publicId)).drawOfferBy).toBeNull();
    expect(await db.select().from(jobs)).toHaveLength(jobsBefore);
  });
});

describe('rematch against the bot', () => {
  it('refuses a rematch challenge for an engine game, creating no challenge and no card job', async () => {
    const game = await createEngineGame(deps, {
      groupId: group.id,
      userId: alice.id,
      level: 'club',
      colour: 'white',
    });
    await resign(deps, { gameId: game.publicId, userId: alice.id });
    const error = await createRematch(deps, { gameId: game.id, userId: alice.id }).catch(
      (err) => err,
    );
    expect(isDomainError(error)).toBe(true);
    expect(await db.select().from(challenges)).toHaveLength(0);
    expect((await db.select().from(jobs)).map((job) => job.kind)).not.toContain(
      'send_challenge_card',
    );
  });
});
