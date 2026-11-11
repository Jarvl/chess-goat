// codex, opencode and goose. NONE of these has been run: they are written from public
// documentation and none is installed on the development machine. Whoever first runs one should
// correct the flags here. Each keeps the turn token off the command line, and sends the prompt on
// stdin where the tool's documentation shows a way to.
import path from 'node:path';
import {
  detectOnPath,
  personaOf,
  SERVER_NAME,
  TOKEN_ENV,
  writeTurnFiles,
  type HarnessPreset,
} from './common.js';

/** Known gaps per preset, for the CLI warning and the README to print. */
export const UNVERIFIED_NOTES: Record<'codex' | 'opencode' | 'goose', string[]> = {
  codex: [
    "Codex's built-in shell tool may remain available (only the sandbox is set to read-only).",
    "The owner's other MCP servers may still load from their own Codex config.",
  ],
  opencode: [
    "OPENCODE_CONFIG layers over the owner's own config: their other MCP servers and providers stay.",
    'The deny-by-default permission with an allow for chess-goat tools is untested.',
  ],
  goose: [
    "Goose's developer tools may stay on with approvals off (GOOSE_MODE is left unset: no documented non-interactive mode both restricts tools and runs unattended).",
    "Relocating the config root (GOOSE_PATH_ROOT) likely hides the owner's provider and model settings.",
    'The token is written to a config file; on Windows it has no mode protection and relies on the temp folder ACL.',
    'A persona starting with a dash is passed as --system=<persona>; that form is not confirmed.',
  ],
};

const mcpJson = (dir: string) => path.join(path.resolve(dir), 'mcp.json');
const tomlString = (s: string) => JSON.stringify(s); // a TOML basic string is a JSON string here

// Based on the Codex CLI docs (developers.openai.com/codex/cli/reference, /codex/mcp and
// /codex/config-reference): `codex exec` (a final `-` reads the prompt from stdin), `-c key=value`
// overrides (values parsed as TOML), `mcp_servers.<name>.url` and `.bearer_token_env_var` for a
// streamable HTTP server, `developer_instructions`, `default_tools_approval_mode`, `--sandbox`.
// UNVERIFIED: the built-in shell tool may remain available (read-only sandbox only limits what it can
// write), and the owner's other MCP servers may load from their own config. No documented switch
// for either was found. Codex takes the server through -c, so no MCP config file is written; the
// returned mcpConfigFile is a path nothing is written to.
export const codex: HarnessPreset = {
  name: 'codex',
  status: 'unverified',
  detect: detectOnPath('codex'),
  async writeFiles(turn, dir) {
    return writeTurnFiles(turn, dir, mcpJson(dir), null);
  },
  session(turn, _files, cwd) {
    const s = `mcp_servers.${SERVER_NAME}`;
    return {
      command: 'codex',
      args: [
        'exec',
        '--json',
        '--sandbox',
        'read-only',
        '-c',
        `${s}.url=${tomlString(turn.mcp_url)}`,
        '-c',
        `${s}.bearer_token_env_var=${tomlString(TOKEN_ENV)}`,
        '-c',
        `${s}.default_tools_approval_mode="approve"`,
        '-c',
        `developer_instructions=${tomlString(personaOf(turn))}`,
        '-',
      ],
      env: { [TOKEN_ENV]: turn.token },
      cwd,
      stdin: turn.prompt,
    };
  },
};

// Based on opencode's docs (opencode.ai/docs/cli, /docs/config, /docs/mcp-servers,
// /docs/permissions): `opencode run` (piped stdin becomes the message), the OPENCODE_CONFIG env var
// naming a config file, a `remote` MCP server with headers where `{env:VAR}` is substituted, and
// `permission` entries with wildcard keys (MCP tools are named `<server>_<tool>`). There is no
// system-prompt flag, so the persona is put in front of the prompt.
// UNVERIFIED: OPENCODE_CONFIG layers over the owner's own config, so their other MCP servers and
// providers stay; the deny-by-default permission with an allow for `chess-goat_*` follows the
// documented wildcard form but has not been run.
export const opencode: HarnessPreset = {
  name: 'opencode',
  status: 'unverified',
  detect: detectOnPath('opencode'),
  async writeFiles(turn, dir) {
    const config = {
      $schema: 'https://opencode.ai/config.json',
      mcp: {
        [SERVER_NAME]: {
          type: 'remote',
          url: turn.mcp_url,
          enabled: true,
          headers: { Authorization: `Bearer {env:${TOKEN_ENV}}` },
        },
      },
      permission: { '*': 'deny', [`${SERVER_NAME}_*`]: 'allow' },
    };
    return writeTurnFiles(turn, dir, mcpJson(dir), `${JSON.stringify(config, null, 2)}\n`);
  },
  session(turn, files, cwd) {
    return {
      command: 'opencode',
      args: ['run'],
      env: { [TOKEN_ENV]: turn.token, OPENCODE_CONFIG: files.mcpConfigFile },
      cwd,
      stdin: `${personaOf(turn)}\n\n${turn.prompt}`,
    };
  },
};

// Based on goose's docs (block.github.io/goose/docs/guides/goose-cli-commands and
// /docs/getting-started/using-extensions): `goose run -i -` (instructions from stdin) with
// `--no-session` and `--system`, a `streamable_http` extension in config.yaml with `headers`, and
// GOOSE_PATH_ROOT relocating the config folder. Goose has no env expansion for headers that we know
// of, so the token is written into the config file (0600, exclusive) inside the per-session folder.
// UNVERIFIED: (1) approvals are off by default (GOOSE_MODE=auto) and goose may leave its developer
// tools on; GOOSE_MODE is left unset because the documented modes either prompt (which hangs an
// unattended run) or disable tools (chat). (2) Relocating the config root likely hides the owner's
// provider and model settings. (3) On Windows the token file has no mode protection and relies on
// the temp folder's ACL. (4) `--system=<persona>` uses "=" so a leading dash is not read as a flag;
// not confirmed for goose's parser.
export const goose: HarnessPreset = {
  name: 'goose',
  status: 'unverified',
  detect: detectOnPath('goose'),
  async writeFiles(turn, dir) {
    const file = path.join(path.resolve(dir), 'goose', 'config', 'config.yaml');
    const yaml = [
      'extensions:',
      `  ${SERVER_NAME}:`,
      '    type: streamable_http',
      '    enabled: true',
      `    name: ${SERVER_NAME}`,
      `    uri: ${JSON.stringify(turn.mcp_url)}`,
      '    headers:',
      `      Authorization: ${JSON.stringify(`Bearer ${turn.token}`)}`,
      '    timeout: 300',
      '',
    ].join('\n');
    return writeTurnFiles(turn, dir, file, yaml);
  },
  session(turn, files, cwd) {
    return {
      command: 'goose',
      args: ['run', '--no-session', `--system=${personaOf(turn)}`, '-i', '-'],
      env: {
        [TOKEN_ENV]: turn.token,
        GOOSE_PATH_ROOT: path.dirname(path.dirname(files.mcpConfigFile)),
      },
      cwd,
      stdin: turn.prompt,
    };
  },
};
