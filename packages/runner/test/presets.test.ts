import fs from 'node:fs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { RunnerTurn } from '@chess-goat/shared';
import type { SessionSpec } from '../src/session.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { RunnerConfig } from '../src/config.js';
import {
  DEFAULT_PERSONA,
  detectPreset,
  missingHarness,
  onPath,
  UNVERIFIED_NOTES,
  presetFor,
  type HarnessPreset,
  type TurnFiles,
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

function restoreEnv(key: string, value: string | undefined) {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

function filesUnder(d: string): string[] {
  return fs
    .readdirSync(d, { withFileTypes: true })
    .flatMap((e) => (e.isDirectory() ? filesUnder(path.join(d, e.name)) : [path.join(d, e.name)]));
}

// Replaces the temp folder with <dir> and, so one snapshot serves every platform, writes the
// separators after it as '/'. `text` is JSON, so on Windows the folder appears with its
// backslashes doubled; both spellings are replaced.
function relative(files: Record<string, string>, text: string) {
  let out = text;
  for (const root of [dir, files.dir!]) {
    out = out.split(root).join('<dir>').split(root.split('\\').join('\\\\')).join('<dir>');
  }
  return out.replace(/<dir>(?:(?:\\\\|\\|\/)[\w.-]+)+/g, (m) => m.replace(/\\\\|\\/g, '/'));
}

describe('presetFor', () => {
  it('maps lean to lean and every other preset to its adapter', () => {
    expect(presetFor(config('lean'))).toBe('lean');
    for (const name of ALL) {
      const p = named(name);
      expect(p.name).toBe(name);
    }
  });

  it('marks claude verified (a real run on Linux) and the others unverified until one confirms them', () => {
    expect(named('claude').status).toBe('verified');
    for (const n of ['codex', 'opencode', 'goose'] as const)
      expect(named(n).status).toBe('unverified');
  });

  it('lists known gaps for each unverified preset', () => {
    for (const n of ['codex', 'opencode', 'goose'] as const)
      expect(UNVERIFIED_NOTES[n].length).toBeGreaterThan(0);
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
      expect(spec.stdin ?? '').not.toContain(TOKEN);
      expect(spec.env.GOAT_TURN_TOKEN).toBe(TOKEN);
      expect(spec.cwd).toBe('/bots/deep-goat');
      expect(Object.keys(spec.env).filter((k) => /TOKEN|KEY|SECRET/i.test(k))).toEqual([
        'GOAT_TURN_TOKEN',
      ]);

      // Everything written is inside dir, and nothing else was created next to it.
      expect(fs.readdirSync(root)).toEqual(['session']);
      const written = [files.promptFile, files.personaFile, files.mcpConfigFile].filter(
        (f) => name !== 'codex' || f !== files.mcpConfigFile, // codex takes its server through -c
      );
      for (const f of written) {
        expect(path.isAbsolute(f)).toBe(true);
        expect(path.relative(dir, f).startsWith('..')).toBe(false);
        if (posix) expect(fs.statSync(f).mode & 0o777).toBe(0o600);
      }
      expect(fs.readFileSync(files.promptFile, 'utf8')).toBe(t.prompt);
      expect(fs.readFileSync(files.personaFile, 'utf8')).toBe(t.persona);

      // Only goose has no env expansion for headers and so writes the token, in a 0600 file.
      const holders = filesUnder(dir).filter((f) => fs.readFileSync(f, 'utf8').includes(TOKEN));
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
      const spec = p.session(t, files, d);
      // Delivered by file (claude) or inline (the others).
      const sent = [...spec.args, spec.stdin ?? ''].join('\n');
      expect(sent.includes(DEFAULT_PERSONA) || sent.includes(files.personaFile)).toBe(true);
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
        "--system-prompt-file",
        "<dir>/persona.txt",
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
        "user,project",
        "--disable-slash-commands",
        "--no-session-persistence",
        "--output-format",
        "json"
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

  it('sends the prompt on stdin and the persona by file', async () => {
    const p = named('claude');
    const files = await p.writeFiles(turn(), dir);
    const spec = p.session(turn(), files, '/b');
    expect(spec.stdin).toBe(turn().prompt);
    expect(spec.args).toContain('--system-prompt-file');
    expect(spec.args).not.toContain('--');
    expect(spec.args.join('\n')).not.toContain(turn().prompt);
    expect(spec.args.join('\n')).not.toContain(turn().persona!);
  });
});

describe('awkward text, every preset', () => {
  const nasty = (s: string) => `${s} "q" 'q'\nline2 $HOME \`id\` $(id) ${'${X}'} --flag`;
  const t = turn({ persona: nasty('-persona'), prompt: nasty('-prompt') });
  const fileText = (f: string) => fs.readFileSync(f, 'utf8');

  // How each preset delivers the two texts without a flag-shaped value on argv.
  const cases = {
    claude: (spec: SessionSpec, files: TurnFiles) => {
      expect(spec.stdin).toBe(t.prompt);
      expect(fileText(files.personaFile)).toBe(t.persona);
      expect(spec.args.slice(spec.args.indexOf('--system-prompt-file'))[1]).toBe(files.personaFile);
      expect(spec.args.join('\n')).not.toContain('line2');
    },
    codex: (spec: SessionSpec) => {
      expect(spec.stdin).toBe(t.prompt);
      expect(spec.args.at(-1)).toBe('-');
      // One TOML-escaped argv element starting with the key, so it cannot read as a flag.
      expect(spec.args).toContain(`developer_instructions=${JSON.stringify(t.persona)}`);
      expect(spec.args.join('\n')).not.toContain(t.prompt);
    },
    opencode: (spec: SessionSpec) => {
      expect(spec.stdin).toBe(`${t.persona}\n\n${t.prompt}`);
      expect(spec.args).toEqual(['run']);
    },
    goose: (spec: SessionSpec) => {
      expect(spec.stdin).toBe(t.prompt);
      expect(spec.args).toContain(`--system=${t.persona}`); // "=" form: no flag-shaped value
      expect(spec.args.join('\n')).not.toContain(t.prompt);
    },
    custom: (spec: SessionSpec, files: TurnFiles) => {
      expect(spec.stdin).toBe(t.prompt);
      expect(fileText(files.promptFile)).toBe(t.prompt);
      expect(fileText(files.personaFile)).toBe(t.persona);
      expect(spec.args.join('\n')).not.toContain('line2');
    },
  };

  for (const name of ALL) {
    it(`${name} delivers a persona and prompt with quotes, newlines, $VAR and a leading dash intact`, async () => {
      const p = named(name);
      const files = await p.writeFiles(t, dir);
      cases[name](p.session(t, files, '/b'), files);
    });
  }
});

async function shown(name: 'codex' | 'opencode' | 'goose') {
  const p = named(name);
  const files = await p.writeFiles(turn(), dir);
  const spec = p.session(turn(), files, '/bots/deep-goat');
  const out = {
    command: spec.command,
    args: spec.args,
    env: spec.env,
    stdin: spec.stdin,
    config: fs.existsSync(files.mcpConfigFile)
      ? fs.readFileSync(files.mcpConfigFile, 'utf8').split(TOKEN).join('<token>')
      : null,
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
          "--sandbox",
          "read-only",
          "-c",
          "mcp_servers.chess-goat.url=\\"https://goat.example/mcp/turn\\"",
          "-c",
          "mcp_servers.chess-goat.bearer_token_env_var=\\"GOAT_TURN_TOKEN\\"",
          "-c",
          "mcp_servers.chess-goat.default_tools_approval_mode=\\"approve\\"",
          "-c",
          "developer_instructions=\\"You are Deep Goat. Be bold.\\"",
          "-"
        ],
        "env": {
          "GOAT_TURN_TOKEN": "cgturn_TESTTOKEN_do_not_use"
        },
        "stdin": "It is your move in game 12.",
        "config": null
      }"
    `);
  });
  it('opencode has the expected argv and config', async () => {
    expect(await shown('opencode')).toMatchInlineSnapshot(`
      "{
        "command": "opencode",
        "args": [
          "run"
        ],
        "env": {
          "GOAT_TURN_TOKEN": "cgturn_TESTTOKEN_do_not_use",
          "OPENCODE_CONFIG": "<dir>/mcp.json"
        },
        "stdin": "You are Deep Goat. Be bold.\\n\\nIt is your move in game 12.",
        "config": "{\\n  \\"$schema\\": \\"https://opencode.ai/config.json\\",\\n  \\"mcp\\": {\\n    \\"chess-goat\\": {\\n      \\"type\\": \\"remote\\",\\n      \\"url\\": \\"https://goat.example/mcp/turn\\",\\n      \\"enabled\\": true,\\n      \\"headers\\": {\\n        \\"Authorization\\": \\"Bearer {env:GOAT_TURN_TOKEN}\\"\\n      }\\n    }\\n  },\\n  \\"permission\\": {\\n    \\"*\\": \\"deny\\",\\n    \\"chess-goat_*\\": \\"allow\\"\\n  }\\n}\\n"
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
          "--system=You are Deep Goat. Be bold.",
          "-i",
          "-"
        ],
        "env": {
          "GOAT_TURN_TOKEN": "cgturn_TESTTOKEN_do_not_use",
          "GOOSE_PATH_ROOT": "<dir>/goose"
        },
        "stdin": "It is your move in game 12.",
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

  it('also sends the prompt on stdin', async () => {
    const { spec } = await run(['{prompt_file}'], turn());
    expect(spec.stdin).toBe(turn().prompt);
  });

  it.each(['./run.sh', 'bin/run', '..\\run.cmd'])(
    'rejects the relative command %s from presetFor and detect',
    async (command) => {
      const cfg = config('custom', { custom: { command, args: [] } });
      expect(() => presetFor(cfg)).toThrow(
        'custom.command must be a command name on PATH or an absolute path',
      );
    },
  );

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
      restoreEnv('PATH', saved);
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

  it('on win32 finds nothing without an executable extension, whatever the host system', () => {
    const bin = path.join(root, 'winbare');
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, 'goat-bare'), 'not a program');
    fs.writeFileSync(path.join(bin, 'goat-real.exe'), 'MZ');
    expect(onPath('goat-bare', { PATH: bin }, 'win32')).toBe(false);
    expect(onPath('goat-bare', { PATH: bin, PATHEXT: '.EXE;.CMD' }, 'win32')).toBe(false);
    // A name that already ends in a listed extension is taken as given, in any letter case.
    expect(onPath('goat-real.exe', { PATH: bin }, 'win32')).toBe(true);
    expect(onPath('goat-real.exe', { PATH: bin, PATHEXT: '.EXE' }, 'win32')).toBe(true);
    fs.writeFileSync(path.join(bin, 'goat-dflt.EXE'), 'MZ');
    expect(onPath('goat-dflt', { PATH: bin }, 'win32')).toBe(true); // .EXE is in the default list
    // On the other systems the bare name is the file.
    if (posix) {
      fs.chmodSync(path.join(bin, 'goat-bare'), 0o755);
      expect(onPath('goat-bare', { PATH: bin }, 'linux')).toBe(true);
    }
  });

  it('prefers what PATHEXT lists: claude.cmd and claude.exe on win32', () => {
    const cmd = path.join(root, 'only-cmd');
    const exe = path.join(root, 'only-exe');
    fs.mkdirSync(cmd);
    fs.mkdirSync(exe);
    fs.writeFileSync(path.join(cmd, 'claude.cmd'), '@echo off\r\n');
    fs.writeFileSync(path.join(exe, 'claude.exe'), 'MZ');
    const ext = '.COM;.EXE;.BAT;.cmd';
    expect(onPath('claude', { PATH: cmd, PATHEXT: ext }, 'win32')).toBe(true);
    expect(
      onPath('claude', { PATH: exe, PATHEXT: '.EXE;.cmd'.replace('.EXE', '.exe') }, 'win32'),
    ).toBe(true);
    expect(onPath('claude', { PATH: exe, PATHEXT: '.cmd' }, 'win32')).toBe(false);
    expect(onPath('claude', { PATH: cmd, PATHEXT: '.exe' }, 'win32')).toBe(false);
  });

  it('accepts a quoted PATH entry on win32', () => {
    const bin = path.join(root, 'quoted dir');
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, 'claude.exe'), 'MZ');
    expect(onPath('claude', { PATH: `"${bin}"`, PATHEXT: '.exe' }, 'win32')).toBe(true);
  });

  it('does not accept a directory with the right name', () => {
    fs.mkdirSync(path.join(root, 'claude'));
    expect(onPath('claude', { PATH: root }, 'linux')).toBe(false);
  });
});

describe('detectPreset', () => {
  const saved = { PATH: process.env.PATH, PATHEXT: process.env.PATHEXT };
  afterEach(() => {
    restoreEnv('PATH', saved.PATH);
    restoreEnv('PATHEXT', saved.PATHEXT);
  });
  const put = (...names: string[]) => {
    const bin = fs.mkdtempSync(path.join(root, 'bin-'));
    for (const n of names)
      fs.writeFileSync(path.join(bin, n + (posix ? '' : '.cmd')), '#!/bin/sh\n', { mode: 0o755 });
    process.env.PATH = bin;
    if (!posix) process.env.PATHEXT = '.cmd';
  };

  it('returns claude when it is on PATH', async () => {
    put('goose', 'opencode', 'codex', 'claude');
    expect(await detectPreset()).toBe('claude');
  });

  it('never auto-selects codex, opencode, goose, lean or custom', async () => {
    put('goose', 'opencode', 'codex', 'lean', 'custom');
    expect(await detectPreset()).toBeNull();
  });
});

describe('missingHarness', () => {
  const saved = process.env.PATH;
  afterEach(() => restoreEnv('PATH', saved));

  it('names the command of a harness that is not on PATH, and nothing for lean or a found one', async () => {
    const bin = path.join(root, 'bin');
    fs.mkdirSync(bin, { recursive: true });
    process.env.PATH = bin;
    expect(await missingHarness(config('claude'))).toBe('claude');
    expect(await missingHarness(config('goose'))).toBe('goose');
    expect(await missingHarness(config('custom', { custom: { command: 'mybot', args: [] } }))).toBe(
      'mybot',
    );
    expect(
      await missingHarness(config('lean', { lean: { baseUrl: 'http://x', model: 'm' } })),
    ).toBeNull();
    if (posix) {
      fs.writeFileSync(path.join(bin, 'claude'), '#!/bin/sh\n', { mode: 0o755 });
      expect(await missingHarness(config('claude'))).toBeNull();
    }
  });
});
