# Chess Goat

Correspondence chess played in Telegram groups, with a Mini App for the board and user-owned bots
that AI agents set up over MCP and a runner on the owner's machine plays.

## Language

### Bots and their owners

**Bot**:
A player account owned by a human and driven by short sessions that a runner starts; shown as "🤖 <name> (<owner>)".
_Avoid_: Bot account (in prose), AI player, agent

**Engine**:
The built-in Stockfish opponent; not owned by anyone and not a bot.
_Avoid_: Stockfish bot, house bot

**Owner**:
The human who owns a set of bots.

**Owner token**:
The single long-lived secret an owner creates in Settings and pastes into an MCP client; it can manage all the owner's bots (create, describe and group them, link runners, start bot-versus-bot challenges) but never play their games or act as the owner.
_Avoid_: API key, bot token

**Connection**:
A standing permission an owner grants and can revoke on its own: an MCP client's, to manage the owner's bots (granted by the owner signing in through that client), or a runner's, which can only claim and release turns of the owner's bots (granted by redeeming a link code); an owner may hold many alongside their owner token.
_Avoid_: OAuth grant, session, authorization, integration

**Runner**:
The program on an owner's machine that claims turns from Chess Goat over HTTP and starts a short agent session for each; Chess Goat never runs a model or connects to the machine itself.
_Avoid_: agent, worker, daemon

**Turn**:
One thing one bot has to respond to: a challenge, its move, a draw offer, a finished game, or a test. Challenge, move and draw-offer turns are worked out from the games and challenges themselves, so the same position is the same turn; game-over and test turns are created by the server (when a game ends; when `test_runner` is called).
_Avoid_: task, job, inbox item

**Lease**:
A runner's hold on a turn, 300 seconds unless it asks for more (900 at most); when it runs out with the turn still waiting, the turn counts a failure and is retried later.
_Avoid_: lock. (To claim a turn is to take it; the lease is the hold.)

**Turn token**:
The secret a session uses to play one turn of one bot over MCP; it opens only that turn's tools and ends with the lease.
_Avoid_: session token (that is the Mini App's), bot token

**Persona**:
What the owner tells a bot it is, up to 4,000 characters; it is the system prompt of every session that plays the bot.
_Avoid_: prompt, instructions, personality

**Bot notes**:
A bot's own memory across all its games, written by its sessions, up to 4,000 characters; a write is refused if another session changed them first.
_Avoid_: memory, state

**Match notes**:
A bot's own memory of one game, up to 2,000 characters; deleted when the game-over turn ends.
_Avoid_: game notes

**Link code**:
The single-use code, valid for 10 minutes, that an owner's agent gets from `link_runner` and a runner trades for its credential.
_Avoid_: pairing code (Pairing means something else here), pairing token

**Player Kind**:
What sort of player a user is: a human, the engine, or a bot. Every rule about who is shown, messaged or awarded what starts from it.
_Avoid_: isBot (it has meant both the engine and bots), user type

**Bot View**:
A game, challenge or group as a bot's agent sees it: from the bot's side, holding only what the bot may know.

### Games

**Pairing**:
Whether two players may meet in a group, and on what terms (rated or casual, which clocks); checked when a challenge is made and again when it is accepted.
_Avoid_: challenge rules, matchmaking

**Game Mix**:
Who is playing a game, by player kind: humans only, a human against a bot, or bots only.
_Avoid_: bot count, bot players

**Game Audience**:
Who hears about a game (the group chat, players' DMs, the Lichess import, the bot roundup); it follows from the game mix, and a bots-only game is silent.
_Avoid_: silent game
