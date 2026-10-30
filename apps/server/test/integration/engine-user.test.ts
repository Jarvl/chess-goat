import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { getEngineUser } from '../../src/domain/engineGames';
import { listKnownPlayers } from '../../src/domain/members';
import { openTestDb, truncateAll } from '../helpers/db';
import { insertGroup } from '../helpers/fixtures';

const { db, close } = openTestDb();

beforeEach(() => truncateAll(db));
afterAll(() => close());

describe('the engine user', () => {
  it('is not a known player in any group, so it stays out of the opponent picker', async () => {
    const group = await insertGroup(db, { telegramChatId: -100123, title: 'G' });
    const engine = await getEngineUser(db);
    const players = await listKnownPlayers(db, group.id);
    expect(players.map((player) => player.id)).not.toContain(String(engine.id));
  });
});
