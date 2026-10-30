import type { EngineLevel } from '@group-chess/shared';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { challenges, games, jobs, users } from '../../src/db/schema';
import { DomainError } from '../../src/domain/errors';
import { createEngineGame, getEngineUser } from '../../src/domain/engineGames';
import { touchMember } from '../../src/domain/members';
import { openTestDb, testDeps, truncateAll } from '../helpers/db';
import { insertGroup, insertUser } from '../helpers/fixtures';

const { db, close } = openTestDb();
const deps = testDeps(db);

beforeEach(() => truncateAll(db));
afterAll(() => close());

async function setup(userOverrides: Partial<typeof users.$inferInsert> = {}) {
  const group = await insertGroup(db);
  const alice = await insertUser(db, { firstName: 'Alice', ...userOverrides });
  await touchMember(db, group.id, alice.id);
  return { group, alice };
}

describe('createEngineGame', () => {
  it('creates a started, unrated game against the engine with no challenge and no card job', async () => {
    const { group, alice } = await setup();
    const game = await createEngineGame(deps, {
      groupId: group.id,
      userId: alice.id,
      level: 'club',
      colour: 'white',
    });
    expect(game.status).toBe('active');
    expect(game.rated).toBe(false);
    expect(game.engineLevel).toBe('club');
    expect(game.whiteId).toBe(alice.id);
    expect(game.blackId).toBe((await getEngineUser(db)).id);
    expect(await db.select().from(challenges)).toHaveLength(0);
    const kinds = (await db.select().from(jobs)).map((job) => job.kind);
    expect(kinds).not.toContain('send_challenge_card');
    expect(kinds).not.toContain('edit_card');
  });

  it('enqueues an engine move immediately when the engine has white', async () => {
    const { group, alice } = await setup();
    const game = await createEngineGame(deps, {
      groupId: group.id,
      userId: alice.id,
      level: 'club',
      colour: 'black',
    });
    const engineJobs = (await db.select().from(jobs)).filter((job) => job.kind === 'engine_move');
    expect(engineJobs).toHaveLength(1);
    expect(game.deadlineAt).toBeNull();
  });

  it('caps nothing: a player may have many bot games at once', async () => {
    const { group, alice } = await setup();
    // This is what keeps an abandoned bot game from locking anyone out. Bot games have no clock, so
    // nothing ever ends one on its own; if a cap existed, two forgotten games would block the third
    // for good — and, when the cap was the group-wide one, human challenges too.
    for (let i = 0; i < 5; i += 1) {
      await expect(
        createEngineGame(deps, {
          groupId: group.id,
          userId: alice.id,
          level: 'club',
          colour: 'white',
        }),
      ).resolves.toBeDefined();
    }
    expect(await db.select().from(games)).toHaveLength(5);
  });

  it('refuses an out-of-table engine level and writes no game row', async () => {
    const { group, alice } = await setup();
    await expect(
      createEngineGame(deps, {
        groupId: group.id,
        userId: alice.id,
        // Cast past the compile-time union: the point of this test is the runtime guard.
        level: 'grandmaster' as EngineLevel,
        colour: 'white',
      }),
    ).rejects.toBeInstanceOf(DomainError);
    expect(await db.select().from(games)).toHaveLength(0);
  });

  it('has no clock at all: no time control, no deadline, no reminder, on either colour', async () => {
    const { group, alice } = await setup({ dmAllowed: true });

    for (const colour of ['white', 'black'] as const) {
      const game = await createEngineGame(deps, {
        groupId: group.id,
        userId: alice.id,
        level: 'club',
        colour,
      });
      expect(game.timePerMove).toBeNull();
      expect(game.deadlineAt).toBeNull();
      expect(game.reminderAt).toBeNull();
    }
  });
});
