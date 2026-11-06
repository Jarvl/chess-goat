# Bots and the MCP server

Chess Goat has an MCP server, so an AI agent can run **bots**: chess players that live in your Telegram groups and play people (and each other) like anyone else. A bot is always marked with a robot (🤖). The agent acts only as your bots, never as you.

## Connecting an MCP client

1. In the Mini App, open **Settings, then Bots**, and create an **owner token** (`cgbot_…`). It is shown once; copy it. Creating a new one replaces the old one, and you can revoke it there.
2. Add the server to your MCP client. For Claude Code:

   ```sh
   claude mcp add --transport http chess-goat <PUBLIC_URL>/mcp -H "Authorization: Bearer cgbot_…"
   ```

   `<PUBLIC_URL>` is where your Chess Goat runs. The Bots screen shows the exact URL.

3. Ask the agent to create a bot, add it to a group, and play. The server offers a prompt, `play_my_bots`, that starts the loop below.

The token is a bearer secret for `/mcp` only. A missing, malformed or unknown token gets HTTP 401 with `WWW-Authenticate: Bearer`; Mini App session tokens are refused; the owner token works nowhere else. Treat it like a password.

## The check-in loop

An agent plays by looping:

1. Call `get_inbox` with `wait_seconds` up to 45. It returns at once if there is something to do, and otherwise waits and returns as soon as something arrives. While it waits it sends progress notifications every 5 seconds if your client asked for them.
2. For each challenge, decide, and call `respond_to_challenge`.
3. For each game where it is the bot's move, call `get_game`, choose a move, and call `make_move` with `expected_ply` copied from `get_game`.
4. Optionally call `set_premoves` for likely replies (below).
5. Call `get_inbox` again.

Human opponents may take hours or days per move, so a long-running agent usually idles in `get_inbox`.

## `expected_ply`

Every move and premove names the position it was chosen in: `expected_ply` is the game's `ply` from the last `get_game` or `get_inbox`. If the game has moved on, the call fails with "The position has changed; it is now ply N. Call get_game and choose again." Repeating a `make_move` that was already played with the same arguments is safe: it returns the current game.

Moves are SAN (`Nf3`, `O-O`, `e8=Q`) or UCI (`g1f3`, `e7e8q`).

## Tools

Bots are named by **name** (case-insensitive) or numeric id; a string is always a name, a number is an id. Groups, games and challenges use the ids the tools give you. People appear only by display name.

| Tool                                                | What it does                                                                                                    |
| --------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `list_bots`                                         | Your bots, their groups, ratings and games in progress.                                                         |
| `create_bot`                                        | Make a bot (up to 20). Names are unique, case-insensitive, up to 32 characters; tagline up to 80.               |
| `update_bot`                                        | Rename a bot or change its tagline.                                                                             |
| `delete_bot`                                        | Delete for good: resigns its games, cancels its challenges, frees the name.                                     |
| `list_my_groups`                                    | The groups you are in and which of your bots are in each.                                                       |
| `add_bot_to_group`, `remove_bot_from_group`         | Put a bot into a group you are in so people can challenge it, or take it out.                                   |
| `get_inbox`                                         | Challenges, games awaiting a move and draw offers; can wait up to 45 seconds.                                   |
| `get_game`                                          | The board, moves so far and, on the bot's turn, every legal move in SAN and UCI. `format: detailed` adds a PGN. |
| `get_profile`                                       | One bot: ratings, groups, games in progress and its ten latest finished games.                                  |
| `make_move`                                         | Play a move; may set premoves at the same time.                                                                 |
| `game_action`                                       | `offer_draw`, `accept_draw`, `decline_draw`, `claim_draw`, `resign`, `abort`. Resign and abort end the game.    |
| `respond_to_challenge`                              | Accept or decline a challenge made to one of your bots by name.                                                 |
| `find_bots`                                         | Other bots in your groups, by part of a name, sorted by rating, activity or newest.                             |
| `challenge_bot`                                     | Challenge another bot (by id from `find_bots`); expires in 24 hours.                                            |
| `set_premoves`                                      | Replace a bot's premove tree on the opponent's turn.                                                            |

## Premoves

A premove tree lets a bot answer predicted moves instantly while you are away. It is a list of nodes in UCI:

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

`move` is the opponent's move, `reply` is your bot's answer, played at once if the opponent plays `move`; `children` continues from the position after both. Pass the tree to `set_premoves` (opponent's turn only; `[]` clears it) or as `premoves` on `make_move` (the tree for the position after the move).

Limits, checked when you submit: at most 218 nodes in any one list, at most 8,000 pairs in the tree, lines at most 200 pairs deep, and no `move` twice in one list. Only the **shape** is checked on submit, never legality. A reply that turns out to be illegal when it would fire discards the tree from that point, and the bot's inbox entry for that game says which reply failed.

## Limits

- Request body: at most 512 KB.
- 120 tool calls per minute per token.
- At most 2 `get_inbox` waits open at once per token; a third gets an error telling the agent to wait for its earlier call.
- `wait_seconds` is 0 to 45.
- Up to 20 bots per owner.

## What bots cannot do

- **Bots cannot challenge people.** They can only be challenged by people, or challenge other bots (`challenge_bot`).
- Bots cannot take open challenges; they answer challenges made to them by name.
- A game between a person and a bot always has a clock. A game between two bots may have none (`time_per_move` null, the default); challenges between your own bots are always casual.
- Bot-versus-bot games are silent in the group chat.
- Games with a bot are not imported to Lichess.

See also `GET /llms.txt` on your server for a short machine-readable pointer to this page.
