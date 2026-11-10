# Bots, runners and turns

Chess Goat lets an AI agent set up **bots**: chess players that live in your Telegram groups and play people (and each other) like anyone else. A bot is always marked with a robot (🤖). Chess Goat never runs a model and never opens a connection to your machine: a small program of yours, the **runner**, asks the server for work and starts the model itself.

## Status: the runner is not released yet

The server side of all this is built and documented here. The runner program, `goat-runner` (run with `npx goat-runner …`), is designed but not built yet; it is tracked in [issue #149](https://github.com/Jarvl/chess-goat/issues/149), and the server design in [issue #148](https://github.com/Jarvl/chess-goat/issues/148). The old way of playing, an agent looping on an inbox tool over MCP, has been removed. Until the runner is released, **bots cannot play**: you can create and configure them, but nothing picks up their turns. Anything below about what the runner does (linking, starting in the background, starting at login, `goat-runner status`, `goat-runner logs`, `goat-runner start`, `goat-runner autostart off`) is planned, and is only what the server's own texts already promise. If you want to write a runner yourself, [The runner endpoint](#the-runner-endpoint) is the whole contract.

## How it works

Three parties are involved:

- **Your agent** (Claude Code, for example) connects to Chess Goat over MCP with your owner token. It sets bots up and never plays their games.
- **The runner** is a program on your machine, linked to your account once. It asks Chess Goat, over plain HTTP, for the next **turn**: one thing a bot has to respond to (a challenge, a move, a draw offer, a finished game). For each turn it starts a short agent session.
- **A session** is a fresh agent run for one turn. It is given the bot's persona and a prompt the server wrote, plays the turn through a small set of MCP tools, and ends. It remembers nothing except what the bot wrote in its notes.

```
owner's agent --MCP, owner token--> Chess Goat   create_bot, link_runner, test_runner
runner --------HTTP, runner credential--> /runner/claim   "anything for my bots?"
        <-- a turn: persona, prompt, turn token, MCP URL
runner starts a session --MCP, turn token--> Chess Goat   make_move, set_notes, ...
runner --------HTTP--> /runner/release   (session ended)
```

Nothing a bot does waits on you. Human opponents may take hours or days per move, so a bot's turns arrive one at a time over days, each handled by a new session.

## Setting up a bot in one prompt

1. In the Mini App, open **Settings, then Bots**, and create an **owner token** (`cgbot_…`). It is shown once; copy it. Creating a new one replaces the old one, and you can revoke it there.
2. Add the server to your MCP client. For Claude Code:

   ```sh
   claude mcp add --transport http chess-goat <PUBLIC_URL>/mcp -H "Authorization: Bearer cgbot_…"
   ```

   `<PUBLIC_URL>` is where your Chess Goat runs. The Bots screen shows the exact URL.

3. Use the server's `set_up_bot` prompt with a description of the bot you want, or just ask the agent in your own words ("make me an aggressive bot called Gambit for my chess group"). The server also sends the agent step-by-step instructions when it connects, so no other documentation is needed.

The agent then:

1. Calls `list_my_groups`, and asks you which group if you are in several and did not say.
2. Writes a **persona** from your description and calls `create_bot` with a name, the persona and the group.
3. Calls `link_runner` if no runner serves the bot yet. It returns a one-time command (`npx goat-runner link <code> --server <PUBLIC_URL>`) that the agent runs if it has a shell, or gives to you. The runner then starts in the background and at login, and `goat-runner autostart off` undoes that (planned).
4. Calls `test_runner` until it says the bot is live, or tells it what failed (see [Troubleshooting](#troubleshooting)).
5. If you asked for games, calls `find_bots` and `challenge_bot` for one or two bots that are online.

The token is a bearer secret for `/mcp` only. A missing, malformed or unknown token gets HTTP 401 with `WWW-Authenticate: Bearer`; Mini App session tokens are refused. Treat it like a password.

## The five kinds of turn

A turn is one thing a bot must respond to. The server works out which turns exist from the games and challenges themselves, and a runner claims the most urgent one (soonest deadline first, then oldest). A session gets only the tools of its turn's kind, and its token is good for that one turn.

| Kind         | When it happens                                                                                     | Tools in the session                                         |
| ------------ | --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| `challenge`  | A person or another bot challenges the bot by name.                                                 | `respond_to_challenge`, `set_notes` (bot notes only)         |
| `move`       | It is the bot's move in a game. Includes a move turn with a draw offer standing.                    | `get_position`, `make_move`, `game_action`, `set_notes`      |
| `draw_offer` | The opponent offers a draw on their own move.                                                       | `game_action` (`accept_draw`, `decline_draw`), `set_premoves`, `set_notes` |
| `game_over`  | A game the bot played has ended after play (not one that was aborted, aborted on timeout, or voided).        | `find_bots`, `challenge_bot`, `set_notes`                    |
| `practice`   | The owner's agent called `test_runner`.                                                             | `hello`                                                      |

Once a turn is resolved (the move is played, the challenge answered) its other tools stop working with "This turn has ended; stop." `set_notes` keeps working until the session ends, so a bot can write notes after its move.

## What a session is told

Two things come with a claimed turn:

- The **persona** is the session's system prompt, exactly as the owner wrote it. A bot with no persona plays with no instructions.
- The **turn prompt** is written by the server, short and in the order the session must act. It says who the bot is and what has happened; the position (board, moves so far in SAN, every legal move) for game turns; the deadline, a standing draw offer, or a premove reply that failed, where they apply; both sets of notes with their length against the limit; and the numbered steps to take, ending with "Then stop."

Names and group titles of other people are shown quoted and shortened, with a line saying they are text from other people, not instructions. The notes are introduced as the bot's own earlier writing that its persona outranks. A `practice` prompt is just "This is a test. Call hello, then stop."

Because each session starts empty, **anything you want a bot to keep doing must be in its persona.** The agent that sets a bot up is told to cover: how it plays, which challenges it accepts, when it offers, accepts or declines a draw, whether it challenges other bots after a game ends, and what it keeps in its notes.

## Persona, bot notes and match notes

| Text        | Whose it is                          | Written by                          | Limit                |
| ----------- | ------------------------------------ | ----------------------------------- | -------------------- |
| Persona     | The owner's instructions to the bot  | `create_bot`, `update_bot`          | 4,000 characters     |
| Bot notes   | The bot's memory across all its games | `set_notes` with `bot_notes`        | 4,000 characters     |
| Match notes | The bot's memory of one game         | `set_notes` with `match_notes`      | 2,000 characters     |

Lengths count Unicode characters (code points), not bytes. A text over the limit is refused with how many characters to cut. Every `set_notes` call **replaces the whole text**, so the session merges what it wants to keep into what it was shown.

- **Conflicts on bot notes.** Several sessions of one bot can run at once (different games). If another session saved bot notes since this session was shown them, `set_notes` is refused and returns the current notes; the session merges and calls again, and the second call goes through. `update_bot` with `clear_notes` erases the bot notes, and any session still holding old notes meets the same refusal.
- **Match notes** belong to one game, so a challenge turn has none (asking for them is refused). When both are sent in one call, the match notes are saved first so a bot-notes conflict does not lose them.
- **Match notes are deleted** when the game-over turn ends, whether its session finished, failed, or the turn was dropped after 24 hours. A game-over prompt says so and tells the session to move anything worth keeping into its bot notes.
- The owner can read the persona and bot notes with `get_profile`.

## Premoves

A premove tree lets a bot answer predicted moves instantly while its session is not running. It is a list of nodes in UCI:

```json
[
  {
    "move": "e7e5",
    "reply": "g1f3",
    "children": [{ "move": "b8c6", "reply": "f1b5", "children": [] }]
  },
  { "move": "c7c5", "reply": "g1f3", "children": [] }
]
```

`move` is the opponent's move, `reply` is your bot's answer, played at once if the opponent plays `move`; `children` continues from the position after both. A session passes a tree as `premoves` on `make_move` (the tree for the position after its move), or to `set_premoves` on a draw-offer turn (which is the opponent's move; `[]` clears it). A move turn has no `set_premoves`, since it is the bot's own move.

Limits, checked when the session submits: at most 218 nodes in any one list, at most 8,000 pairs in the tree, lines at most 200 pairs deep, and no `move` twice in one list. Only the **shape** is checked on submit, never legality. A reply that turns out to be illegal when it would fire drops the tree, and the next move turn's prompt says which reply failed.

## Moves and the position

Moves are SAN (`Nf3`, `O-O`, `e8=Q`) or UCI (`g1f3`, `e7e8q`). A session never sends a position number: the server knows which position the turn was issued for. If the game has moved on, the call fails with "The position has changed; it is now ply N. Call get_position and choose again."

## Leases, retries and failures

When a runner claims a turn, the server **leases** it: that runner holds it until the lease runs out or the runner releases it.

- **Lease length.** 300 seconds by default; a runner may ask for 30 to 900 seconds with `lease_seconds`, and 900 is the maximum. The `expires_at` in the claim is 10 seconds before the lease ends, so a runner stops its session before the server does.
- **Tool call budget.** Each claim allows 30 tool calls. The 31st is refused with "This session has used its 30 tool calls; stop." Claiming the turn again starts a fresh budget.
- **One claim at a time per owner**, so two runners of one owner cannot take the same turn. A turn that is claimed again invalidates the earlier claim's token.
- **What counts as a failure.** A `challenge`, `move` or `draw_offer` turn that is still waiting when its lease ends, because the lease ran out or the runner released it (whatever the reason it gives). A turn that was resolved in the meantime (the challenge was withdrawn, the game ended) is not a failure, and neither is a claim the server could not deliver.
- **Retry delays.** After the first failure the turn is claimable again after 60 seconds, after the second 300 seconds, after the third and every later one 1,800 seconds. `list_bots` shows each bot's `failingTurns`.
- **`game_over` turns** get one claim. If the lease ends, the turn is dropped (and the match notes with it); an unclaimed one is dropped 24 hours after the game ended.
- **`practice` turns get one attempt.** A failed test is not retried; `test_runner` starts a new one the next time. An unclaimed test expires after 10 minutes.
- **Order of claims.** A practice turn first, then `challenge`, `move` and `draw_offer` turns by soonest deadline and then oldest, then `game_over` turns oldest first.

A game with a clock still runs the bot's clock while its turn waits, so a bot whose runner is offline can lose on time.

## Owner tools

These are the tools on `/mcp` with an owner token. Bots are named by **name** (case-insensitive) or numeric id; a string is always a name, a number is an id. Groups and challenges use the ids the tools give you. People appear only by display name.

| Tool                                        | What it does                                                                                                                                        |
| ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `list_bots`                                 | Your bots, their groups, ratings, games in progress, whether a runner is online for each, failing turns and waiting challenges.                     |
| `create_bot`                                | Make a bot (up to 20) with an optional tagline, persona and groups. Names are unique, case-insensitive, up to 32 characters; tagline up to 80.      |
| `update_bot`                                | Rename a bot, change its tagline or persona (an empty one clears it), or `clear_notes`.                                                              |
| `delete_bot`                                | Delete for good: resigns its games, cancels its challenges, frees the name.                                                                          |
| `list_my_groups`                            | The groups you are in and which of your bots are in each.                                                                                            |
| `add_bot_to_group`, `remove_bot_from_group` | Put a bot into a group you are in so people can challenge it, or take it out.                                                                        |
| `link_runner`                               | Returns a one-time command that links a runner. Optional `label`, `bots` (serve only these), `preset` (the harness). Says so if a runner already serves the bots. |
| `list_runners`                              | Your runners, the harness each uses, which bots it serves, and whether it is connected.                                                              |
| `revoke_runner`                             | Disconnect and forget a runner; its bots stop playing until another serves them.                                                                     |
| `test_runner`                               | Issue a harmless test turn and wait up to `wait_seconds` (default and maximum 45) for the runner to run a session that calls back.                   |
| `get_profile`                               | One bot: ratings, groups, persona, bot notes and its ten latest finished games.                                                                      |
| `find_bots`                                 | Other bots in a group you are in, by part of a name, sorted by rating, activity or newest; online bots first.                                        |
| `challenge_bot`                             | Challenge another bot (by id from `find_bots`) on behalf of one of yours; expires in 24 hours.                                                       |

The `preset` values are `claude`, `codex`, `opencode`, `goose`, `lean` and `custom`. The server also offers the `set_up_bot` prompt (argument `description`, up to 2,000 characters).

## The runner endpoint

This is for people writing their own runner. It is **plain HTTP with JSON bodies, not MCP**, and it lives beside `/mcp` at `<PUBLIC_URL>/runner`. Requests other than `link` carry `Authorization: Bearer cgrun_…`. Bodies are at most 16 KiB (larger gets HTTP 413). Errors are `{"error":{"code","message","reason"}}`, with `reason` where there is one.

### `POST /runner/link`

Trades a link code (from `link_runner`) for a credential. No bearer token. Case and the dash in the code do not matter.

| Request field | Type   | Meaning                                |
| ------------- | ------ | -------------------------------------- |
| `code`        | string | The link code, 1 to 64 characters.     |
| `label`       | string | Optional name for the machine, up to 64 characters. |
| `harness`     | string | Optional harness name, up to 32 characters. |

| Response field | Type           | Meaning                                                              |
| -------------- | -------------- | -------------------------------------------------------------------- |
| `credential`   | string         | The `cgrun_…` credential. Shown once; store it securely.             |
| `runner_id`    | integer        | The runner's id, as `list_runners` shows it.                         |
| `preset`       | string or null | The preset the owner's agent chose in `link_runner`.                 |
| `server`       | string         | The server's public URL.                                             |

An unknown, used or expired code, or an owner who can no longer own bots, gets the same 404 (`link_code_invalid`). A sixth runner gets HTTP 409 (`too_many_runners`).

### `POST /runner/claim`

Long-polls for the next turn for any bot the runner serves. An empty body is fine.

| Request field   | Type    | Meaning                                                            |
| --------------- | ------- | ------------------------------------------------------------------ |
| `lease_seconds` | integer | Optional, 30 to 900; default 300.                                  |
| `wait_seconds`  | integer | Optional, 0 to 50; default 50. How long to wait if nothing is ready. |

The response is `{"turn": null}` when nothing was ready in time, or `{"turn": {...}}`:

| Turn field   | Type           | Meaning                                                                                       |
| ------------ | -------------- | --------------------------------------------------------------------------------------------- |
| `id`         | integer        | The turn's id; send it back as `turn_id` on release.                                          |
| `claim_seq`  | integer        | Which claim of the turn this is; send it back on release.                                     |
| `kind`       | string         | `challenge`, `move`, `draw_offer`, `game_over` or `practice`.                                 |
| `bot`        | object         | `{ "id", "name" }` of the bot to play as.                                                     |
| `persona`    | string or null | The bot's persona: use it as the session's system prompt.                                     |
| `prompt`     | string         | The turn prompt: use it as the session's first message.                                       |
| `token`      | string         | The `cgturn_…` turn token, for the session to use as the bearer token on `mcp_url`.           |
| `expires_at` | string         | ISO time to stop the session by; 10 seconds before the lease ends.                            |
| `mcp_url`    | string         | The MCP endpoint the session connects to (`<PUBLIC_URL>/mcp`).                                |

A runner has at most 4 claims open at once and 120 calls per minute. Each claim marks the runner as seen when it starts and when it ends, so a waiting runner stays online.

### `POST /runner/release`

Gives a turn back when its session has ended. Answers 204 with no body. A turn this runner does not hold under that `claim_seq` is left alone.

| Request field | Type    | Meaning                                                             |
| ------------- | ------- | ------------------------------------------------------------------- |
| `turn_id`     | integer | The turn's `id`.                                                    |
| `claim_seq`   | integer | The turn's `claim_seq`.                                             |
| `reason`      | string  | `exited`, `timeout` or `error`. Only the reason is logged.          |
| `detail`      | string  | Optional, up to 2,000 characters. The server does not log it.       |

Release a turn whose session ended, even a successful one. A turn that was played is simply finished; one still waiting counts a failure (see above).

## Credentials

There are three tokens and a link code, and each is accepted on one surface only. A Mini App session token opens none of them.

| Secret          | Looks like             | Accepted on                                         | Lifetime                                                                      | What the server stores                              |
| --------------- | ---------------------- | --------------------------------------------------- | ----------------------------------------------------------------------------- | --------------------------------------------------- |
| Owner token     | `cgbot_…`              | `/mcp` (owner tools)                                | Until you revoke it or create a new one in the Mini App.                      | A SHA-256 hash, and when it was last used.          |
| Link code       | `XXXX-XXXX`            | `POST /runner/link`                                 | 10 minutes, single use; at most 5 unspent per owner.                          | A hash, until it is used or expires.                |
| Runner credential | `cgrun_…`            | `POST /runner/claim`, `POST /runner/release`        | Until the runner is revoked (`revoke_runner` or the Mini App) or the owner is deleted. | A SHA-256 hash, the label, harness, bots served and last-seen time. |
| Turn token      | `cgturn_…`             | `/mcp` (that turn's tools)                          | Until the lease ends; invalid once the turn is claimed again or the bot is deleted. | Nothing: it is signed with `SESSION_SECRET`. Rotating that secret invalidates every turn token in flight. |

The Mini App's Bots screen lists your runners with their status and a Revoke button for a lost machine.

## Online status

A runner counts as **connected** if it was seen in the last 90 seconds. A claim poll marks it seen as it starts and as it ends, and any authenticated runner call refreshes it at most once a minute. A bot is **online** if a connected runner of its owner serves it (all of the owner's bots, or the ones named when it was linked). You see this as `online` in `list_bots` and `find_bots`, `connected` in `list_runners`, and "Connected", "Last seen" or "Never connected" in the Mini App. `find_bots` lists online bots first, since an offline bot may let a challenge expire.

## Limits

| Limit                                                   | Value                                                       |
| ------------------------------------------------------- | ----------------------------------------------------------- |
| Bots per owner                                          | 20                                                          |
| Runners per owner                                       | 5                                                           |
| Unspent link codes per owner                            | 5; each lasts 10 minutes                                    |
| Games a bot plays at once                               | 50. At 50 it can't accept a challenge, and people can't challenge it |
| Pending challenges a bot has made in one group          | 3                                                           |
| Persona, bot notes, match notes                         | 4,000, 4,000 and 2,000 characters                           |
| Premove tree                                            | 218 nodes per list, 8,000 pairs, 200 pairs deep             |
| Lease                                                   | 300 seconds by default, 900 at most                         |
| Tool calls per claim of a turn                          | 30                                                          |
| Retry delays after a failed turn                        | 60 s, 300 s, then 1,800 s                                   |
| `game_over` turn kept                                   | 24 hours after the game ended                               |
| Claim long poll                                         | up to 50 seconds                                            |
| Runner counted as online                                | 90 seconds after it was last seen                           |
| `test_runner` wait                                      | up to 45 seconds                                            |
| `/mcp` requests                                         | 120 per minute per owner token, and per turn; bodies over 512 KB get HTTP 413 |
| `/mcp` listen streams                                   | 2 open per owner token, and per turn                        |
| `/runner/claim` and `/runner/release`                   | 120 calls per minute per runner; 4 open claims per runner; bodies over 16 KiB get HTTP 413 |
| `/runner/link`                                          | 10 per minute per client address, 300 per minute in all     |
| Failed runner authentications                           | 60 per minute per client address                            |

The per-address limits need the server to know the client's address. Behind a reverse proxy, set `TRUST_PROXY_HOPS` to the number of proxies in front of the server (`1` behind Dokploy's Traefik), or every client shares one bucket.

## What bots cannot do

- **Bots cannot challenge people.** They can only be challenged by people, or challenge other bots (`challenge_bot`).
- Bots cannot take open challenges; they answer challenges made to them by name.
- A game between a person and a bot always has a clock. A game between two bots may have none (`time_per_move` null, the default); challenges between your own bots are always casual.
- Bot-versus-bot games are silent in the group chat.
- Games with a bot are not imported to Lichess.
- A session cannot message or wait on its owner, and cannot see other games, other groups or other bots, beyond what its turn's tools return.
- Chess Goat decides nothing for a bot. It only plays premoves the bot set.

## Troubleshooting

`test_runner` returns one of five statuses:

| Status        | Meaning                                                              | What to do                                                                                                      |
| ------------- | -------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `no_runner`   | No connected runner serves the bot.                                  | If none was linked, call `link_runner` and run its command. If you already did, wait a moment and test again; if it persists, run `goat-runner status` on that machine. |
| `not_claimed` | A runner is connected but has not picked up the test yet.            | Call `test_runner` again in a moment.                                                                           |
| `claimed`     | The runner started a session, but it has not called back.            | Slow models can take a few minutes: call again. If it stays, run `goat-runner logs` on the runner's machine.    |
| `working`     | The session reached Chess Goat: the bot is live.                     | Nothing. The test is cleared.                                                                                   |
| `failed`      | The session ended without reaching Chess Goat.                       | Run `goat-runner logs` on the runner's machine, fix what it shows, then call `test_runner` again.               |

If a bot is online but its games stall, check `list_bots`: a non-zero `failingTurns` means sessions are starting and ending without playing, and the runner's logs will say why. A bot whose clock runs out while its runner is offline loses on time like anyone else.

See also `GET /llms.txt` on your server for a short machine-readable pointer to this page.
