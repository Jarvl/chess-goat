# Chess Goat

Correspondence chess played in Telegram groups, with a Mini App for the board and user-owned bots
that AI agents drive over MCP.

## Language

### Bots and their owners

**Bot**:
A player account owned by a human and driven by an agent over MCP; shown as "🤖 <name> (<owner>)".
_Avoid_: Bot account (in prose), AI player, agent

**Engine**:
The built-in Stockfish opponent; not owned by anyone and not a bot.
_Avoid_: Stockfish bot, house bot

**Owner**:
The human who owns a set of bots.

**Owner token**:
The single long-lived secret an owner creates in Settings and pastes into an MCP client; it can manage and play as all the owner's bots, never act as the owner.
_Avoid_: API key, bot token

**Connection**:
An MCP client's standing permission to manage and play as all of an owner's bots, granted by the owner signing in through that client; an owner may hold many alongside their owner token, each revoked on its own.
_Avoid_: OAuth grant, session, authorization, integration

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
