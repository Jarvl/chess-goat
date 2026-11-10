import { eq } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { matchNotes, turnLeases, users } from '../../src/db/schema';
import { createBot, updateBot } from '../../src/domain/bots';
import {
  clearBotNotes,
  getMatchNotes,
  setBotNotes,
  setMatchNotes,
  validPersona,
} from '../../src/domain/botNotes';
import { openTestDb, truncateAll } from '../helpers/db';
import { insertBot, insertGame, insertGroup, insertUser } from '../helpers/fixtures';

const { db, close } = openTestDb();

beforeEach(() => truncateAll(db));
afterAll(() => close());

async function setup() {
  const owner = await insertUser(db);
  const bot = await insertBot(db, owner);
  const other = await insertBot(db, owner);
  const group = await insertGroup(db);
  const game = await insertGame(db, group.id, bot.id, other.id);
  const lease = async (ply: number) =>
    (
      await db
        .insert(turnLeases)
        .values({ botId: bot.id, kind: 'move', gameId: game.id, ply, notesRevisionSeen: 0 })
        .returning()
    )[0]!.id;
  return { owner, bot, game, leaseA: await lease(1), leaseB: await lease(2) };
}

describe('bot notes', () => {
  it('refuses bot notes one code point over the limit and says by how much', async () => {
    const { bot, leaseA: leaseId } = await setup();
    const botId = bot.id;
    await expect(
      setBotNotes(db, { botId, leaseId, text: '🐐'.repeat(4001) }),
    ).rejects.toMatchObject({ details: { reason: 'notes_too_long', over: 1, limit: 4000 } });
    await expect(setBotNotes(db, { botId, leaseId, text: '🐐'.repeat(4000) })).resolves.toEqual({
      revision: 1,
    });
  });

  it('refuses a write over notes another lease changed, then accepts the retry', async () => {
    const { bot, leaseA, leaseB } = await setup();
    const botId = bot.id;
    await setBotNotes(db, { botId, leaseId: leaseA, text: 'from A' });
    await expect(setBotNotes(db, { botId, leaseId: leaseB, text: 'from B' })).rejects.toMatchObject(
      { details: { reason: 'notes_changed', current: 'from A' } },
    );
    const [seen] = await db.select().from(turnLeases).where(eq(turnLeases.id, leaseB));
    expect(seen!.notesRevisionSeen).toBe(1);
    await expect(
      setBotNotes(db, { botId, leaseId: leaseB, text: 'from A\nfrom B' }),
    ).resolves.toEqual({ revision: 2 });
    const [row] = await db.select().from(users).where(eq(users.id, botId));
    expect(row).toMatchObject({ botNotes: 'from A\nfrom B', botNotesRevision: 2 });
  });

  it('treats a lease that has seen no revision as stale, once', async () => {
    const { bot, leaseA } = await setup();
    await db.update(turnLeases).set({ notesRevisionSeen: null }).where(eq(turnLeases.id, leaseA));
    const input = { botId: bot.id, leaseId: leaseA, text: 'x' };
    await expect(setBotNotes(db, input)).rejects.toMatchObject({
      details: { reason: 'notes_changed', current: '' },
    });
    await expect(setBotNotes(db, input)).resolves.toEqual({ revision: 1 });
  });

  it('clearBotNotes empties the notes and bumps the revision', async () => {
    const { bot, leaseA } = await setup();
    await setBotNotes(db, { botId: bot.id, leaseId: leaseA, text: 'keep' });
    await clearBotNotes(db, bot.id);
    const [row] = await db.select().from(users).where(eq(users.id, bot.id));
    expect(row).toMatchObject({ botNotes: '', botNotesRevision: 2 });
  });
});

describe('match notes', () => {
  it('replace whole and stop at 2000', async () => {
    const { bot, game } = await setup();
    const botId = bot.id;
    const gameId = game.id;
    expect(await getMatchNotes(db, botId, gameId)).toBe('');
    await setMatchNotes(db, { botId, gameId, text: 'one' });
    await setMatchNotes(db, { botId, gameId, text: 'two' });
    expect(await getMatchNotes(db, botId, gameId)).toBe('two');
    await expect(
      setMatchNotes(db, { botId, gameId, text: '🐐'.repeat(2001) }),
    ).rejects.toMatchObject({ details: { reason: 'notes_too_long', over: 1, limit: 2000 } });
    await setMatchNotes(db, { botId, gameId, text: '🐐'.repeat(2000) });
    expect(await db.select().from(matchNotes)).toHaveLength(1);
  });
});

describe('persona', () => {
  it('validPersona trims, nulls the empty and counts code points', () => {
    expect(validPersona('  a gambiteer ')).toBe('a gambiteer');
    expect(validPersona('   ')).toBeNull();
    expect(validPersona(undefined)).toBeNull();
    expect(validPersona('🐐'.repeat(4000))).not.toBeNull();
    expect(() => validPersona('🐐'.repeat(4002))).toThrowError(
      expect.objectContaining({ details: { reason: 'persona_too_long', over: 2, limit: 4000 } }),
    );
  });

  it('createBot stores a trimmed persona and treats whitespace as none', async () => {
    const owner = await insertUser(db);
    const a = await createBot(db, owner.id, { name: 'Alpha', persona: '  bold  ' });
    const b = await createBot(db, owner.id, { name: 'Beta', persona: '   ' });
    expect(a.persona).toBe('bold');
    expect(b.persona).toBeNull();
  });

  it('updateBot leaves persona alone when undefined, clears it on null or empty, can clear notes', async () => {
    const { owner, bot, leaseA } = await setup();
    await setBotNotes(db, { botId: bot.id, leaseId: leaseA, text: 'n' });
    let row = await updateBot(db, owner.id, bot.id, { persona: ' witty ' });
    expect(row.persona).toBe('witty');
    row = await updateBot(db, owner.id, bot.id, { name: 'Renamed' });
    expect(row.persona).toBe('witty');
    expect(row.botNotes).toBe('n');
    row = await updateBot(db, owner.id, bot.id, { persona: null, clearNotes: true });
    expect(row).toMatchObject({ persona: null, botNotes: '', botNotesRevision: 2 });
    await updateBot(db, owner.id, bot.id, { persona: 'x' });
    row = await updateBot(db, owner.id, bot.id, { persona: '' });
    expect(row.persona).toBeNull();
  });
});
