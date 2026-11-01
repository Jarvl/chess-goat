# Running it in Telegram

How to get the bot and the Mini App working against real Telegram, on your own machine, so you can
play a game. About fifteen minutes.

Telegram loads a Mini App in its own web view over HTTPS and will not accept `localhost`, so you
need a public URL pointing at your machine. That is the only awkward part; everything else is a
token and some environment variables.

## 1. Database and dependencies

```bash
pnpm install
pnpm fonts
scripts/local-postgres.sh start
```

`pnpm fonts` downloads the shared-position card's fonts (about 20 MB) into `apps/server/fonts/`. The
server will not start its job worker without them.

That prints the two connection strings. You want the first one:

```bash
export DATABASE_URL=postgres://postgres@127.0.0.1:54329/chess_goat
```

That URL has no password because `local-postgres.sh` sets up trust authentication. If your
PostgreSQL is not this one — a Docker container, a system service, anything already configured with
a password — that connection string will fail to authenticate. Use the credentials that instance
actually has instead; for example, `docker compose up -d db` gives you PostgreSQL on 5432 with
`DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/chess_goat`.

### The bot opponent needs Stockfish

The always-available bot opponent shells out to a Stockfish binary on `PATH`:

```bash
brew install stockfish     # macOS
apt install stockfish      # Debian/Ubuntu
```

Without it, set `ENGINE_ENABLED=false` in `.env`. That turns off the bot opponent — it stops
appearing as an opponent to challenge, and starting a bot game is refused even if something asks for
one directly — and changes nothing else: human games, ratings and everything else in this guide work
exactly the same either way.

## 2. Open a tunnel first

Do this before talking to BotFather, because you need the URL to register the app.

```bash
cloudflared tunnel --url http://127.0.0.1:3000
```

It prints something like `https://random-words-1234.trycloudflare.com`. That is your `PUBLIC_URL`.
`ngrok http 3000` works the same way.

Keep this running. A quick tunnel gets a **new URL every time you restart it**, and if it changes
you have to update both `PUBLIC_URL` and the Web App URL in BotFather. A named tunnel or a paid
ngrok domain avoids that if you plan to come back to this.

## 3. Create the bot

Message [@BotFather](https://t.me/BotFather):

- `/newbot` — give it a display name, then a username ending in `bot`. It replies with a token that
  looks like `123456789:AAH...`. That is `BOT_TOKEN`, and the username without `@` is
  `BOT_USERNAME`.
- Leave privacy mode alone. On is the default and is what you want: the bot only sees its own
  commands, replies to its messages, button taps and Mini App requests, never ordinary chat.

## 4. Register the Mini App

Still in BotFather:

- `/newapp` — choose your bot. It asks for a title, a short description, a 640x360 image and a demo
  GIF (you can skip the GIF). Then it asks for the **Web App URL**: enter `<PUBLIC_URL>/app/`,
  including the trailing slash.
- Last it asks for a **short name**. Whatever you choose becomes `MINI_APP_SHORT_NAME`. Deep links
  are built as `https://t.me/<BOT_USERNAME>/<MINI_APP_SHORT_NAME>?startapp=…`.
- Optional but nicer: `/mybots` → your bot → *Bot Settings* → *Configure Mini App* → *Main App*, set
  to the same `<PUBLIC_URL>/app/`, so the bot's profile and its entry in chat lists get an
  **Open App** button. It opens your games across all groups.
- While there, upload [`docs/assets/miniapp-loading-icon.svg`](assets/miniapp-loading-icon.svg) as
  the Mini App's loading icon: a goat piece between a pawn and a rook, which Telegram shows while
  the app loads.

Do **not** add commands or a menu button in BotFather. On every start the server registers `/challenge`,
`/chess` and `/settings`, and sets the DM's **Open** menu button to `<PUBLIC_URL>/app/`, so a new
tunnel URL is picked up by a restart.

## 5. Configure

```bash
cp .env.example .env
```

Fill in, with no quotes:

| Variable | Value |
|---|---|
| `BOT_TOKEN` | the token from `/newbot` |
| `BOT_USERNAME` | your bot's username, no `@` |
| `MINI_APP_SHORT_NAME` | the short name from `/newapp` |
| `PUBLIC_URL` | the tunnel URL, no trailing slash |
| `WEBHOOK_SECRET` | 16 characters or more |
| `SESSION_SECRET` | 32 characters or more |
| `DATABASE_URL` | from step 1 |
| `MINI_APP_DIR` | `apps/miniapp/dist` |

The two secrets are yours to invent; the server refuses to start if they are too short:

```bash
openssl rand -hex 16   # WEBHOOK_SECRET
openssl rand -hex 32   # SESSION_SECRET
```

`MINI_APP_DIR` is the one that is easy to miss. Without it the server runs but serves nothing at
`/app/`, and Telegram shows a blank screen.

## 6. Build and start

```bash
pnpm build        # builds the Mini App into apps/miniapp/dist
pnpm dev:server
```

On start it runs the migrations, registers the webhook against `PUBLIC_URL`, and sets the command
menu and the DM's **Open** button. You should see a line ending `server started`.

Check it from outside:

```bash
curl https://<your-tunnel>/healthz     # ok
curl -I https://<your-tunnel>/app/     # 200, content-type text/html
```

If `/app/` is a 404, `MINI_APP_DIR` is unset or you have not run `pnpm build`.

## 7. Play

1. Create a group in Telegram and add your bot to it.
2. Promote the bot to administrator. It needs that to pin its welcome card and to see who joins,
   which is what the membership check uses.
3. The bot posts a welcome card with **⚔️ Challenge someone** and **♟ Group lobby** buttons.
4. Tap **Challenge someone** and pick an opponent, or send `/challenge @name` (or reply to their
   message with `/challenge`) in the group. `/chess` posts the same two buttons again. To play both
   sides yourself, use a second Telegram account.
5. Tap through to the board and move. Drag a piece, or tap the piece and then the target square.

## If something does not work

| Symptom | Cause |
|---|---|
| Blank screen in Telegram | `MINI_APP_DIR` not set, or `pnpm build` not run |
| "Reopen from Telegram" | The app was opened outside Telegram, or `BOT_TOKEN` does not match the bot whose link you used |
| `/challenge` shows no prompt | Close and reopen the chat so Telegram loads the new command menu; `/challenge` is a private command, so only the sender sees it and the prompt |
| Nothing happens on any command | The webhook cannot reach you. Check the tunnel is still up and `PUBLIC_URL` matches its current URL, then restart the server |
| Server exits at startup | The configuration is invalid; the error names the variable and what is wrong with it |
| Moves work but the group card never updates | The bot lacks permission to edit its own message, usually because it is not an administrator |

If the tunnel URL changed, you must update `PUBLIC_URL` **and** the Web App URL in BotFather, then
restart the server so it re-registers the webhook.

As a fallback, `TELEGRAM_POLLING=true` makes the bot long-poll instead of using the webhook, which
removes the tunnel from the bot's path. The Mini App still needs the tunnel, because Telegram loads
it over HTTPS.

The full deployment story, the BotFather checklist for a real environment, and the metrics and
alerts are in [operations.md](operations.md).
