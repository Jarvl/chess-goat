export const TOP = `Usage: goat-runner <command> [options]

Commands:
  link <code> --server <url>   Link this machine to a chess server and start the runner
  start                        Start the background runner
  stop                         Stop the background runner
  status                       Show whether it is linked and running
  logs [-n <lines>]            Show the last lines of the runner log
  run [--daemon]               Run in the foreground (--daemon: as the background process)
  autostart on|off             Start the runner at login, or not
  unlink                       Stop, remove start at login and forget the link

Options:
  --json       Print one JSON object instead of text (every command)
  --version    Print the version
  --help       Print this help; "<command> --help" prints a command's own`;

export const USAGE: Record<string, string> = {
  link: `Usage: goat-runner link <code> --server <url> [options]

Redeems a link code from your agent (the link_runner tool), stores the credential, turns on
start at login and starts the background runner.

Options:
  --server <url>        The chess server (required; https unless it is this machine)
  --preset <name>       claude, codex, opencode, goose, lean or custom (default: the server's, else claude if installed)
  --label <text>        How this machine is listed (default: its hostname)
  --allow-unverified    Accept codex, opencode or goose, which have never been run for real
  --no-autostart        Do not start at login
  --no-start            Do not start the background runner now
  --lean-base-url <url> --lean-model <name> [--lean-api-key-env <var>]   For --preset lean
  --custom-command <cmd> [--custom-arg <arg>]...                         For --preset custom
  --json                Print one JSON object`,
  start: 'Usage: goat-runner start [--json]',
  stop: 'Usage: goat-runner stop [--json]',
  status: 'Usage: goat-runner status [--json]',
  logs: 'Usage: goat-runner logs [-n <lines>] [--json]',
  run: 'Usage: goat-runner run [--daemon]',
  autostart: 'Usage: goat-runner autostart on|off [--json]',
  unlink: 'Usage: goat-runner unlink [--json]',
};
