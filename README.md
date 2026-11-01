<p align="center">
  <img src="apps/miniapp/src/assets/goat-banner.jpg" alt="Chess Goat" width="640">
</p>

<p align="center">
  <strong>Correspondence chess for Telegram group chats.</strong><br>
  Challenge your friends, play on a real board without leaving the chat, and argue about the result.
</p>

<p align="center">
  <a href="https://github.com/Jarvl/chess-goat/actions/workflows/ci.yml"><img src="https://github.com/Jarvl/chess-goat/actions/workflows/ci.yml/badge.svg?branch=main" alt="CI"></a>
  <a href="https://github.com/Jarvl/chess-goat/actions/workflows/e2e.yml"><img src="https://github.com/Jarvl/chess-goat/actions/workflows/e2e.yml/badge.svg?branch=main" alt="End-to-end"></a>
  <a href="https://github.com/Jarvl/chess-goat/actions/workflows/release.yml"><img src="https://github.com/Jarvl/chess-goat/actions/workflows/release.yml/badge.svg" alt="Release"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/licence-GPL--3.0--or--later-blue" alt="Licence: GPL-3.0-or-later"></a>
  <br>
  <img src="https://img.shields.io/badge/Telegram-Mini_App-26A5E4?logo=telegram&logoColor=white" alt="Telegram Mini App">
  <img src="https://img.shields.io/badge/TypeScript-3178C6?logo=typescript&logoColor=white" alt="TypeScript">
  <img src="https://img.shields.io/badge/Node-22-5FA04E?logo=nodedotjs&logoColor=white" alt="Node 22">
  <img src="https://img.shields.io/badge/PostgreSQL-18-4169E1?logo=postgresql&logoColor=white" alt="PostgreSQL 18">
  <img src="https://img.shields.io/badge/Preact-673AB8?logo=preact&logoColor=white" alt="Preact">
  <img src="https://img.shields.io/badge/pnpm-10-F69220?logo=pnpm&logoColor=white" alt="pnpm 10">
</p>

---

Chess Goat is a Telegram bot and Mini App for playing chess with the people in your group chats. Challenge someone with `/challenge` (pick them from Telegram's @ list), `/challenge @name`, or from the app, then move by dragging or tapping on a real board that opens inside Telegram. The group only sees game cards, results and the positions people choose to share. The server enforces the rules and the clocks, and every finished game gets a Lichess analysis link.

## Features

- **A real board.** Drag-and-drop or tap-tap moves with legal-move hints, promotion picker, move list, haptics, and light and dark themes that follow Telegram. Built on [chessground](https://github.com/lichess-org/chessground), the board Lichess uses.
- **Correspondence clocks.** Time per move from 1 hour to 7 days, or no clock. Clocks are kept on the server and survive restarts.
- **A quiet group chat.** One card per game, edited in place as the game goes on. No board image on every move and no command chatter.
- **Watch and replay.** Every game in the group can be watched live and replayed later. Share any position to the chat as a rendered snapshot card.
- **Ratings and a leaderboard.** Each group has its own Glicko-2 ratings, W/D/L records, head-to-head stats and player pages.
- **Conditional premoves.** Queue replies to the moves you expect, as a tree of lines that plays itself out.
- **Play the bot.** A Stockfish opponent at four levels. Bot games are unrated and never post to the group.
- **Flair.** Earn emoji in play and wear them beside your name.
- **Notifications that respect you.** A private "your move" message, a reminder before your time runs out, and nothing in the group.
- **Lichess analysis.** Finished games are imported to Lichess automatically, and the PGN is one tap away.
- **Group admin controls.** Default time controls, forum-topic routing, voiding games and blocking users.
- **Private by design.** The bot keeps privacy mode on and never stores chat content. Users can delete their own data.

## How it works

```mermaid
flowchart LR
    G[Telegram group] -- /challenge, button taps --> B
    B[Bot · grammY] -- game cards, shared positions --> G
    M[Mini App · Preact + chessground] -- moves over HTTPS --> A[API · Hono]
    A -- live updates over SSE --> M
    B & A --- D[(PostgreSQL 18)]
    J[Jobs + clock scanners] --- D
    J -- imports finished games --> L[Lichess]
    J -- bot moves --> S[Stockfish]
```

The whole server runs as one Node process with four roles (`api`, `bot`, `jobs`, `clock`). You can split the roles across processes with `ROLES`.

## Documentation

| Read this                                                                             | For                                             |
| ------------------------------------------------------------------------------------- | ----------------------------------------------- |
| [Running it in Telegram](docs/running.md)                                             | Setting up BotFather and trying it out          |
| [Self-hosting on Dokploy](docs/deploy-dokploy.md)                                     | A step-by-step deploy on your own VPS           |
| [Operations](docs/operations.md)                                                      | Deployment checklist, metrics and alerts        |
| [Testing](docs/testing.md)                                                            | How it is tested, and what is left before alpha |
| [Product requirements](docs/PRD.md)                                                   | What the product does and deliberately does not |
| [Technical design](docs/superpowers/specs/2026-09-20-group-chess-technical-design.md) | Architecture, data model and protocols          |
| [Specs](docs/superpowers/specs) and [implementation plans](docs/superpowers/plans)    | The design record of each feature               |

## Layout

| Path              | What it is                                                                                                                                                              |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/shared` | Rules (chess.js + arbiter), Glicko-2, PGN, the zod protocol, the English message catalog                                                                                |
| `apps/server`     | One Node process with four roles (`api`, `bot`, `jobs`, `clock`): grammY bot, Hono API with SSE, Drizzle on PostgreSQL 18, a table-backed job outbox and clock scanners |
| `apps/miniapp`    | The Preact + chessground Mini App, built with Vite and served by the server under `/app/`                                                                               |
| `scripts`         | Local PostgreSQL, piece vendoring, bundle-budget, licence and engine-liveness gates                                                                                     |

## Requirements

- Node 22 (`.nvmrc`), pnpm 10 (`corepack enable`)
- PostgreSQL 18 for integration and end-to-end tests (`scripts/local-postgres.sh start` runs one on port 54329 when `initdb` is available, or use Docker: `docker compose up db` and `export TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/postgres`)
- A Telegram bot token from BotFather for a real deployment

## Quick start

```bash
pnpm install
cp .env.example .env            # fill in BOT_TOKEN, BOT_USERNAME, MINI_APP_SHORT_NAME, PUBLIC_URL, secrets
scripts/local-postgres.sh start  # creates chess_goat on :54329 and prints its URL; tests make their own databases
export DATABASE_URL=postgres://postgres@127.0.0.1:54329/chess_goat
# or: docker compose up -d db  →  DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/chess_goat
pnpm dev:server                  # migrations run at boot; the bot long-polls when TELEGRAM_POLLING=true
pnpm dev:app                     # Vite on :5173, proxying /api to :3000
```

Telegram must load the Mini App over public HTTPS: point BotFather's app URL at a tunnel (for example cloudflared) that forwards to the Vite dev server or to the server with `MINI_APP_DIR=apps/miniapp/dist` after `pnpm build`.

## Checks

```bash
pnpm lint && pnpm format:check && pnpm typecheck
pnpm test                        # unit + integration, on this worktree's own database (pnpm test:unit skips integration)
pnpm build && pnpm check:budget  # Mini App bundle inside the §6.5 budget
pnpm check:licences              # every dependency inside the licence allow-list
pnpm e2e                         # builds the app and runs Playwright against the real server + a fake Bot API
```

The end-to-end suite needs Chromium: `pnpm --filter @chess-goat/miniapp exec playwright install chromium`, or point `PLAYWRIGHT_CHROMIUM_PATH` at an existing binary.

## Configuration

Everything is an environment variable, validated at boot (`apps/server/src/config.ts`).

| Variable                     | Required | Meaning                                                                                                           |
| ---------------------------- | -------- | ----------------------------------------------------------------------------------------------------------------- |
| `BOT_TOKEN`                  | yes      | From BotFather                                                                                                    |
| `BOT_USERNAME`               | yes      | Without `@`; used in direct links                                                                                 |
| `MINI_APP_SHORT_NAME`        | yes      | The `/newapp` short name; links are `https://t.me/<BOT_USERNAME>/<MINI_APP_SHORT_NAME>?startapp=…`                |
| `PUBLIC_URL`                 | yes      | HTTPS origin of this server; the webhook is `<PUBLIC_URL>/telegram/webhook`, the app `<PUBLIC_URL>/app/`          |
| `WEBHOOK_SECRET`             | yes      | ≥ 16 characters; sent by Telegram as `X-Telegram-Bot-Api-Secret-Token`                                            |
| `DATABASE_URL`               | yes      | PostgreSQL 18                                                                                                     |
| `SESSION_SECRET`             | yes      | ≥ 32 characters; signs the Mini App session tokens (rotating it logs everyone out)                                |
| `LICHESS_TOKEN`              | no       | Raises the import quota from 100 to 200 per hour                                                                  |
| `ROLES`                      | no       | `api,bot,jobs,clock` (default all)                                                                                |
| `LOG_LEVEL`                  | no       | `info`                                                                                                            |
| `PORT`                       | no       | `3000`                                                                                                            |
| `TELEGRAM_POLLING`           | no       | `true` for long polling in development (no public URL needed for the bot)                                         |
| `TELEGRAM_API_ROOT`          | no       | A local Bot API server or a test fake                                                                             |
| `LICHESS_API_URL`            | no       | `https://lichess.org`                                                                                             |
| `MINI_APP_DIR`               | no       | Directory of the built Mini App to serve under `/app/` (the Docker image presets it)                              |
| `ENGINE_ENABLED`             | no       | `true`; the bot opponent. `false` hides it and refuses new bot games (no Stockfish needed)                        |
| `ENGINE_PATH`                | no       | `stockfish`, resolved on `PATH`; or a path to the binary                                                          |
| `ENGINE_MOVETIME_MS`         | no       | `200`; the bot opponent's per-move thinking budget                                                                |
| `DATABASE_RESET_ON_MISMATCH` | no       | Staging only: `true` wipes the database at boot when another branch's migrations are applied. Never in production |

## Deployment in one paragraph

Build the image (`docker build -t chess-goat .` or pull `ghcr.io/jarvl/chess-goat:<version>` from a release), run it with the variables above and a PostgreSQL 18 database, put an HTTPS reverse proxy in front that does not buffer `/api/games/*/events`, register the Mini App in BotFather with `<PUBLIC_URL>/app/`, and open the bot. Migrations, the webhook, the command menu and the DM's Open button are set up by the server at boot. The full checklist, the metrics and the alerts are in [docs/operations.md](docs/operations.md).

## Licence

GPL-3.0-or-later (see `LICENSE`): the board is [chessground](https://github.com/lichess-org/chessground). The chess piece glyphs are the cburnett set by Colin M.L. Burnett, CC BY-SA 3.0 (`apps/server/src/images/ATTRIBUTION.md`). Every dependency is checked against the allow-list in `scripts/check-licences.mjs`.

## Contributing

Issues and pull requests are welcome. Before you open a PR, run the [checks](#checks) above. CI runs the same checks, plus the end-to-end suite and a Docker image smoke test.

---

<p align="center">
  <img src="apps/miniapp/src/assets/goat-mark.png" alt="Chess Goat logo" width="72"><br>
  <sub>Made by <a href="https://t.me/Jarvl">@Jarvl</a> · Free software under the GPL-3.0-or-later</sub>
</p>
