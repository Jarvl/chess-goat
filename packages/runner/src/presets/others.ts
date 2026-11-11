// codex, opencode and goose. NONE of these has been run: they are written from public
// documentation and none is installed on the development machine. Whoever first runs one should
// correct the flags here. Each keeps the turn token off the command line.
import path from 'node:path';
import {
  claudeMcpConfig,
  detectOnPath,
  personaOf,
  SERVER_NAME,
  TOKEN_ENV,
  writeTurnFiles,
  type HarnessPreset,
} from './common.js';

const mcpJson = (dir: string) => path.join(path.resolve(dir), 'mcp.json');
const tomlString = (s: string) => JSON.stringify(s); // a TOML basic string is a JSON string here

// Based on the Codex CLI docs (developers.openai.com/codex/cli/reference, /codex/mcp and
// /codex/config-reference): `codex exec`, `-c key=value` overrides (values parsed as TOML),
// `mcp_servers.<name>.url` and `.bearer_token_env_var` for a streamable HTTP server,
// `developer_instructions`, `default_tools_approval_mode`. The MCP config file is not used (Codex
// takes the server through -c); it is written only to give every preset the same files.
export const codex: HarnessPreset = {
  name: 'codex',
  status: 'unverified',
  detect: detectOnPath('codex'),
  async writeFiles(turn, dir) {
    return writeTurnFiles(turn, dir, mcpJson(dir), claudeMcpConfig(turn.mcp_url));
  },
  session(turn, _files, cwd) {
    const s = `mcp_servers.${SERVER_NAME}`;
    return {
      command: 'codex',
      args: [
        'exec',
        '--json',
        '-c',
        `${s}.url=${tomlString(turn.mcp_url)}`,
        '-c',
        `${s}.bearer_token_env_var=${tomlString(TOKEN_ENV)}`,
        '-c',
        `${s}.default_tools_approval_mode="approve"`,
        '-c',
        `developer_instructions=${tomlString(personaOf(turn))}`,
        '--',
        turn.prompt,
      ],
      env: { [TOKEN_ENV]: turn.token },
      cwd,
    };
  },
};

// Based on opencode's docs (opencode.ai/docs/cli, /docs/config, /docs/mcp-servers,
// /docs/permissions): `opencode run <message>`, the OPENCODE_CONFIG env var naming a config file,
// a `remote` MCP server with headers where `{env:VAR}` is substituted, and `permission` entries.
// There is no system-prompt flag, so the persona is put in front of the prompt.
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
      // Built-in tools off; the MCP server's tools are not covered by these keys.
      permission: { bash: 'deny', edit: 'deny', webfetch: 'deny' },
    };
    return writeTurnFiles(turn, dir, mcpJson(dir), `${JSON.stringify(config, null, 2)}\n`);
  },
  session(turn, files, cwd) {
    return {
      command: 'opencode',
      args: ['run', '--', `${personaOf(turn)}\n\n${turn.prompt}`],
      env: { [TOKEN_ENV]: turn.token, OPENCODE_CONFIG: files.mcpConfigFile },
      cwd,
    };
  },
};

// Based on goose's docs (block.github.io/goose/docs/guides/goose-cli-commands and
// /docs/getting-started/using-extensions): `goose run -t <text> --no-session --system <text>`, a
// `streamable_http` extension in config.yaml with `headers`, and GOOSE_PATH_ROOT relocating the
// config folder. Goose has no env expansion for headers that we know of, so the token is written
// into the 0600 config file, which the caller deletes with the session folder. Pointing
// GOOSE_PATH_ROOT at a fresh folder also hides the owner's provider settings: expect to correct this.
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
      args: ['run', '--no-session', '--system', personaOf(turn), '-t', turn.prompt],
      env: {
        [TOKEN_ENV]: turn.token,
        GOOSE_PATH_ROOT: path.dirname(path.dirname(files.mcpConfigFile)),
      },
      cwd,
    };
  },
};
