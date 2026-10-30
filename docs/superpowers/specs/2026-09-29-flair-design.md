# Chess Goat: flair

Status: accepted for planning, 2026-09-29. Source design: the Claude Design project "Mini app
design improvement", `Chess Goat Prototype.dc.html`: the Flair screen, the Settings "Flair" row
and the emoji worn beside names. Builds on the [Chess Goat redesign](./2026-09-22-chess-goat-redesign-design.md)
for tokens, layout and brand. The [flair backfill](./2026-09-29-flair-backfill-design.md) replaces the introduction window (§1.5):
flair counts a player's whole history.

## What this is

Flair is an emoji earned in play and worn beside a player's name. There are 14 at launch in three
categories: a rank ladder (the ratings you have held), feats (things you achieved in play, such as
winning with an en passant capture or drawing ten games) and dubious honours (things done to you). Each player wears up to three, chosen on a Flair screen
reached from Settings, and everyone sees them beside the name in game lists, on the game screen,
on the leaderboard and on the player page.

The other goal is that the catalog can keep growing without the code turning to spaghetti.
Adding a flair built from existing building blocks is one catalog entry and one string (§1.7);
nothing else in the server, the API or the Mini App changes.

Maya wins with an en passant capture. A second later 👑 is hers, and because she had a free slot,
it appears beside her name on everyone's game lists the next time they load.

| In scope | Out of scope |
|---|---|
| The catalog of 14 flair, its rule vocabulary and move patterns (§1) | Awarding flair for games that finished before the flair shipped (since added by the [backfill](./2026-09-29-flair-backfill-design.md)) |
| `user_flair`, `users.flair_worn` and `flair_introductions` (§2) | Removing flair when a game is voided or ratings are rebuilt |
| The `award_flair` job, enqueued when a game ends (§3) | A notice or DM when flair is earned |
| `PlayerRef.flair`, `GET` and `PUT /api/me/flair` (§4) | Flair on group cards, result photos, shared positions or bot messages (since added to the cards' and captions' text; the images still carry none) |
| Flair beside names, the Settings row and the Flair screen (§5) | Flair in challenge rows, the New game opponent list or group settings |
| PRD updates (§8) | Tapping a worn emoji to explain it |

Delivered as one PR against `main`.

### Where this spec departs from the prototype

- **No "You're here" chip.** The prototype marks the rung matching your current rating when you
  have not earned it. It is left out on purpose; do not re-add it from the prototype.
- **No rating in the Flair screen's preview card.** Ratings are per group in the app, so there is
  no single rating to show.
- **"Held a rating" means in any group**, because the app keeps a rating per group and the
  prototype has one per person.
- **Flair counts a player's whole history**, as the prototype's sample data (flair earned months
  earlier) implies. At launch this spec counted only games after each flair shipped; the
  [backfill](./2026-09-29-flair-backfill-design.md) replaced that.
- **The category subtitles** in the prototype's data ("Held, not passed: …") are not rendered by
  its template, and are not used.
- **Leaderboard rows**: the prototype's lobby lists people; the app's lobby has a Leaderboard link
  instead, so leaderboard flair appears on the Leaderboard screen.
- **Earned dates read month first** ("Aug 12", en-US) where the prototype shows "12 Aug" (§5.5).

## 1. The catalog

### 1.1 Shape

`packages/shared/src/flair/catalog.ts`, exported from the shared package. It is data only, so it
adds almost nothing to the Mini App bundle.

```ts
export const FLAIR_CATEGORIES = ['rank', 'feat', 'dubious'] as const; // display order
export type FlairCategory = (typeof FLAIR_CATEGORIES)[number];
export type MovePattern = 'en_passant' | 'castle_queenside' | 'promotion' | 'scholars_mate';
export type PlayerResult = 'win' | 'draw' | 'loss';

export type FlairRule =
  | { kind: 'held'; min: number | null; max: number | null }
  | { kind: 'won'; pattern: MovePattern }
  | { kind: 'lost'; pattern: MovePattern }
  | { kind: 'streak'; result: PlayerResult; length: number; rated: boolean }
  | { kind: 'total'; result: PlayerResult; count: number; rated: boolean };

export type FlairDefinition = {
  id: string; // permanent; what the database stores
  emoji: string;
  category: FlairCategory;
  rule: FlairRule;
};

export const FLAIR = [/* §1.2, in display order */] as const satisfies readonly FlairDefinition[];
export type FlairId = (typeof FLAIR)[number]['id'];
```

Small constructors (`held`, `made`, `won`, `lost`, `quickMate`, `ended`, `against`, `streak`, `total`) keep entries to one line each,
for example `{ id: 'win_streak_5', emoji: '🔥', category: 'feat', rule: streak('win', 5) }`.
The module also exports `flairById(id)`, which returns `undefined` for an id no longer in the
catalog.

Each flair's description is the string `flair.<id>` in `packages/shared/src/i18n/en.ts`. A
type-level check fails the build when an id has no string.

### 1.2 The 30 flair

The 14 launch flair's emoji and descriptions are copied from the prototype code point for code
point. The second batch (🌡️ 🌋 🫦 💅 🗼 🪬 🏎️ 💨) came later, and at the same time ♟️ was loosened from
a win with a promotion to any promotion (`backfill: 2`). The third batch (🐢 🕊️ 👬 👶 💩 🗑️ 😈 🐔)
came after that, with the `ended` and `against` rule kinds and streaks made always rated (§1.4).

| Category | Emoji | Code points | Id | Rule | Description (`flair.<id>`) |
|---|---|---|---|---|---|
| rank | 🦍 | U+1F98D | `rank_under_1200` | `held(null, 1199)` | Held a rating under 1200 |
| rank | 🧑‍🦼 | U+1F9D1 U+200D U+1F9BC | `rank_1200` | `held(1200, 1299)` | Held a rating of 1200–1299 |
| rank | 🧑‍🦽 | U+1F9D1 U+200D U+1F9BD | `rank_1300` | `held(1300, 1399)` | Held a rating of 1300–1399 |
| rank | 🧑‍🦯 | U+1F9D1 U+200D U+1F9AF | `rank_1400` | `held(1400, 1499)` | Held a rating of 1400–1499 |
| rank | 🚶 | U+1F6B6 | `rank_1500` | `held(1500, 1599)` | Held a rating of 1500–1599 |
| rank | 🏃 | U+1F3C3 | `rank_1600` | `held(1600, 1699)` | Held a rating of 1600–1699 |
| rank | 🗿 | U+1F5FF | `rank_1700` | `held(1700, 1799)` | Held a rating of 1700–1799 |
| rank | 🤖 | U+1F916 | `rank_1800` | `held(1800, null)` | Held a rating of 1800 or more |
| feat | 👑 | U+1F451 | `en_passant_win` | `won('en_passant')` | Capture en passant and win the game |
| feat | 🌡️ | U+1F321 U+FE0F | `win_streak_3` | `streak('win', 3)` | Win three rated games in a row |
| feat | 🔥 | U+1F525 | `win_streak_5` | `streak('win', 5)` | Win five rated games in a row |
| feat | 🌋 | U+1F30B | `win_streak_10` | `streak('win', 10)` | Win ten rated games in a row |
| feat | 🏰 | U+1F3F0 | `queenside_castle_win` | `won('castle_queenside')` | Win a game you castled queenside in |
| feat | ♟️ | U+265F U+FE0F | `promotion_win` | `made('promotion')`, `backfill: 2` | Promote a pawn |
| feat | 🫦 | U+1FAE6 | `underpromotion_win` | `won('underpromotion')` | Promote a pawn to something other than a queen and win the game |
| feat | 💅 | U+1F485 | `queen_mate` | `won('queen_mate')` | Checkmate with only a queen left |
| feat | 🗼 | U+1F5FC | `bishops_mate` | `won('bishops_mate')` | Checkmate with only two bishops left |
| feat | 🪬 | U+1FAAC | `flawless_mate` | `won('flawless_mate')` | Win by checkmate without losing a piece |
| feat | 🏎️ | U+1F3CE U+FE0F | `quick_mate` | `quickMate(180)` | Win by checkmate within three minutes |
| feat | 🤝 | U+1F91D | `draws_10` | `total('draw', 10)` | Draw ten games |
| feat | 🐢 | U+1F422 | `marathon_win` | `won('marathon')` | Win a game longer than 100 moves |
| feat | 🕊️ | U+1F54A U+FE0F | `pacifist_mate` | `won('pacifist_mate')` | Checkmate without making a single capture |
| feat | 👬 | U+1F46C | `rival_5` | `against(5)` | Play the same person five times |
| dubious | 🪤 | U+1FAA4 | `scholars_mate_loss` | `lost('scholars_mate')` | Lose to a scholar’s mate |
| dubious | 💨 | U+1F4A8 | `bongcloud_win` | `won('bongcloud')` | Win with the Bongcloud opening |
| dubious | 👶 | U+1F476 | `loss_streak_3` | `streak('loss', 3)` | Lose three rated games in a row |
| dubious | 💩 | U+1F4A9 | `loss_streak_5` | `streak('loss', 5)` | Lose five rated games in a row |
| dubious | 🗑️ | U+1F5D1 U+FE0F | `loss_streak_10` | `streak('loss', 10)` | Lose ten rated games in a row |
| dubious | 😈 | U+1F608 | `nemesis_5` | `against(5, 'loss')` | Lose five games to the same person |
| dubious | 🐔 | U+1F414 | `resigned` | `ended('loss', 'resignation')` | Resign a game |
| dubious | 💤 | U+1F4A4 | `timed_out` | `ended('loss', 'timeout')` | Lose a game on time |

The ranges use an en dash (U+2013) and "scholar’s" a right single quotation mark (U+2019), as in
the prototype. Category titles: `flair.category.rank` "Rank ladder", `flair.category.feat` "Feats",
`flair.category.dubious` "Dubious honours".

### 1.3 Counted games

A player's flair is decided by their **counted games**: finished, not voided, ending `1-0`, `0-1`
or `1/2-1/2`, and not against the bot (`games.engine_level` is null). Rated and casual games both
count. Aborts, timeout aborts and voided games never count. Games are ordered by
`(finished_at, id)`.

### 1.4 Rule vocabulary

A rule is evaluated for one player **at** one of their counted games `g`, given `H`: that player's
counted games up to and including `g`, windowed as in §1.5. A flair is earned at the first game
where its rule holds.

| Kind | Holds at `g` when |
|---|---|
| `held(min, max)` | `g` is rated and the player's rating after it, rounded as displayed, is in `[min, max]` (a null bound is open). The rating is `white_rating_after` or `black_rating_after`, in whichever group `g` was played. So 1199.5 counts as 1200 |
| `made(pattern)` | the player made `pattern` in `g`, whatever the result |
| `won(pattern)` | the player won `g` and made `pattern` in it |
| `lost(pattern)` | the player lost `g` and the opponent made `pattern` in it |
| `quickMate(seconds)` | the player won `g` with a mating last move, at most `seconds` after `g` started (`started_at`, set when the challenge is accepted, to `finished_at`; games have no clock) |
| `ended(result, reason)` | the player's result in `g` is `result` and `g` ended by `reason` (`games.end_reason`, an `EndReason`) |
| `against(n, result?)` | at least `n` games of `H` were against `g`'s opponent (by user id, in any group, rated or casual). With `result`, `g` has it and only games of `H` with it are counted |
| `streak(result, n)` | `g` is rated, and the last `n` rated games of `H` (ending with `g`) all have `result`. Casual games are skipped: they neither extend nor break the run. Every streak is rated; the builder takes no option. Games from any group count |
| `total(result, n, { rated })` | `g` passes the filter, has `result`, and at least `n` games of `H` that pass it have `result` |

`streak`, `total` and `against` hold whenever the run or the count is at least `n`, not only exactly at `n`.
An award that was missed at the `n`-th game (see §6) is therefore made at the next qualifying one.

`total`'s `rated` defaults to false. `held` needs no filter because it is rated by definition.

To serve `ended` and `against`, each counted game also carries its `end_reason` and the other
side's user id (`black_id` or `white_id`), read by the same query. A player who used Delete my data
keeps their user row, so games against them still group by opponent. An `end_reason` that is null
matches no `ended` rule.

### 1.5 Every earlier game counts

Replaced by the [backfill spec](./2026-09-29-flair-backfill-design.md): there is no introduction window. A flair is scored on the
player's whole counted history, and each flair is backfilled once on the deploy that adds it.

### 1.6 The rule for every rule kind

**A rule's answer at `g` may depend only on `g` and the player's earlier counted games.** All nine
kinds above satisfy this. It is what makes evaluating each game once, as it ends, correct. It also
lets the [backfill](./2026-09-29-flair-backfill-design.md) walk a player's history and call the same evaluators at each game. Any new rule kind must satisfy it.

### 1.7 Adding and changing flair

- **A new flair from existing building blocks:** add one entry to `FLAIR` (its position is its
  display position within its category) and one `flair.<id>` string. The next deploy backfills it
  ([backfill spec](./2026-09-29-flair-backfill-design.md) §1).
- **A new kind of condition:** add a move pattern (a detector, §1.8) or a rule kind (an evaluator,
  §3.2), with unit tests. Both registries are exhaustive `Record`s, so TypeScript flags a pattern or
  kind without an implementation.
- **Changing an emoji or a description:** edit it. Nothing stored changes.
- **Changing a rule:** affects only future awards; flair already earned is kept. Bump the entry's
  `backfill` to apply a loosened rule to past games ([backfill spec](./2026-09-29-flair-backfill-design.md) §1).
- **Removing a flair:** delete its entry. Stored rows with that id are no longer drawn, counted or
  accepted by `PUT` (§4).
- **Ids are permanent and never reused.** Awards and backfill versions are keyed by id.

### 1.8 Move patterns

Detectors live in `apps/server/src/flair/patterns.ts`. Each is a pure function of the game's
stored moves (`ply`, `uci`, `san`, `fen_after`) and a side, and needs no chess.js replay. White
moves at odd plies, Black at even ones.

| Pattern | The side… |
|---|---|
| `en_passant` | made a pawn capture (SAN `^[a-h]x[a-h][36]`) onto the en-passant square of the position before it: the fourth field of the previous ply's `fen_after` equals the move's destination (the first move of a game can never be one) |
| `castle_queenside` | played a move whose SAN starts `O-O-O` |
| `promotion` | played a move whose UCI has a fifth character (promotion to any piece) |
| `underpromotion` | played a promotion whose fifth UCI character is not `q` |
| `queen_mate` | made the game's last move, its SAN ends `#`, and in its `fen_after` the side has exactly a king and a queen |
| `bishops_mate` | the same, with exactly a king and two bishops |
| `flawless_mate` | made the game's mating last move, and no move by the opponent has an `x` in its SAN (pawns and en passant included) |
| `marathon` | is in a game of more than 200 plies, that is, one past move 100. The side does not matter |
| `pacifist_mate` | made the game's mating last move, and none of its own moves has an `x` in its SAN (pawns, en passant and capturing promotions included). The opponent may capture |
| `bongcloud` | played `e4` then `Ke2` as its first two moves (Black: `e5` then `Ke7`), whatever the opponent played |
| `scholars_mate` | made the game's last move, and it is `Qxf7#` at ply ≤ 7 (White) or `Qxf2#` at ply ≤ 8 (Black). In other words the queen mated by capturing on f7 or f2 by its side's fourth move, which covers the Qh5 and Qf3 lines and Black's mirror |

## 2. Data

Migration `0007_flair`:

**`user_flair`**: one row per earned flair.

| Column | Type | Notes |
|---|---|---|
| `user_id` | bigint, not null, references `users.id` | |
| `flair_id` | text, not null | A catalog id |
| `game_id` | bigint, not null, references `games.id` | The game that earned it |
| `earned_at` | timestamptz, not null | That game's `finished_at` |

Primary key `(user_id, flair_id)`. New flair never needs a migration.

**`users.flair_worn`**: `text[]`, not null, default `'{}'`. The worn ids in slot order, at most 3.

**`flair_introductions`**: `flair_id` text primary key; `introduced_at` timestamptz, not null,
default `now()`. No longer read since migration `0008`, which adds `flair_backfills`; a later release drops it ([backfill spec](./2026-09-29-flair-backfill-design.md) §2).

## 3. Awarding

Server code lives in `apps/server/src/flair/`:

- `patterns.ts`: the detectors (§1.8).
- `rules.ts`: one evaluator per rule kind (§1.4).
- `history.ts`: loads counted games.
- `award.ts`: the job's logic.
- `worn.ts`: slot filling (§3.3).
- `profile.ts`: the `GET` answer and the `PUT` validation and write (§4).
- `introductions.ts`: records introductions (§3.1). Removed by the [backfill](./2026-09-29-flair-backfill-design.md).

The job handler is `jobs/handlers/flair.ts`.

### 3.1 Introductions at boot

Replaced by the [backfill spec](./2026-09-29-flair-backfill-design.md) §3: boot enqueues a backfill of any flair not yet backfilled.

### 3.2 The `award_flair` job

`finishGame` enqueues `award_flair` inside the transaction that ends the game, when the game is not
an engine game and the result is `1-0`, `0-1` or `1/2-1/2`. The payload is `{ gameId }`, the dedup key
`flair:g:<publicId>`. `JOB_KINDS` gains `award_flair`, registered in `coreJobHandlers`.

The handler runs in one transaction:

1. **Read the game.** If it no longer counts (for example it was voided before the job ran), stop.
   Otherwise read its moves once.
2. **Lock both players' user rows** in one statement, in ascending id order
   (`select … where id in (white, black) order by id for no key update`), so two award jobs for
   games between the same pair can never deadlock. `for no key update` still makes a `PUT` of the
   worn list, Delete my data and other awards take turns with the job, but not the foreign-key
   checks of rows that refer to either player (new games, ratings), which take `for key share`.
3. **For each player, white then black:**
   1. Skip them if they are deleted or the bot.
   2. Take the flair they do not hold.
   3. Load all their counted games up to and including this game: rows only (id, colour, result,
      rated, `finished_at`, rating after).
   4. For each such flair, evaluate its rule at this game on those rows. Detectors see this game's
      moves.
   5. Insert what was earned with `game_id` and `earned_at` set to this game and its `finished_at`,
      using `on conflict do nothing`. Only rows actually inserted count as new.
   6. Fill free worn slots with the new flair (§3.3).

The job runs outside the game's transaction, so a failing rule fails only its own job and never
the game ending. Flair appears about a second after the game ends (the worker polls every second).
Nothing is pushed over SSE; screens show it the next time they load.

### 3.3 Worn slots

New flair fills free slots, whatever its category. If there is more new flair than free slots, a
uniformly random subset fills them. Chosen ids are appended to `flair_worn` in catalog order. A
player who emptied slots on purpose sees them refill when they next earn flair.

### 3.4 Delete my data

`deleteMyData` deletes the user's `user_flair` rows and sets `flair_worn` to `'{}'` in its existing
transaction. Games against a deleted player still count for the other player.

## 4. API

Schemas go in `packages/shared/src/protocol` next to the others.

- **`PlayerRefSchema` gains `flair: z.array(z.string()).max(3)`**: the worn ids in slot order.
  `toPlayerRef` fills it from `users.flair_worn`, dropping ids not in the catalog; it is `[]` for
  deleted players and the bot. Every query behind `toPlayerRef` already selects the whole user row,
  so game DTOs, summaries, challenges, leaderboard entries and the player page get it without
  further changes. Ids travel as plain strings, so an older app still open during a deploy draws
  the ids it knows and skips the rest.
- **`GET /api/me/flair`** returns `FlairDto`:
  ```ts
  { worn: string[]; earned: { id: string; earnedAt: string /* ISO */; opponent: string }[] }
  ```
  `opponent` is the display name of the other player in the earning game, and is "Deleted player"
  if they deleted their data. Earned rows whose id is no longer in the catalog are left out.
- **`PUT /api/me/flair`** takes `FlairUpdateRequest = { worn: string[] }` and returns the same
  `FlairDto`. It locks the user row and refuses, with `DomainError('validation')` (400), more than 3
  ids, duplicates, ids not in the catalog, or ids the caller has not earned.
- Both routes live in a new `api/routes/flair.ts` behind the existing session, like every `/api`
  route.

## 5. Mini App

### 5.1 Flair beside names

A new `ui/Flair.tsx`, `<Flair ids={player.flair} />`, draws the emojis of the ids the catalog knows
in one `span.flair`, or nothing. Its `aria-label` lists their descriptions. The name ellipsises
before the flair does: flair is `flex: none`, using the `.name-row` technique.

| Place | Size | Position |
|---|---|---|
| `GameCard` (Games tab, lobby lists, player page) | 13 px | After the opponent's name. Cards of games you only watch ("A vs B") show none, as in the prototype |
| `PlayerBar` on the game screen | 14 px | Between the name and the rating. The name line becomes a name row, so the flair and rating are never clipped |
| `PlayerRow` on the Leaderboard screen | 15 px | After the name |
| The player page header | 20 px | After the name |

The emojis sit 1 px apart (2 px on the player page), as in the prototype, spaced with a flex
`gap` rather than `letter-spacing`, which can split ZWJ sequences such as 🧑‍🦼.

### 5.2 The Settings row

A new first row in Settings' preferences card: "Flair", with "N% unlocked" beneath it, then the
worn emojis (16 px) and a chevron. N is the earned flair still in the catalog as a share of the
catalog, rounded. Tapping it pushes `{ name: 'flair' }` in the Settings tab. Settings loads
`GET /api/me/flair` when it mounts. The row shows "Flair" and the chevron at once, and the
percentage and emojis once the response arrives; if the load fails, the row keeps working and the
Flair screen shows its own error. The loaded `FlairDto` sits in a signal in `state/flair.ts`,
shared with the Flair screen.

### 5.3 The Flair screen

A new route `{ name: 'flair' }` and screen `ui/screens/Flair.tsx`. It loads `GET /api/me/flair`
on mount, with the usual Loading and ErrorScreen states.

- **Title** "Your flair".
- **Preview card**: your avatar (26 px), your name and your worn emojis (15 px). There is no rating
  (see "Where this spec departs").
- **Three slot tiles** in a grid inside the same card. Each shows its emoji (34 px), or a faint "·"
  when empty, above "Slot N". The selected slot has the `--acc` ring and `--acc-soft` fill, with
  its label in `--acc-text`. Slot 1 is selected when the screen opens. Tapping a tile selects it,
  with a selection haptic.
- **One section per category**, in `FLAIR_CATEGORIES` order: an uppercase section label, then a
  card listing that category's flair in catalog order. Each row has:
  - a 44 px emoji tile on `--page`: `--acc-soft` when the flair is in the selected slot, and
    greyscale at 45% opacity when locked;
  - the description, in `--hint` when locked;
  - when earned, a line in `--acc-text`: "Earned Jan 2026" for the rank ladder,
    "Earned vs @tom_rook · Aug 12" for the other categories, with the year added when it is not
    the current year ("Dec 30, 2025");
  - on the right: a ✓ badge (in the selected slot), a "Slot N" chip (worn in another slot), an
    empty ring (earned, not worn) or a "Locked" chip.
- **Tapping an earned row** gives a selection haptic and applies the slot logic (§5.4). The app
  updates the signal at once, sends `PUT /api/me/flair` with the new list, and replaces the signal
  with the response. On failure it restores the previous list and shows the `app.common.error`
  toast. Locked rows do nothing.

### 5.4 Slot logic

A pure `wearFlair(worn, slot, id)` in `state/flair.ts` mirrors the prototype. Take the three slots
(`worn[0..2]`, missing ones empty).

- If `id` is already in the selected slot, empty that slot.
- Otherwise put `id` in the selected slot, and if `id` was in another slot, move the selected
  slot's previous occupant there (a swap).

Finally drop the empty slots, so the list closes up. Which slot is selected is screen state only
and is not saved.

### 5.5 Copy and styles

New strings in `en.ts`:

- `app.settings.flair`: "Flair"
- `app.settings.flair_unlocked`: "{percent}% unlocked"
- `app.flair.title`: "Your flair"
- `app.flair.slot`: "Slot {n}"
- `app.flair.locked`: "Locked"
- `app.flair.earned`: "Earned {when}"
- `app.flair.earned_vs`: "vs {opponent} · {date}"
- `flair.category.*` (§1.2)
- the 14 `flair.<id>` descriptions

Dates are formatted with `Intl.DateTimeFormat('en-US')`, month first: `{ month: 'short', year:
'numeric' }` for the rank ladder ("Jan 2026"), `{ month: 'short', day: 'numeric' }` otherwise
("Aug 12"), with `year: 'numeric'` added when the date is not in the current year
("Dec 30, 2025"). en-US is used because its abbreviations match the prototype's ("Sep"; en-GB
gives "Sept").

`app.settings.delete_confirm` gains nothing: flair is part of "your data".

`styles.css` gains `.flair` (with its per-place sizes), `.flair-preview`, `.flair-slots`,
`.flair-slot` (`.on`), `.flair-row` (`.locked`), `.flair-tile` and `.flair-check`, built on the
redesign's tokens; the chips reuse `.tag`.

## 6. Error handling

| Case | Behaviour |
|---|---|
| A rule or detector throws | `award_flair` retries with backoff, then fails and is logged (`jobs_failed_total{kind="award_flair"}`). The game already ended normally; only that game's awards are lost |
| The job runs again after a failure or a duplicate enqueue | One transaction and `on conflict do nothing`. Only inserted rows fill slots, so nothing is doubled |
| Two of one player's games end at the same instant | Each is evaluated when its job runs. A streak or total whose `n`-th game was evaluated before the other commit became visible is awarded at the player's next qualifying game (§1.4) |
| The game was voided before its job ran | No flair for it (§3.2 step 1) |
| The game is voided after it earned flair | The flair is kept |
| A player deletes their data before the job runs | Skipped for that player |
| Game against the bot, abort, timeout abort, void while active | No job is enqueued |
| `PUT` with more than 3 ids, duplicates, an unknown or unearned id | 400 `validation`. The app restores the previous list and shows the error toast |
| `PUT` and an award for the same user at once | Both lock the user row. The award fills slots from the list as the `PUT` left it |
| Stored ids for flair removed from the catalog | Not drawn, not counted in "% unlocked", refused by `PUT` |

## 7. Testing and gates

- **Shared unit tests:**
  - the catalog has unique ids and unique emojis;
  - every id has its `flair.<id>` string;
  - the emojis and descriptions match §1.2 code point for code point;
  - the rank bands are contiguous and do not overlap;
  - `flairById` returns `undefined` for an unknown id.
- **Server unit tests, detectors:**
  - `en_passant`, against an ordinary pawn capture onto the sixth rank;
  - `castle_queenside`, against O-O;
  - `promotion`, including underpromotion;
  - `scholars_mate` via Qh5 and Qf3, and Black's mirror, against `Qxf7#` at ply 9 and a
    `Qxf7+` that is not mate;
  - `marathon` at 200 plies (no) and 201 (yes);
  - `pacifist_mate` with no captures, against a capture, an en passant capture, a capturing
    promotion and a win that is not mate; the opponent's captures do not matter;
  - each only for the side that made the move.
- **Server unit tests, evaluators:**
  - `held` at band edges, with rounding (1199.5 → 1200) and for casual games;
  - `won` and `lost` by result;
  - `streak` skipping casual games and broken by a draw or a loss, for wins and losses;
  - `ended` by result and by reason, and never for a null reason;
  - `against` counting only games against `g`'s opponent, with and without `result`, and
    requiring `g` itself to have `result`;
  - `total` counting only games that pass the filter;
- **Server integration tests (PostgreSQL):**
  - `finishGame` enqueues `award_flair` for games against people, and not for bot games or aborts;
  - each flair is awarded in a realistic game: an en passant win, an O-O-O win, a promotion win,
    the fifth rated win in a row with a casual game in between, the tenth draw, a rated game
    leaving a rating in a band;
  - 🪤 goes only to the side that was mated;
  - 🐔 on a resignation, 😈 on the fifth loss to one person with games against others between,
    👬 to both players at their fifth game together, 🗑️ on the tenth rated loss in a row;
  - the backfill awards the third batch for past games;
  - new flair fills free slots, and a random subset when there are more than free slots;
  - a re-run job changes nothing;
  - a void keeps flair;
  - `deleteMyData` removes awards and worn flair;
  - `GET` and `PUT /api/me/flair`, including each validation error;
  - `PlayerRef.flair` appears in the game DTO, summaries, the leaderboard and the player page,
    and is empty for a deleted player and the bot;
  - boot enqueues the backfill ([backfill spec](./2026-09-29-flair-backfill-design.md) §7).
- **Mini App unit tests:**
  - `wearFlair` (put, clear, swap, close up);
  - `<Flair>`, including unknown ids;
  - flair on `GameCard`, `PlayerBar`, `PlayerRow` and the player header;
  - the Settings row before and after its data loads;
  - the Flair screen's catalog counts after the third batch;
  - every Flair screen row state;
  - slot selection;
  - the optimistic save and its revert with a toast.
- **Playwright:**
  - the 390 px no-overflow screens spec covers the Flair screen in light and dark;
  - it also covers a game screen and a leaderboard whose players wear three flair and have long
    names;
  - the end-to-end harness can seed earned and worn flair for its players.
- **Images:** `scripts/vendor-snapshot-art.mjs` is re-run after adding flair, so
  `apps/server/src/images/flairEmoji.ts` has a picture for every id.
- **Gates:** the full check suite passes (lint, format, typecheck, tests, bundle budget,
  licences), followed by a visual pass in the browser against the prototype.

## 8. PRD changes

- **§3, Non-goals:** "achievements" is removed from the first bullet. A note after the list, like
  the engine opponent's, records that flair was deliberately added on 2026-09-29 and links this
  spec.
- **§7.12, Privacy:** "Stored per user" gains earned and worn flair, and Delete my data removes
  them.
- **§8.2, Settings:** gains the Flair row and screen.
- **§8.4:** "Emoji only as button icons" becomes "Emoji only as button icons and as flair beside
  names".

## 9. Later

These were considered and left out; the design keeps each one possible.

- **Revocation on void:** re-derive a player's flair after a void or a ratings rebuild.
- **A notice when flair is earned**, and tapping worn flair to see what it means.
