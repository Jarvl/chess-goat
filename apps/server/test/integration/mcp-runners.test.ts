import { eq } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { runners, turnLeases, users, type UserRow } from '../../src/db/schema';
import { createOwnerToken } from '../../src/domain/ownerTokens';
import { touchMember } from '../../src/domain/members';
import { releaseTurn } from '../../src/domain/turnLeases';
import type { TestApi } from '../helpers/api';
import { openTestDb, truncateAll } from '../helpers/db';
import {
  insertBot,
  insertChallenge,
  insertGame,
  insertGroup,
  insertUser,
} from '../helpers/fixtures';
import { callTool, mcpCall, resultText, startTestMcp } from '../helpers/mcp';
import { claimFor } from '../helpers/mcp';

const { db, close } = openTestDb();
let api: TestApi;
let owner: UserRow;
let token: string;

async function start(overrides: Parameters<typeof startTestMcp>[1] = {}) {
  if (api) await api.stop();
  api = await startTestMcp(db, overrides);
}
beforeEach(async () => {
  await truncateAll(db);
  await start();
  owner = await insertUser(db, { username: 'alice' });
  token = await db.transaction((tx) => createOwnerToken(tx, owner.id));
});
afterAll(async () => {
  await api?.stop();
  await close();
});

type Linked = { alreadyServed: boolean; command?: string; code?: string; expiresAt?: string };
type Listed = {
  runners: {
    id: number;
    label: string;
    harness: string | null;
    bots: 'all' | string[];
    connected: boolean;
    lastSeenAt: string | null;
  }[];
};
type BotOut = {
  id: number;
  online: boolean;
  failingTurns: number;
  pendingChallenges: number;
  persona?: string | null;
};

const call = <O = Record<string, unknown>>(name: string, args: Record<string, unknown> = {}) =>
  callTool<O>(api.app, token, name, args);

/** A runner of `ownerRow` last seen `agoSeconds` ago. */
async function runner(ownerRow: UserRow, agoSeconds: number, botIds: number[] | null = null) {
  const [row] = await db
    .insert(runners)
    .values({
      ownerId: ownerRow.id,
      label: 'Living-room PC',
      harness: 'claude',
      credentialHash: Buffer.from(`${Math.random()}`),
      botIds,
      lastSeenAt: new Date(Date.now() - agoSeconds * 1000),
    })
    .returning();
  return row!;
}

describe('link_runner', () => {
  it('returns the command, with and without a preset', async () => {
    const plain = await call<Linked>('link_runner', { label: 'Desk' });
    expect(plain.isError).toBeFalsy();
    const { code, command, expiresAt } = plain.structuredContent!;
    expect(plain.structuredContent!.alreadyServed).toBe(false);
    expect(code).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
    expect(command).toBe(`npx goat-runner link ${code} --server https://chess.test`);
    expect(resultText(plain)).toBe(
      `Run this command on the machine that will play your bots:\n\n${command}\n\nRun it yourself if you have a shell; otherwise give it to your owner. That machine needs Node.js (for npx). It links the runner, starts it in the background and registers it to start at login (\`goat-runner autostart off\` undoes that). The code works once and expires at ${expiresAt}. Then call test_runner for one of your bots to check it works.`,
    );
    const withPreset = await call<Linked>('link_runner', { preset: 'claude' });
    expect(withPreset.structuredContent!.command).toBe(
      `npx goat-runner link ${withPreset.structuredContent!.code} --server https://chess.test --preset claude`,
    );
    const bad = await call('link_runner', { preset: 'emacs' });
    expect(bad.isError).toBe(true);
  });

  it('lists the presets in its description', async () => {
    const reply = await mcpCall(api.app, token, 'tools/list');
    const tools = reply.response?.result?.tools as { name: string; description: string }[];
    expect(tools.find((t) => t.name === 'link_runner')!.description).toContain(
      'claude, codex, opencode, goose, lean, custom',
    );
  });

  it('leaves no trailing-slash artefact in the server URL', async () => {
    await start({ PUBLIC_URL: 'https://chess.test//' });
    const out = await call<Linked>('link_runner');
    expect(out.structuredContent!.command).toMatch(/ --server https:\/\/chess\.test$/);
  });

  it('still issues a code when the owner has no bots', async () => {
    const out = await call<Linked>('link_runner');
    expect(out.structuredContent!.alreadyServed).toBe(false);
    expect(out.structuredContent!.command).toContain('npx goat-runner link ');
  });

  it('says nothing to do when a connected runner serves every bot', async () => {
    await insertBot(db, owner);
    await insertBot(db, owner);
    await runner(owner, 0);
    const out = await call<Linked>('link_runner');
    expect(out.structuredContent).toEqual({ alreadyServed: true, served: 'all' });
    expect(resultText(out)).toBe(
      'A connected runner already serves all your bots. Nothing to do. Call list_runners to see it.',
    );
    const [{ n }] = (await db.execute(
      'select count(*)::int as n from runner_link_codes',
    )) as unknown as [{ n: number }];
    expect(n).toBe(0);
  });

  it('issues a code when the runner is stale, or does not serve the named bot', async () => {
    const rook = await insertBot(db, owner, { firstName: 'Rook' });
    const bishop = await insertBot(db, owner, { firstName: 'Bishop' });
    const old = await runner(owner, 120);
    expect((await call<Linked>('link_runner')).structuredContent!.alreadyServed).toBe(false);
    await db.delete(runners).where(eq(runners.id, old.id));
    await runner(owner, 0, [rook.id]);
    expect((await call<Linked>('link_runner')).structuredContent!.alreadyServed).toBe(false);
    const named = await call<Linked>('link_runner', { bots: ['rook'] });
    expect(named.structuredContent).toEqual({ alreadyServed: true, served: 'named' });
    expect(resultText(named)).toContain('serves these bots.');
    expect(
      (await call<Linked>('link_runner', { bots: [bishop.id] })).structuredContent!.alreadyServed,
    ).toBe(false);
  });

  it("refuses another owner's bot", async () => {
    const other = await insertUser(db, { username: 'bob' });
    const theirs = await insertBot(db, other);
    const out = await call('link_runner', { bots: [theirs.id] });
    expect(out.isError).toBe(true);
    expect(resultText(out)).toMatch(/^Bot not found\./);
  });
});

describe('list_runners and revoke_runner', () => {
  it('shows all bots or a named subset, and connected or not', async () => {
    expect(resultText(await call('list_runners'))).toBe('No runners yet. Call link_runner.');
    const rook = await insertBot(db, owner, { firstName: 'Rook' });
    const bishop = await insertBot(db, owner, { firstName: 'Bishop' });
    const a = await runner(owner, 0);
    const b = await runner(owner, 200, [rook.id, bishop.id]);
    const out = await call<Listed>('list_runners');
    expect(out.structuredContent!.runners).toEqual([
      {
        id: a.id,
        label: 'Living-room PC',
        harness: 'claude',
        bots: 'all',
        connected: true,
        lastSeenAt: a.lastSeenAt!.toISOString(),
      },
      {
        id: b.id,
        label: 'Living-room PC',
        harness: 'claude',
        bots: ['Bishop', 'Rook'],
        connected: false,
        lastSeenAt: b.lastSeenAt!.toISOString(),
      },
    ]);
    expect(resultText(out)).toBe(
      `#${a.id} "Living-room PC" (claude): connected, serves all bots\n#${b.id} "Living-room PC" (claude): last seen ${b.lastSeenAt!.toISOString()}, serves Bishop, Rook`,
    );
  });

  it('says never connected', async () => {
    const [row] = await db
      .insert(runners)
      .values({ ownerId: owner.id, label: 'New', credentialHash: Buffer.from('x') })
      .returning();
    const out = await call<Listed>('list_runners');
    expect(out.structuredContent!.runners[0]!.lastSeenAt).toBeNull();
    expect(resultText(out)).toBe(`#${row!.id} "New": never connected`);
  });

  it('revokes a runner, freeing the leases it held', async () => {
    const group = await insertGroup(db);
    const bot = await insertBot(db, owner);
    const human = await insertUser(db);
    await insertGame(db, group.id, bot.id, human.id);
    const { runner: held, lease } = await claimFor(api, bot);
    expect(lease.runnerId).toBe(held.id);
    const out = await call<{ revoked: true }>('revoke_runner', { runner: held.id });
    expect(out.structuredContent).toEqual({ revoked: true });
    expect(resultText(out)).toBe(
      'Runner revoked. Its bots stop playing until another runner serves them.',
    );
    expect((await call<Listed>('list_runners')).structuredContent!.runners).toEqual([]);
    const [after] = await db.select().from(turnLeases).where(eq(turnLeases.id, lease.id));
    expect(after!.runnerId).toBeNull();
  });

  it("refuses another owner's runner", async () => {
    const other = await insertUser(db, { username: 'bob' });
    const theirs = await runner(other, 0);
    const out = await call('revoke_runner', { runner: theirs.id });
    expect(out.isError).toBe(true);
    expect(await db.select().from(runners).where(eq(runners.id, theirs.id))).toHaveLength(1);
  });
});

describe('bot status', () => {
  it('list_bots shows online, failing turns and waiting challenges', async () => {
    const group = await insertGroup(db);
    const bot = await insertBot(db, owner, { firstName: 'Rook' });
    const quiet = await insertBot(db, owner, { firstName: 'Quiet' });
    const human = await insertUser(db);
    await touchMember(db, group.id, human.id);
    await insertChallenge(db, group.id, human.id, bot.id);
    await insertGame(db, group.id, quiet.id, human.id);
    const offline = await call<{ bots: BotOut[] }>('list_bots');
    expect(offline.structuredContent!.bots).toMatchObject([
      { id: bot.id, online: false, failingTurns: 0, pendingChallenges: 1 },
      { id: quiet.id, online: false, failingTurns: 0, pendingChallenges: 0 },
    ]);
    const text = resultText(offline);
    expect(text).toContain(', offline, 1 challenge waiting');
    expect(
      text.endsWith('\nNo runner is connected, so your bots are not playing. Call link_runner.'),
    ).toBe(true);

    const { runner: live, lease } = await claimFor(api, bot);
    await db.update(runners).set({ lastSeenAt: new Date() }).where(eq(runners.id, live.id));
    await db.transaction((tx) => releaseTurn(tx, live.id, lease.id, lease.claimSeq, new Date()));
    const online = await call<{ bots: BotOut[] }>('list_bots');
    expect(online.structuredContent!.bots).toMatchObject([
      { id: bot.id, online: true, failingTurns: 1, pendingChallenges: 1 },
      { id: quiet.id, online: true, failingTurns: 0, pendingChallenges: 0 },
    ]);
    expect(resultText(online)).toContain(', online, 1 turn failing, 1 challenge waiting');
    expect(resultText(online)).not.toContain('No runner is connected');
  });
});

describe('persona and notes', () => {
  it('create_bot stores a persona and get_profile returns it with the notes', async () => {
    const created = await call<{ bot: BotOut }>('create_bot', {
      name: 'Rook',
      persona: ' Grumpy and terse ',
    });
    expect(created.isError).toBeFalsy();
    const id = created.structuredContent!.bot.id;
    await db.update(users).set({ botNotes: 'Opens e4' }).where(eq(users.id, id));
    const profile = await call<{ persona: string | null; botNotes: string }>('get_profile', {
      bot: id,
    });
    expect(profile.structuredContent).toMatchObject({
      persona: 'Grumpy and terse',
      botNotes: 'Opens e4',
    });
    expect(resultText(profile)).toContain(
      '\nPersona:\nGrumpy and terse\nBot notes (8 of 4,000 characters):\nOpens e4',
    );
  });

  it('get_profile shows (none) for both when empty', async () => {
    const bot = await insertBot(db, owner);
    const profile = await call<{ persona: string | null; botNotes: string }>('get_profile', {
      bot: bot.id,
    });
    expect(profile.structuredContent).toMatchObject({ persona: null, botNotes: '' });
    expect(resultText(profile)).toContain(
      '\nPersona:\n(none)\nBot notes (0 of 4,000 characters):\n(none)',
    );
  });

  it('update_bot clears the persona with an empty string, and the notes with clear_notes', async () => {
    const bot = await insertBot(db, owner, { persona: 'Old', botNotes: 'Remember this' });
    const out = await call('update_bot', { bot: bot.id, persona: '', clear_notes: true });
    expect(out.isError).toBeFalsy();
    const [row] = await db.select().from(users).where(eq(users.id, bot.id));
    expect(row).toMatchObject({ persona: null, botNotes: '' });
  });

  it('counts code points: 4,000 emoji pass, 4,001 do not', async () => {
    const bot = await insertBot(db, owner);
    const ok = await call('update_bot', { bot: bot.id, persona: '😀'.repeat(4000) });
    expect(ok.isError).toBeFalsy();
    const over = await call('update_bot', { bot: bot.id, persona: '😀'.repeat(4001) });
    expect(over.isError).toBe(true);
    expect(resultText(over)).toBe(
      'Persona too long. Shorten the persona to at most 4,000 characters.',
    );
    const created = await call('create_bot', { name: 'Long', persona: '😀'.repeat(4001) });
    expect(created.isError).toBe(true);
  });
});
