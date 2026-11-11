import fs from 'node:fs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { RunnerTurn } from '@chess-goat/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { RunnerConfig } from '../src/config.js';
import {
  DEFAULT_PERSONA,
  detectPreset,
  onPath,
  presetFor,
  type HarnessPreset,
} from '../src/presets/index.js';

const TOKEN = 'cgturn_TESTTOKEN_do_not_use';
const posix = process.platform !== 'win32';

const turn = (over: Partial<RunnerTurn> = {}): RunnerTurn => ({
  id: 7,
  claim_seq: 1,
  kind: 'move',
  bot: { id: 3, name: 'Deep Goat' },
  persona: 'You are Deep Goat. Be bold.',
  prompt: 'It is your move in game 12.',
  token: TOKEN,
  expires_at: '2030-01-01T00:00:00.000Z',
  mcp_url: 'https://goat.example/mcp/turn',
  ...over,
});

const config = (
  preset: RunnerConfig['preset'],
  extra: Partial<RunnerConfig> = {},
): RunnerConfig => ({
  server: 'https://goat.example',
  credential: 'cred',
  runnerId: 1,
  preset,
  concurrency: 2,
  leaseSeconds: 300,
  ...extra,
});

const CUSTOM = { command: '/opt/bot/run', args: ['--p', '{prompt_file}'] };

let root: string;
let dir: string;
beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'goat-presets-'));
  dir = path.join(root, 'session');
  fs.mkdirSync(dir);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const named = (preset: RunnerConfig['preset']) =>
  presetFor(config(preset, { custom: CUSTOM })) as HarnessPreset;
const ALL = ['claude', 'codex', 'opencode', 'goose', 'custom'] as const;

function relative(files: Record<string, string>, text: string) {
  return text.split(dir).join('<dir>').split(files.dir!).join('<dir>');
}

describe('presetFor', () => {
  it('maps lean to lean and every other preset to its adapter', () => {
    expect(presetFor(config('lean'))).toBe('lean');
    for (const name of ALL) {
      const p = named(name);
      expect(p.name).toBe(name);
    }
  });

  it('marks only claude and custom as verified-by-design', () => {
    expect(named('claude').status).toBe('verified');
    for (const n of ['codex', 'opencode', 'goose'] as const)
      expect(named(n).status).toBe('unverified');
  });

  it('throws when custom has no section', () => {
    expect(() => presetFor(config('custom'))).toThrow(/custom/);
  });
});

describe('every preset', () => {
  for (const name of ALL) {
    it(`${name}: the token is only in the environment, and files stay in the folder`, async () => {
      const p = named(name);
      const t = turn();
      const files = await p.writeFiles(t, dir);
      const spec = p.session(t, files, '/bots/deep-goat');

      expect(spec.command).not.toContain(TOKEN);
      for (const a of spec.args) expect(a).not.toContain(TOKEN);
      expect(spec.env.GOAT_TURN_TOKEN).toBe(TOKEN);
      expect(spec.cwd).toBe('/bots/deep-goat');
      expect(Object.keys(spec.env).filter((k) => /TOKEN|KEY|SECRET/i.test(k))).toEqual([
        'GOAT_TURN_TOKEN',
      ]);

      // Everything written is inside dir, and nothing else was created next to it.
      expect(fs.readdirSync(root)).toEqual(['session']);
      const written = [files.promptFile, files.personaFile, files.mcpConfigFile];
      for (const f of written) {
        expect(path.isAbsolute(f)).toBe(true);
        expect(path.relative(dir, f).startsWith('..')).toBe(false);
        if (posix) expect(fs.statSync(f).mode & 0o777).toBe(0o600);
      }
      expect(fs.readFileSync(files.promptFile, 'utf8')).toBe(t.prompt);
      expect(fs.readFileSync(files.personaFile, 'utf8')).toBe(t.persona);

      // Only goose has no env expansion for headers and so writes the token, in a 0600 file.
      const holders = written.filter((f) => fs.readFileSync(f, 'utf8').includes(TOKEN));
      expect(holders).toEqual(name === 'goose' ? [files.mcpConfigFile] : []);
    });
  }

  it('uses the default persona when the turn has none', async () => {
    for (const name of ['claude', 'codex', 'opencode', 'goose'] as const) {
      const d = fs.mkdtempSync(path.join(root, 'p-'));
      const p = named(name);
      const t = turn({ persona: null });
      const files = await p.writeFiles(t, d);
      expect(fs.readFileSync(files.personaFile, 'utf8')).toBe(DEFAULT_PERSONA);
      expect(p.session(t, files, d).args.join('\n')).toContain(DEFAULT_PERSONA);
    }
  });

  it('refuses to overwrite files that already exist', async () => {
    const p = named('claude');
    await p.writeFiles(turn(), dir);
    await expect(p.writeFiles(turn(), dir)).rejects.toThrow();
  });
});

describe('claude', () => {
  it('has the pinned argv and config', async () => {
    const p = named('claude');
    const files = await p.writeFiles(turn(), dir);
    const spec = p.session(turn(), files, '/bots/deep-goat');
    expect(spec.command).toBe('claude');
    expect(relative(files, JSON.stringify(spec.args, null, 2))).toMatchInlineSnapshot(`
      "[
        "-p",
        "--system-prompt=You are Deep Goat. Be bold.",
        "--mcp-config",
        "<dir>/mcp.json",
        "--strict-mcp-config",
        "--allowedTools",
        "mcp__chess-goat",
        "--tools",
        "",
        "--permission-mode",
        "dontAsk",
        "--setting-sources",
        "user",
        "--disable-slash-commands",
        "--no-session-persistence",
        "--output-format",
        "json",
        "--",
        "It is your move in game 12."
      ]"
    `);
    expect(fs.readFileSync(files.mcpConfigFile, 'utf8')).toMatchInlineSnapshot(`
      "{
        "mcpServers": {
          "chess-goat": {
            "type": "http",
            "url": "https://goat.example/mcp/turn",
            "headers": {
              "Authorization": "Bearer \${GOAT_TURN_TOKEN}"
            }
          }
        }
      }
      "
    `);
    expect(spec.env).toEqual({ GOAT_TURN_TOKEN: TOKEN });
  });

  it('passes awkward text through unchanged as single elements', async () => {
    const nasty = (s: string) => `${s} "q" 'q'\nline2 $HOME \`id\` $(id) ${'${X}'} --flag`;
    const t = turn({ persona: nasty('-persona'), prompt: nasty('-prompt') });
    const p = named('claude');
    const files = await p.writeFiles(t, dir);
    const { args } = p.session(t, files, '/b');
    expect(args).toContain(`--system-prompt=${t.persona}`);
    // After "--", so a prompt starting with "-" cannot be read as a flag.
    expect(args.slice(-2)).toEqual(['--', t.prompt]);
    expect(args.filter((a) => a.includes('line2'))).toHaveLength(2);
    expect(fs.readFileSync(files.promptFile, 'utf8')).toBe(t.prompt);
  });
});

async function shown(name: 'codex' | 'opencode' | 'goose') {
  const p = named(name);
  const files = await p.writeFiles(turn(), dir);
  const spec = p.session(turn(), files, '/bots/deep-goat');
  const out = {
    command: spec.command,
    args: spec.args,
    env: spec.env,
    config: fs.readFileSync(files.mcpConfigFile, 'utf8').split(TOKEN).join('<token>'),
  };
  return relative(files, JSON.stringify(out, null, 2));
}

describe('codex, opencode, goose (unverified)', () => {
  it('codex has the expected argv', async () => {
    expect(await shown('codex')).toMatchInlineSnapshot(`
      "{
        "command": "codex",
        "args": [
          "exec",
          "--json",
          "-c",
          "mcp_servers.chess-goat.url=\\"https://goat.example/mcp/turn\\"",
          "-c",
          "mcp_servers.chess-goat.bearer_token_env_var=\\"GOAT_TURN_TOKEN\\"",
          "-c",
          "mcp_servers.chess-goat.default_tools_approval_mode=\\"approve\\"",
          "-c",
          "developer_instructions=\\"You are Deep Goat. Be bold.\\"",
          "--",
          "It is your move in game 12."
        ],
        "env": {
          "GOAT_TURN_TOKEN": "cgturn_TESTTOKEN_do_not_use"
        },
        "config": "{\\n  \\"mcpServers\\": {\\n    \\"chess-goat\\": {\\n      \\"type\\": \\"http\\",\\n      \\"url\\": \\"https://goat.example/mcp/turn\\",\\n      \\"headers\\": {\\n        \\"Authorization\\": \\"Bearer \${GOAT_TURN_TOKEN}\\"\\n      }\\n    }\\n  }\\n}\\n"
      }"
    `);
  });
  it('opencode has the expected argv and config', async () => {
    expect(await shown('opencode')).toMatchInlineSnapshot(`
      "{
        "command": "opencode",
        "args": [
          "run",
          "--",
          "You are Deep Goat. Be bold.\\n\\nIt is your move in game 12."
        ],
        "env": {
          "GOAT_TURN_TOKEN": "cgturn_TESTTOKEN_do_not_use",
          "OPENCODE_CONFIG": "<dir>/mcp.json"
        },
        "config": "{\\n  \\"$schema\\": \\"https://opencode.ai/config.json\\",\\n  \\"mcp\\": {\\n    \\"chess-goat\\": {\\n      \\"type\\": \\"remote\\",\\n      \\"url\\": \\"https://goat.example/mcp/turn\\",\\n      \\"enabled\\": true,\\n      \\"headers\\": {\\n        \\"Authorization\\": \\"Bearer {env:GOAT_TURN_TOKEN}\\"\\n      }\\n    }\\n  },\\n  \\"permission\\": {\\n    \\"bash\\": \\"deny\\",\\n    \\"edit\\": \\"deny\\",\\n    \\"webfetch\\": \\"deny\\"\\n  }\\n}\\n"
      }"
    `);
  });
  it('goose has the expected argv and config', async () => {
    expect(await shown('goose')).toMatchInlineSnapshot(`
      "{
        "command": "goose",
        "args": [
          "run",
          "--no-session",
          "--system",
          "You are Deep Goat. Be bold.",
          "-t",
          "It is your move in game 12."
        ],
        "env": {
          "GOAT_TURN_TOKEN": "cgturn_TESTTOKEN_do_not_use",
          "GOOSE_PATH_ROOT": "<dir>/goose"
        },
        "config": "extensions:\\n  chess-goat:\\n    type: streamable_http\\n    enabled: true\\n    name: chess-goat\\n    uri: \\"https://goat.example/mcp/turn\\"\\n    headers:\\n      Authorization: \\"Bearer <token>\\"\\n    timeout: 300\\n"
      }"
    `);
  });
});

describe('custom', () => {
  const run = async (args: string[], t: RunnerTurn) => {
    const p = presetFor(config('custom', { custom: { command: 'my-bot', args } })) as HarnessPreset;
    const files = await p.writeFiles(t, dir);
    return { spec: p.session(t, files, '/b'), files };
  };

  it('substitutes every placeholder inside each argument', async () => {
    const { spec, files } = await run(
      [
        '--prompt={prompt_file}',
        '--cfg',
        '{mcp_config}',
        '{persona_file}:{persona_file}',
        '{mcp_url}',
        'x',
      ],
      turn(),
    );
    expect(spec.command).toBe('my-bot');
    expect(relative(files, JSON.stringify(spec.args))).toMatchInlineSnapshot(
      `"["--prompt=<dir>/prompt.txt","--cfg","<dir>/mcp.json","<dir>/persona.txt:<dir>/persona.txt","https://goat.example/mcp/turn","x"]"`,
    );
  });

  it('keeps a hostile bot name one argument, and leaves unknown placeholders alone', async () => {
    const name = `Evil "; rm -rf / $(id) '$&' {mcp_url}`;
    const { spec } = await run(
      ['--name', '{bot}', 'hi {bot}!', '{nope}', '{bot}{bot}'],
      turn({ bot: { id: 1, name } }),
    );
    expect(spec.args).toEqual(['--name', name, `hi ${name}!`, '{nope}', name + name]);
  });

  it('does not substitute in the command, and uses the claude config shape', async () => {
    const p = presetFor(
      config('custom', { custom: { command: '{bot}', args: [] } }),
    ) as HarnessPreset;
    const files = await p.writeFiles(turn(), dir);
    expect(p.session(turn(), files, '/b').command).toBe('{bot}');
    expect(fs.readFileSync(files.mcpConfigFile, 'utf8')).toBe(
      fs.readFileSync(
        (await named('claude').writeFiles(turn(), fs.mkdtempSync(path.join(root, 'c-'))))
          .mcpConfigFile,
        'utf8',
      ),
    );
  });

  it('detects an absolute command directly and a bare one on PATH', async () => {
    const bin = path.join(root, 'bin');
    fs.mkdirSync(bin);
    const exe = path.join(bin, 'mybot');
    fs.writeFileSync(exe, '#!/bin/sh\n', { mode: 0o755 });
    const mk = (command: string) =>
      presetFor(config('custom', { custom: { command, args: [] } })) as HarnessPreset;
    expect(await mk(exe).detect()).toBe(true);
    expect(await mk(path.join(bin, 'missing')).detect()).toBe(false);
    const saved = process.env.PATH;
    process.env.PATH = bin;
    try {
      expect(await mk('mybot').detect()).toBe(posix);
    } finally {
      process.env.PATH = saved;
    }
  });
});

describe('onPath', () => {
  it.skipIf(!posix)('finds an executable file and ignores a non-executable one', () => {
    const bin = path.join(root, 'bin');
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, 'goat-fake'), '#!/bin/sh\n', { mode: 0o755 });
    fs.writeFileSync(path.join(bin, 'goat-plain'), 'x', { mode: 0o644 });
    const env = { PATH: `${path.join(root, 'nothing')}:${bin}` };
    expect(onPath('goat-fake', env, 'linux')).toBe(true);
    expect(onPath('goat-plain', env, 'linux')).toBe(false);
    expect(onPath('goat-absent', env, 'linux')).toBe(false);
    expect(onPath('goat-fake', {}, 'linux')).toBe(false);
  });

  it('tries PATHEXT on win32 (case-insensitive env names)', () => {
    const bin = path.join(root, 'winbin');
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, 'goat-fake.cmd'), '@echo off\r\n');
    expect(onPath('goat-fake', { Path: bin, PATHEXT: '.EXE;.cmd' }, 'win32')).toBe(true);
    expect(onPath('goat-fake', { Path: bin, PATHEXT: '.EXE' }, 'win32')).toBe(false);
    const upper = path.join(root, 'winbin2');
    fs.mkdirSync(upper);
    fs.writeFileSync(path.join(upper, 'goat-fake.CMD'), '@echo off\r\n');
    expect(onPath('goat-fake', { PATH: upper }, 'win32')).toBe(true); // default PATHEXT has .CMD
  });

  it('does not accept a directory with the right name', () => {
    fs.mkdirSync(path.join(root, 'claude'));
    expect(onPath('claude', { PATH: root }, 'linux')).toBe(false);
  });
});

describe('detectPreset', () => {
  const saved = { PATH: process.env.PATH, PATHEXT: process.env.PATHEXT };
  afterEach(() => {
    process.env.PATH = saved.PATH;
  });
  const put = (...names: string[]) => {
    const bin = fs.mkdtempSync(path.join(root, 'bin-'));
    for (const n of names)
      fs.writeFileSync(path.join(bin, n + (posix ? '' : '.cmd')), '#!/bin/sh\n', { mode: 0o755 });
    process.env.PATH = bin;
  };

  it('returns the first of claude, codex, opencode, goose that is present', async () => {
    put('goose', 'opencode', 'codex', 'claude');
    expect(await detectPreset()).toBe('claude');
    put('goose', 'opencode', 'codex');
    expect(await detectPreset()).toBe('codex');
    put('goose', 'opencode');
    expect(await detectPreset()).toBe('opencode');
    put('goose');
    expect(await detectPreset()).toBe('goose');
  });

  it('returns null when none is present, never lean or custom', async () => {
    put('lean', 'custom');
    expect(await detectPreset()).toBeNull();
  });
});
