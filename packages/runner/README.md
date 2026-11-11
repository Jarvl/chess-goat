# goat-runner

`goat-runner` plays your Chess Goat bots on your own machine. It links to a Chess Goat server once, then stays in the background. When one of your bots has something to respond to (a challenge, a move, a draw offer, a finished game), the runner claims that **turn** and starts a short **session** in the agent **harness** you chose: Claude Code, another command-line agent, or the runner's own loop for a local model. The session plays the turn and ends.

The server never connects to your machine. The runner asks the server for work over HTTPS. For how bots, personas, turns and leases work, read [Bots, runners and turns](../../docs/bots.md). Your own agent (Claude Code, for example) sets the bots up and gives you the command to link. This page is about the program that plays them.

> **The program is not on npm yet.** Until it is, every `goat-runner …` in this README, and in the messages the program prints, means `node <path to the clone>/packages/runner/dist/cli.js …`. Do not use `npx` for it. See [Install and link](#install-and-link) for how to build it.

## Before you start

- Node 20.3 or later.
- A Chess Goat server and an owner token. Your agent needs both to set up bots; see [Setting up a bot in one prompt](../../docs/bots.md#setting-up-a-bot-in-one-prompt).
- The harness you want to use, installed and signed in on this machine. For `claude`, run `claude` once yourself first, so it is logged in.
- Windows, macOS and Linux all work. You do not need WSL on Windows.

The model usage is yours. Each session runs on your own account or your own hardware, so Chess Goat does not pay for it and cannot cap it. In one real run of the `claude` preset, a move cost between $0.06 and $0.13. Your cost will differ with the model and the position.

## Install and link

`goat-runner` is not on npm yet. Until it is, run it from a clone of this repository:

```sh
git clone https://github.com/Jarvl/chess-goat.git
cd chess-goat
pnpm install
pnpm --filter goat-runner build
```

Then ask your agent to call `link_runner`. It returns a one-time command like this:

```sh
goat-runner link ABCD-EFGH --server https://chess.example.com
```

The code is valid for 10 minutes and works once. The package is not on npm yet, so do not use `npx` for it. Run the command with `node` and the built file in place of `goat-runner`, from the root of the clone (or use the full path to `cli.js`):

```sh
node packages/runner/dist/cli.js link ABCD-EFGH --server https://chess.example.com
```

`link` does four things: it trades the code for a credential and stores it, picks the harness, turns on start at login, and starts the background runner. It adds `--preset <name>` if your agent chose one. Then ask your agent to call `test_runner`; when it says the bot is working, the bot is live.

Start at login records the absolute paths of `node` and of `cli.js`. If you move the clone or change your Node version, run `autostart on` again.

`link` keeps the link and starts nothing only when the harness was not named in the command but comes from the code (the server stored it) or was looked for and not found. That is the case when the server's preset is `codex`, `opencode` or `goose` and you did not pass `--allow-unverified`, when it is `lean` or `custom` and you did not pass its settings, or when the server has none and `claude` is not installed. It then tells you to run `goat-runner preset <name>`; that finishes the setup.

If you name the preset yourself with `--preset`, the program checks it before it uses the code. `--preset codex`, `--preset opencode` or `--preset goose` without `--allow-unverified`, and `--preset lean` or `--preset custom` without their settings, are refused at that point. Nothing is linked, and the same code still works once you fix the command.

## Commands

Every command except `run` accepts `--json`, which prints one JSON object instead of text. Errors are always one plain sentence on stderr. `<command> --help` prints that command's own usage.

| Command                         | What it does                                                                            |
| ------------------------------- | --------------------------------------------------------------------------------------- |
| `goat-runner link <code>`       | Link this machine to a server, store the credential, turn on start at login, start.     |
| `goat-runner preset <name>`     | Change the harness of a linked runner. Restarts the runner if it was running.           |
| `goat-runner start`             | Start the background runner. Says so if it is already running.                          |
| `goat-runner stop`              | Stop the background runner. Its running sessions end and their turns are given back.    |
| `goat-runner status`            | Show whether this machine is linked, which preset it uses, and whether it is running.   |
| `goat-runner logs [-n <lines>]` | Show the last lines of the log (50 by default).                                         |
| `goat-runner run [--daemon]`    | Run in the foreground, with the log on the terminal. `--daemon` is the background mode. |
| `goat-runner autostart on\|off` | Turn start at login on or off.                                                          |
| `goat-runner unlink`            | Stop the runner, remove start at login, and delete the stored link on this machine.     |
| `goat-runner --version`         | Print the version.                                                                      |

Options of `link`:

| Option                   | Meaning                                                                              |
| ------------------------ | ------------------------------------------------------------------------------------ |
| `--server <url>`         | The Chess Goat server. Required. It must be `https`, unless it is on this machine.   |
| `--preset <name>`        | `claude`, `codex`, `opencode`, `goose`, `lean` or `custom`. See [Presets](#presets). |
| `--label <text>`         | How the server lists this machine. Default: the machine's hostname.                  |
| `--allow-unverified`     | Accept `codex`, `opencode` or `goose`. Nobody has run these yet.                     |
| `--no-autostart`         | Do not start at login.                                                               |
| `--no-start`             | Do not start the background runner now.                                              |
| `--lean-*`, `--custom-*` | The settings of the `lean` and `custom` presets. See below.                          |

`preset` takes the same harness options, plus `--no-autostart` and `--no-start`, which only matter when it finishes a link that chose no harness.

On Windows there is no polite way to stop a program, so `stop`, `preset`, `unlink` and a new `link` end the runner at once. A turn in progress is not handed back. The server sees it lapse and retries it later, after a delay. On Linux and macOS the runner is asked to stop, hands its turns back and then ends; if it has not finished after 20 seconds, it is ended at once.

Only one runner runs per machine and user. A second `goat-runner run` stops with "A runner is already running; use goat-runner stop first." To use the same machine with another server or account, run `unlink` first and link again.

## Presets

A **preset** is the recipe the runner uses to start one session in one harness. You choose it with `--preset` at `link`, or later with `goat-runner preset <name>`.

| Preset     | Harness                                                   | Linux      | macOS      | Windows    |
| ---------- | --------------------------------------------------------- | ---------- | ---------- | ---------- |
| `claude`   | Claude Code                                               | verified   | unverified | unverified |
| `codex`    | Codex CLI                                                 | unverified | unverified | unverified |
| `opencode` | opencode                                                  | unverified | unverified | unverified |
| `goose`    | goose                                                     | unverified | unverified | unverified |
| `lean`     | The runner's own loop, for any OpenAI-compatible endpoint | fakes only | fakes only | fakes only |
| `custom`   | A command you give                                        | fakes only | fakes only | fakes only |

- **Verified** means someone ran it for real. On Linux, two bots played a 20-ply game with the `claude` preset. Every move was a separate session of about 16 to 21 seconds, and the sessions called the chess tools and nothing else.
- **Unverified** means the preset is written from the harness's public documentation and has not been run. Nobody has run `codex`, `opencode` or `goose` yet, on any system. Reports are welcome: open an issue on [Jarvl/chess-goat](https://github.com/Jarvl/chess-goat/issues) with what happened.
- **Fakes only** means the preset is tested against a stand-in model or command and an in-process server, never a real harness.
- The runner's own code is tested on Linux, macOS and Windows in CI. Windows and macOS have not had a real run yet.

For an unverified preset, the CLI prints a warning when you link or choose it. For `claude`, it warns on macOS and Windows.

### claude

The default when `claude` is installed and nothing else is chosen. Each turn starts `claude -p` with the bot's persona as the system prompt, only the Chess Goat tools allowed, and every built-in tool (shell, files, web) turned off. It uses your Claude login. Nothing to configure.

### codex, opencode and goose

These need `--allow-unverified`, for example `goat-runner preset codex --allow-unverified`. The known gaps, which the CLI also prints when it refuses:

- `codex`: its built-in shell tool may remain available (only the sandbox is read-only), and your other MCP servers may still load from your own Codex config.
- `opencode`: your own opencode config is layered under ours, so your other MCP servers and providers stay. The deny-by-default permission is untested.
- `goose`: its developer tools may stay on with approvals off. The relocated config folder likely hides your provider and model settings. The turn token is written to a config file in a private temporary folder; on Windows that file has no mode protection and relies on the temp folder's permissions. A persona that starts with a dash is passed as `--system=<persona>`, which is not confirmed.

### lean

For a local model behind an OpenAI-compatible chat-completions endpoint, such as Ollama or LM Studio. The runner runs the loop itself: it sends the persona and the turn prompt to the model, runs the tool calls the model asks for against the server, and stops after 12 model replies, 30 tool calls, or the end of the turn.

```sh
node packages/runner/dist/cli.js preset lean --lean-base-url http://localhost:11434/v1 --lean-model llama3.1
```

| Option                     | Meaning                                                                                  |
| -------------------------- | ---------------------------------------------------------------------------------------- |
| `--lean-base-url <url>`    | The endpoint, without `/chat/completions`. Required.                                     |
| `--lean-model <name>`      | The model name the endpoint knows. Required.                                             |
| `--lean-api-key-env <var>` | The name of an environment variable that holds an API key. Optional. Not the key itself. |

Typical settings:

| Server    | `--lean-base-url`           | `--lean-model`                                |
| --------- | --------------------------- | --------------------------------------------- |
| Ollama    | `http://localhost:11434/v1` | a name from `ollama list`, such as `llama3.1` |
| LM Studio | `http://localhost:1234/v1`  | the model's identifier in LM Studio           |

The model must support tool calls. Some small models write a tool call as plain text instead; the runner does not read those, and the turn ends with no move. The background runner reads `--lean-api-key-env` from its own environment. A runner started by start at login may not have the variable your shell has, so prefer an endpoint without a key for a runner that starts at login.

### custom

For any other command. You give the command and its arguments; the runner starts it once per turn.

| Option                 | Meaning                                                                                         |
| ---------------------- | ----------------------------------------------------------------------------------------------- |
| `--custom-command <c>` | A command name on `PATH`, or an absolute path. A relative path such as `./run.sh` is refused.   |
| `--custom-arg=<arg>`   | One argument. Repeat it for each argument. Write the `=`, so an argument may start with a dash. |

Placeholders inside an argument are replaced for each turn:

| Placeholder      | Becomes                                                                        |
| ---------------- | ------------------------------------------------------------------------------ |
| `{prompt_file}`  | The path of a file with the turn prompt.                                       |
| `{persona_file}` | The path of a file with the bot's persona (or a short default if it has none). |
| `{mcp_config}`   | The path of a Claude Code style MCP config file for the Chess Goat server.     |
| `{mcp_url}`      | The Chess Goat MCP address for this turn.                                      |
| `{bot}`          | The bot's name. Other people chose it, so treat it as text, not as a command.  |

The command also gets the turn prompt on its standard input, and the turn token in the environment variable `GOAT_TURN_TOKEN`. The token is never in an argument. The command runs with the bot's own folder as its working directory. The runner does not use a shell, so quotes and spaces in a placeholder value stay as they are.

Worked example. A script `/home/me/bin/my-agent` that takes a prompt file and an MCP address:

```sh
node packages/runner/dist/cli.js preset custom --custom-command /home/me/bin/my-agent --custom-arg=--prompt-file={prompt_file} --custom-arg=--system-file={persona_file} --custom-arg=--mcp-url={mcp_url}
```

For each turn the runner runs `/home/me/bin/my-agent --prompt-file=<path> --system-file=<path> --mcp-url=<address>`. The script reads `GOAT_TURN_TOKEN` and sends it as `Authorization: Bearer <token>` to the MCP address. It must end when the turn is done. If your shell treats `{` or `}` in a way that changes the argument, put the argument in quotes.

## Where files live

| Item           | Linux                                        | macOS                                                | Windows                                                                   |
| -------------- | -------------------------------------------- | ---------------------------------------------------- | ------------------------------------------------------------------------- |
| Config folder  | `~/.config/goat-runner`                      | `~/Library/Application Support/goat-runner/config`   | `%APPDATA%\goat-runner`                                                   |
| Data folder    | `~/.local/share/goat-runner`                 | `~/Library/Application Support/goat-runner/data`     | `%LOCALAPPDATA%\goat-runner`                                              |
| Start at login | `~/.config/systemd/user/goat-runner.service` | `~/Library/LaunchAgents/casa.glob.goat-runner.plist` | `HKCU\Software\Microsoft\Windows\CurrentVersion\Run`, value `goat-runner` |

On Linux, `XDG_CONFIG_HOME` and `XDG_DATA_HOME` replace `~/.config` and `~/.local/share` when they are set to an absolute path.

In the config folder:

- `config.json` holds the server address, the runner credential, the preset and its settings, and two limits you can edit: `concurrency` (sessions at once, 1 to 8, default 2) and `leaseSeconds` (30 to 900, default 300).

In the data folder:

- `runner.log` is the log. It starts a new file at 5 MB and keeps the last one as `runner.log.1`.
- `runner.pid` shows that a runner is running.
- `bots/<bot id>/` is the working folder of one bot's sessions.

Each session also gets a private temporary folder named `goat-runner-…` in your system's temp folder. It holds that turn's prompt, persona and MCP config, and the runner deletes it when the session ends.

Set `GOAT_RUNNER_HOME` to an absolute path to keep everything under `<path>/config` and `<path>/data`. This is for tests. Start at login cannot carry it on Windows.

## Start at login

`link` turns it on. Turn it off with `--no-autostart` at link time, or later:

```sh
node packages/runner/dist/cli.js autostart off
```

What it registers:

- **Linux:** a systemd user unit, `~/.config/systemd/user/goat-runner.service`, enabled with `systemctl --user enable`. It restarts the runner after a crash, after 30 seconds.
- **macOS:** a LaunchAgent, `~/Library/LaunchAgents/casa.glob.goat-runner.plist`, loaded into your login session. It starts the runner at once, and restarts it after a crash.
- **Windows:** a value named `goat-runner` in your per-user Run key. At login it runs `goat-runner start`, which starts the hidden background runner; a console window may flash. It needs no administrator rights.

On Linux and macOS the entry also records your `PATH`, so the harness is found at login. If you install the harness somewhere else later, run `autostart on` again.

`goat-runner status` shows whether it is on. `autostart on` needs a link and a chosen harness first. `autostart off` leaves a runner that is running as it is.

On a Linux machine that nobody logs in to, such as a server or a Raspberry Pi, start at login only runs while that user is logged in. To keep the runner going without a login, run `loginctl enable-linger <user>` once, with your own user name in place of `<user>`.

## Security

Read this before you link a machine you care about.

- **The turn token.** Each turn comes with a turn token. The runner gives it to the session only through the environment variable `GOAT_TURN_TOKEN`, never on the command line. It lets the session act as one bot, for that one turn, with the tools of that turn. It stops working when the turn ends.
- **What a session can reach with `claude`.** The session gets the Chess Goat tools and no shell or file tools; the real run checked this. Your own user-level Claude Code settings, hooks and plugins still load, because the session uses your login. A hook or plugin that runs commands will run them, with the turn token in its environment.
- **`custom` with shell tools.** If you give a `custom` harness a shell or file tools, it is trusted with everything your user account can read, including your files and the runner's stored credential. Do not use one on a machine where that is a problem. The same goes for `codex`, `opencode` and `goose`, which may keep such tools (see their known gaps).
- **Text from other people.** The bot's persona and the text of other players are put in front of the model in quotes. Other players' text is marked as not instructions. A model can still be talked into bad chess, or into playing against its persona. Chess Goat decides nothing for a bot.
- **Where the runner connects.** The runner refuses a server address that is not `https`, except one on your own machine. It refuses a turn whose MCP address is on another origin than the server, and releases that turn as an error.
- **The stored credential.** `config.json` holds the credential that lets this machine claim your bots' turns. On Linux and macOS the file and its folder are readable only by your user. On Windows it relies on the permissions of your user profile. The credential is kept out of the data folder, where sessions start.
- **Revoking.** If a machine is lost, revoke its runner. Ask your agent to call `revoke_runner`, or use the Revoke button on the Bots screen of the Mini App. The server then refuses the credential, frees the turns it held, and the runner stops for good and says so in its log. `goat-runner unlink` only removes the local side: the server still lists the runner until you revoke it.

## Troubleshooting

Ask your agent to call `test_runner`. It returns one of five statuses:

| Status        | What it means                                             | What to try                                                                                                        |
| ------------- | --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `no_runner`   | No connected runner serves the bot.                       | Run `goat-runner status`. If it says `Running: no`, run `goat-runner start`. If it says `Linked: no`, link again.  |
| `not_claimed` | A runner is connected but has not picked up the test yet. | Wait a few seconds and call `test_runner` again.                                                                   |
| `claimed`     | The runner started a session, but it has not called back. | A slow model can take minutes: call again. If it stays, run `goat-runner logs`.                                    |
| `working`     | The session reached the server. The bot is live.          | Nothing.                                                                                                           |
| `failed`      | The session ended without reaching the server.            | Run `goat-runner logs`. It shows the last output of the harness. Fix what it shows, then call `test_runner` again. |

Other things you may meet:

- **`goat-runner status`** prints three lines: whether the machine is linked, whether the runner runs, and whether start at login is on.
- **`goat-runner logs`** prints the last 50 lines; `-n 200` prints more. Each turn is one line, such as `Gambit Goat: move turn, exited in 17 s`. A failed session adds a line with its last output.
- **"No harness is chosen yet."** `link` could not settle on a harness. Run `goat-runner preset <name>`. For `codex`, `opencode` or `goose`, add `--allow-unverified`.
- **"A runner is already running; use goat-runner stop first."** There is one runner per machine and user. It is probably the background one. Use `goat-runner status`, or `goat-runner stop` and try again.
- **"The running runner started before the last link and holds the old credential".** You linked again while it ran. Run `goat-runner stop`, then `goat-runner start`.
- **"this computer's clock disagrees with the server by about N s".** The log shows this once. The runner then uses the lease length instead of your clock, so turns still work. Fix the clock when you can.
- **"This runner was revoked; link again."** The runner was revoked on the server. It does not retry. Ask your agent for a new link code and run `link` again.
- **"server unreachable … retrying" or "server answered 5xx".** The runner retries by itself, with waits up to 60 seconds, and logs "connected again" when it works.
- **"turn refused".** The server gave an MCP address on another origin, or one without https. Check that `--server` is the server's real public address.
- **The bot is online but its games stall.** Ask your agent to call `list_bots`. A `failingTurns` above zero means sessions start and end without playing; the log says why.

## Development

From the root of the repository:

```sh
pnpm --filter goat-runner build
pnpm --filter goat-runner test
```

The tests need no database. See [Testing](../../docs/testing.md).

## Licence

GPL-3.0-or-later, like the rest of Chess Goat.
