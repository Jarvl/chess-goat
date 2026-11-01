# Chat Challenge Prompt Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A bare `/challenge` in a group opens a private prompt. From it, the person picks anyone in the
group (or Anyone) and can change game settings. Challenges by username reach members the bot has
never seen, and all command chatter becomes private.

**Architecture:**
- **Ephemeral messages (Bot API 10.2/10.3).** These are sent directly from the update handler through a
  small raw-call wrapper (`bot/ephemeral.ts`), not the job queue. That keeps answers inside Telegram's
  15-second window.
- **Prompt state** lives entirely in the prompt buttons' `callback_data`, so the prompt needs no table.
- **Challenge by username** adds one nullable column, with the matching rule enforced in the domain
  layer. The bot and the API share it.

**Tech Stack:** TypeScript, grammY 1.46 (raw calls for the new methods), Hono, Drizzle/Postgres,
Vitest, Preact Mini App.

**Spec:** `docs/superpowers/specs/2026-10-31-chat-challenge-prompt-design.md`

## Global Constraints

- The group command menu holds exactly `/challenge`, `/chess` and `/settings`, all `is_ephemeral: true`.
  The exception is if Task 0 finds Risk 1; then `/challenge` stays non-ephemeral.
- The chat prompt's time choices are exactly 1 day (86400), 3 days (259200) and 7 days (604800).
  - It always starts at 259200, ignoring the group's `defaultTimePerMove`.
  - Colour starts `random`. Rated starts from the group's `ratedDefault`.
- `/challenge @name` and replying `/challenge` to someone post the card at once, with 259200 / random /
  `ratedDefault`.
- No literal `@word` in any prompt copy (Telegram parses it as a mention).
- Every error or refusal caused by one person is sent privately to that person. If Telegram refuses
  the ephemeral send, the fallback is a normal message deleted after 60 s.
- Ephemeral answers go out from the update handler, never through `enqueue`.
- Bot usernames are recognised by the case-insensitive suffix `bot`.
- `challenges.opponent_username` is stored lower-case, without `@`, and only when `opponent_id` is null.
- Accepting a username challenge runs only the blocked check, the same as every accept today.
- An unanswered fallback prompt is deleted after 600 s.
- Copy follows PRD §8.4: short and plain.

## Review Focus

1. **A reply to a card or game card that isn't a prompt.** Privacy mode delivers replies to *any* bot
   message, and the bot must stay silent. Test in Task 6.
2. **Usernames that differ only in case, and accepters with no username.** "@Bob" challenged, and "bob"
   taps: accepted. An accepter with no username: `not_your_challenge`, name "@bob". Test in Task 2.
3. **Someone other than the owner taps or replies to a fallback (public) prompt.** Toast, or ignored;
   the prompt is unchanged. Test in Task 7.
4. **A prompt reply in a forum topic.** The card goes to that topic, or to the fixed card topic when
   configured. Test in Task 6.
5. **Anyone or a reply that hits `pending_limit` or `open_disabled`.** A private error line, the prompt
   stays, and no challenge row. Test in Task 6.

---

### Task 0: Staging check (gate, run by the controller with the owner)

This task produces no code. It settles Risk 1 and the two unverified spike items before Task 6 commits
to a command shape. The owner taps through it in their staging group.

- [ ] **Step 1: Borrow staging.**
  - Push a throwaway branch with `spike/Dockerfile` (python:3.12-alpine, copying one script).
  - Point Dokploy app `mV8Q_Y3_4vWVDNl8zT9uC` at it: `saveGithubProvider` branch, then
    `saveBuildType` with dockerfile `spike/Dockerfile` and dockerContextPath `.`.
  - Deploy.
- [ ] **Step 2: The test bot.** A long-polling script that registers `/challengep` with
  `is_ephemeral: true` and logs raw updates to stdout. When `/challengep` arrives, it answers with an
  ephemeral prompt carrying an inline button and `force_reply`. On a callback from that prompt, it
  calls `editEphemeralMessageText` with a new keyboard and then, on a second tap,
  `deleteEphemeralMessage`.
- [ ] **Step 3: The owner runs three checks.**
  - (a) Reply to someone else's message with `/challengep`.
  - (b) In the reply box, pick a member who has **no username**.
  - (c) Tap the ephemeral prompt's button twice.
- [ ] **Step 4: Record the answers at the top of Task 6, from the logs.**
  - **R1:** does the ephemeral command carry `reply_to_message`?
  - **TM:** is a `text_mention` with `user` delivered?
  - **CB:** do callbacks from an ephemeral message carry `message.ephemeral_message_id` and
    `message.reply_markup`, and do the edit and delete succeed?
- [ ] **Step 5: Restore staging.**
  - Branch `main`, dockerfile `Dockerfile`, context `.`, then redeploy.
  - Confirm the log shows `server started` with no warning about commands or the webhook.
  - Delete the throwaway branch.

If **CB** shows no `reply_markup` on ephemeral callbacks, Task 5's markup-borne state still works for
replies. The spike saw `reply_markup` on `reply_to_message`. Callbacks would then rebuild the state
from the tapped button's own data, which Task 5 already supports: every button carries the full
state.

---

### Task 1: Shared protocol (prompt callbacks, DTO field, copy)

**Files:**
- Modify: `packages/shared/src/protocol/callbackData.ts`
- Modify: `packages/shared/src/protocol/dto.ts` (`ChallengeDtoSchema`)
- Modify: `packages/shared/src/i18n/en.ts`
- Test: `packages/shared/test/protocol/callbackData.test.ts`, `packages/shared/test/protocol/dto.test.ts`

**Interfaces:**
- Produces:
  - `type PromptTime = 86400 | 259200 | 604800`.
  - `type PromptSettings = { timePerMove: PromptTime; colour: ColourChoice; rated: boolean }`.
  - `CallbackData` gains `{ action: 'prompt'; op: 'main' | 'settings' | 'anyone'; ownerTelegramId: number; settings: PromptSettings }`.
  - `encodeCallbackData` and `decodeCallbackData` handle it.
  - `ChallengeDto` gains `opponentUsername: string | null`.
- Wire format: `cp/<op>/<owner>/<t>/<c>/<r>`.
  - `op`: `m`, `s` or `a`.
  - `t`: `1`, `3` or `7` (days).
  - `c`: `r`, `w` or `b`.
  - `r`: `1` or `0`.
  - Owner: 1–16 digits.

- [ ] **Step 1: Write the failing tests**

```ts
it('round-trips a prompt callback with its full state', () => {
  const data = { action: 'prompt', op: 'settings', ownerTelegramId: 256228126,
    settings: { timePerMove: 604800, colour: 'black', rated: false } } as const;
  expect(encodeCallbackData(data)).toBe('cp/s/256228126/7/b/0');
  expect(decodeCallbackData('cp/s/256228126/7/b/0')).toEqual(data);
});
it('rejects prompt callbacks outside the three times', () => {
  expect(decodeCallbackData('cp/m/1/2/r/1')).toBeNull();
  expect(decodeCallbackData('cp/x/1/3/r/1')).toBeNull();
});
```

In `dto.test.ts`, also check that `ChallengeDtoSchema` parses
`opponentUsername: 'bob'` and `opponentUsername: null`.

- [ ] **Step 2: Run them.**
  `pnpm vitest run packages/shared/test/protocol`. Expected: FAIL.
- [ ] **Step 3: Implement.** Extend the union, the regex and the switch. Add
  `opponentUsername: z.string().nullable()` to `ChallengeDtoSchema`. Add these i18n keys:

| Key | Text |
|---|---|
| `prompt.challenge` | `Who do you want to play? Type @ and pick them from the list, or tap Anyone.` |
| `prompt.summary` | `{timePerMove} · {colour} · {rated}` |
| `prompt.colour.random` | `Random colour` |
| `prompt.colour.white` | `You play White` |
| `prompt.colour.black` | `You play Black` |
| `button.anyone` | `Anyone` |
| `button.game_settings` | `Game settings` |
| `button.done` | `Done` |
| `button.time.1d` | `1 day` |
| `button.time.3d` | `3 days` |
| `button.time.7d` | `7 days` |
| `button.colour.random` | `Random` |
| `button.colour.white` | `White` |
| `button.colour.black` | `Black` |
| `button.rated` | `Rated` |
| `button.casual` | `Casual` |
| `reply.pick_someone` | `Type @ in your reply and pick who you want to play from the list.` |
| `alert.not_your_prompt` | `Only {name} can use this.` |

  - Delete `reply.unknown_mention`.
  - Change `command.challenge.description` to `Challenge someone, or anyone who wants a game`.
  - Change `card.welcome` to `Play chess with this group on a real board inside Telegram. Tap
    Challenge someone to pick an opponent, or send /challenge here. The chat only sees results and
    shared positions.`
- [ ] **Step 4: Run the tests, then `pnpm typecheck`.** Expected: the tests PASS. The typecheck
  errors only where `reply.unknown_mention` and `ChallengeDto` are used; Tasks 2, 3 and 6 fix those.
- [ ] **Step 5: Commit.** `Shared: prompt callback data, challenge opponentUsername, prompt copy`

### Task 2: Challenge by username (schema, domain, card)

**Files:**
- Modify: `apps/server/src/db/schema.ts` (`challenges.opponentUsername: text()`)
- Create: `apps/server/drizzle/0012_challenge_opponent_username.sql`, via `pnpm --filter @chess-goat/server db:generate`
- Modify: `apps/server/src/domain/challenges.ts` (`CreateChallengeInput`, `createChallenge`, `acceptChallenge`, `declineChallenge`)
- Modify: `apps/server/src/telegram/views.ts` (`challengeCardView`)
- Modify: `apps/server/src/bot/replies.ts` (`alertFor`, case `not_your_challenge`)
- Test: `apps/server/test/integration/challenges.test.ts`

**Interfaces:**
- Produces:
  - `CreateChallengeInput.opponentUsername: string | null`. It is normalised to lower-case without
    `@`, and is invalid together with `opponentId`.
  - The `not_your_challenge` details gain `opponentUsername?: string`.
  - Accepting and declining keep their signatures; they compare the accepter's stored
    `users.username`.

- [ ] **Step 1: Write the failing tests** in `challenges.test.ts`:

```ts
it('lets only the named username accept, whatever its case, and fills in the opponent', ...)
  // createChallenge({ ..., opponentId: null, opponentUsername: 'Bob' }) stores 'bob';
  // a user with username 'BOB' accepts → status 'accepted', opponentId = that user.
it('refuses an accepter whose username differs or who has none, naming @bob', ...)
  // rejects with DomainError details { reason: 'not_your_challenge', opponentUsername: 'bob' }.
it('lets the named username decline and the challenger withdraw', ...)
it('sends no challenge DM for a username challenge and renders @bob on the card', ...)
  // challengeCardView(...).opponent → { name: '@bob', username: 'bob', telegramUserId: null, flair: null }.
```

- [ ] **Step 2: Run them.** `pnpm vitest run apps/server/test/integration/challenges.test.ts`.
  Expected: FAIL.
- [ ] **Step 3: Implement.**
  - Add the column and generate the migration.
  - In `createChallenge`, store `opponentUsername` lower-cased. A username challenge enqueues no
    opponent DM.
  - In `acceptChallenge` and `declineChallenge`, a row with `opponentUsername` matches on
    `accepter.username?.toLowerCase()`. The `own_challenge` and withdraw branches apply only when both
    opponent fields are null.
  - `challengeCardView` builds the pseudo-person above.
  - `alertFor` names `@${opponentUsername}` when that detail is present.
- [ ] **Step 4: Run the file and the whole server suite.** Expected: PASS.
- [ ] **Step 5: Commit.** `Challenges can name their opponent by username`

### Task 3: Username challenges in the app

**Files:**
- Modify: `apps/server/src/domain/summaries.ts` (`challengeToDto`)
- Modify: `apps/server/src/domain/lobby.ts` (`pendingChallenges`), `apps/server/src/api/routes/groups.ts:86`, `apps/server/src/api/routes/games.ts:103`
- Modify: `apps/miniapp/src/ui/rows.tsx` (`ChallengeCard`)
- Test: `apps/server/test/integration/api-games.test.ts`, `apps/miniapp/test/lobby.test.tsx`

**Interfaces:**
- Consumes: `ChallengeDto.opponentUsername` (Task 1) and `challenges.opponentUsername` (Task 2).
- Produces: `challengeToDto(row: ChallengeDtoRow, viewer: { id: number; username: string | null }): ChallengeDto`.
  `pendingChallenges(tx, groupId, viewer)` takes the same viewer.

- [ ] **Step 1: Write the failing tests.**
  - API, a username challenge to "bob":
    - Bob, whose session user has username `bob`: `viewer: { canAccept: true, canDecline: true, canCancel: false }`.
    - Carol: all three false.
    - Both responses carry `opponent: null, opponentUsername: 'bob'`.
    - Bob's `POST /api/challenges/:id/accept` returns 200, and Carol's returns the
      `not_your_challenge` error.
  - Mini App, `lobby.test.tsx`:
    - A challenge with `opponentUsername: 'bob'`, viewed by someone else, reads
      `Alice challenges @bob`.
    - When `viewer.canAccept` is true, it reads `Alice challenges you`.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement.**
  - `canAccept` and `canDecline` are true for a username row when
    `viewer.username?.toLowerCase() === opponentUsername`.
  - An open challenge is now "both opponent fields null".
  - Pass `c.get('user')` (its `id` and `username`) at the call sites.
  - In `ChallengeCard`, branch on `opponentUsername` before `opponent === null`. Use
    `app.lobby.challenge.you` when `viewer.canAccept`, otherwise `app.lobby.challenge.direct` with
    opponent `@${opponentUsername}`.
- [ ] **Step 4: Run both suites.** Expected: PASS.
- [ ] **Step 5: Commit.** `Show username challenges in the app; only the named user may answer`

### Task 4: Ephemeral transport

**Files:**
- Create: `apps/server/src/bot/ephemeral.ts`
- Modify: `apps/server/test/helpers/fakeTelegram.ts`
  - `sendMessage` with `ephemeral_message_parameters` answers `message_id: 0` and a fresh
    `ephemeral_message_id`.
  - `editEphemeralMessageText` and `deleteEphemeralMessage` answer `true`.
- Modify: `apps/server/test/helpers/updates.ts`. `commandUpdate` gains `ephemeral?: boolean`, which
  sets `message_id: 0` and an `ephemeral_message_id`. Add these helpers:
  - `promptReplyUpdate({ chat, from, text, entities, prompt: { markup, ephemeralMessageId?, messageId? }, threadId?, ephemeral?: boolean })`.
  - `callbackUpdate`, gaining `ephemeralMessageId?` and `markup?`.
- Test: `apps/server/test/unit/ephemeral.test.ts`, against `FakeTelegram`

**Interfaces:**
- Produces:

```ts
export type EphemeralTrigger =
  | { ephemeralMessageId: number }   // the user's ephemeral command or reply
  | { callbackQueryId: string };     // a tap
export function sendEphemeral(api: Api, input: {
  chatId: number; threadId: number | null; receiverId: number; trigger: EphemeralTrigger;
  text: string; replyMarkup?: InlineKeyboardMarkup & { force_reply?: boolean };
}): Promise<{ ephemeralMessageId: number } | null>;   // null: Telegram refused (any 4xx)
export function editEphemeral(api: Api, input: {
  chatId: number; receiverId: number; ephemeralMessageId: number;
  text: string; replyMarkup: InlineKeyboardMarkup;
}): Promise<void>;
export function deleteEphemeral(api: Api, input: {
  chatId: number; receiverId: number; ephemeralMessageId: number;
}): Promise<void>;
```

- [ ] **Step 1: Write the failing tests.**
  - `sendEphemeral` with a message trigger posts `reply_parameters: { ephemeral_message_id }` and
    `ephemeral_message_parameters: { receiver_user_id }`.
  - With a callback trigger, it posts `ephemeral_message_parameters.callback_query_id`.
  - It returns the fake's `ephemeral_message_id`.
  - After `fake.failNext('sendMessage', { error_code: 400, description: 'Bad Request' })`, it returns
    null.
  - Edit and delete post exactly `chat_id`, `receiver_user_id` and `ephemeral_message_id`, plus the
    text and markup for edits.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement.**
  - Call through `(api.raw as unknown as Record<string, (p: object) => Promise<unknown>>)[method]`.
  - `sendEphemeral` catches `GrammyError` with `error_code` 400–499 and returns null; it rethrows
    the rest.
  - Edit and delete swallow 400 "message to edit/delete not found" and rethrow the rest.
- [ ] **Step 4: Run them.** Expected: PASS.
- [ ] **Step 5: Commit.** `Bot: raw-call wrapper for ephemeral messages`

### Task 5: The prompt's view

**Files:**
- Create: `apps/server/src/bot/challengePrompt.ts`
- Test: `apps/server/test/unit/challengePrompt.test.ts`

**Interfaces:**
- Consumes: `PromptSettings` and the `prompt` `CallbackData` (Task 1).
- Produces:

```ts
export function startingSettings(group: GroupSettings): PromptSettings; // 259200, 'random', ratedDefault
export function promptView(view: 'main' | 'settings', owner: number, s: PromptSettings):
  { text: string; replyMarkup: InlineKeyboardMarkup & { force_reply: true } };
export function promptStateFrom(markup: unknown): { owner: number; settings: PromptSettings } | null;
  // first button whose callback_data decodes as action 'prompt'; null if none
```

- [ ] **Step 1: Write the failing tests.**
  - `promptView('main', 7, s)`:
    - Text is `prompt.challenge` + `\n` + `prompt.summary` (e.g.
      `3 days per move · Random colour · Rated`).
    - One row: `Anyone` (`style: 'success'`, data `cp/a/7/3/r/1`), then `Game settings` (data
      `cp/s/7/3/r/1`).
    - `force_reply: true`.
  - `promptView('settings', 7, s)`:
    - Rows: `1 day | 3 days | 7 days`, `Random | White | Black`, `Rated | Casual`, then `Done`.
    - The chosen button in each row has `style: 'primary'`, and the others have no style.
    - Each option's data is `cp/s/...` with that option applied. `Done` is `cp/m/...` with the
      current state.
  - `promptStateFrom` reads the state back from either view's markup, and returns null for a game
    card's markup.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement** with `t()` and the existing `timePerMoveLabel` and `ratedLabel` from the
  card code. Move them to a shared spot if they're private to `cards.ts`.
- [ ] **Step 4: Run them.** Expected: PASS.
- [ ] **Step 5: Commit.** `Bot: render and read the challenge prompt`

### Task 6: Wire the prompt into the bot

> Record Task 0's **R1 / TM / CB** answers here before starting.

**Files:**
- Create: `apps/server/src/bot/opponent.ts`. It moves the opponent logic out of `bot.ts`'s
  `/challenge` handler.
- Modify: `apps/server/src/bot/bot.ts`
- Modify: `apps/server/src/main.ts` (`BOT_COMMANDS.group`: each with `is_ephemeral: true`, cast for grammY's type)
- Test: `apps/server/test/integration/bot.test.ts`, `apps/server/test/integration/main.test.ts`

**Interfaces:**
- Consumes: Tasks 2, 4 and 5.
- Produces:

```ts
export type OpponentChoice =
  | { kind: 'user'; userId: number }
  | { kind: 'username'; username: string }       // lower-case, unseen in this group
  | { kind: 'refuse'; key: MessageKey }           // reply.bot | reply.self | reply.anonymous
  | { kind: 'none' };
export function resolveOpponent(deps: Deps, input: {
  groupId: number; challenger: User; message: Message; botUsername: string; useReplyTarget: boolean;
}): Promise<OpponentChoice>;
```

  - It takes the first `text_mention` or `mention` entity.
  - A `text_mention` is a user (refused if a bot or self).
  - A `mention` that is the bot, ends in `bot`, or equals the challenger's username is a `refuse`.
  - A `mention` of a known member is a user; otherwise it's a `username`.
  - With no entity: the reply target when `useReplyTarget`, otherwise `none`.

**Behaviour:**
- **Bare `/challenge`:** `sendEphemeral(promptView('main', from.id, startingSettings))` with trigger
  `{ ephemeralMessageId }`. If it returns null, use the Task 7 fallback.
- **`/challenge` with a mention or a reply target:** `createChallenge` at once, using 259200 / random
  / `ratedDefault` (`useReplyTarget: true`).
- **Callback `prompt`:** answer a tap from a user other than `ownerTelegramId` with
  `alert.not_your_prompt` (name: the owner's display name, or "the person who asked"). Then:
  - `main` or `settings`: `editEphemeral` with `promptView(op, owner, settings)`, then
    `answerCallbackQuery()`.
  - `anyone`: `createChallenge` with an open opponent and these settings. On success,
    `deleteEphemeral`. On a `replyFor` error, answer the callback with that text, keeping the prompt.
- **A reply whose `reply_to_message` is from the bot and has `promptStateFrom` state, from the
  owner:**
  - `resolveOpponent` with `useReplyTarget: false`.
  - `none` or `refuse`: a private line (`reply.pick_someone` or the refusal), with trigger
    `{ ephemeralMessageId: msg.ephemeral_message_id }`.
  - Otherwise `createChallenge` with the settings, then delete the prompt.
  - The thread is `cardThread(settings, msg.message_thread_id when is_topic_message)`.
- **Any other reply to the bot:** ignored.
- **Errors:** every `replyFor` error line and refusal from a command goes through one helper,
  `sayPrivately(ctx, key, params)`. It uses `sendEphemeral` with the message trigger and falls back to
  a normal message deleted after 60 s (Task 7). No `send_message` job is used for these lines any
  more.
- **`/chess` and `/settings`:** the same buttons, sent through `sendEphemeral`, with the normal
  `send_message` as fallback.
- **If R1 = "dropped":** `/challenge` is registered without `is_ephemeral`.
  - The bare form uses the ephemeral prompt only when `group.botIsAdmin`, sending with
    `ephemeral_message_parameters.receiver_user_id` and no trigger. Otherwise it uses the fallback.
  - When the bot can delete messages, the user's command message is deleted.
  - Add a test for each branch.

- [ ] **Step 1: Write the failing tests** in `bot.test.ts`. Update the existing `/challenge` tests for
  private refusals, and rewrite the unknown-mention test as a username challenge.

```ts
it('answers a bare ephemeral /challenge with a private prompt and creates nothing', ...)
  // sendMessage body: reply_parameters.ephemeral_message_id = update's, receiver = alice, text starts 'Who do you want to play?',
  // reply_markup.force_reply true; no challenges row; no send_message job.
it('edits the prompt to the settings view and back, carrying the chosen settings', ...)
it('creates an open challenge from Anyone with the prompt settings and deletes the prompt', ...)
  // after tapping cp/s/<alice>/7/b/0 then cp/a/<alice>/7/b/0: challenge { opponentId: null, timePerMove: 604800, challengerColour: 'black', rated: false }
it('challenges the member picked in a reply, known, unseen (by username) or without a username', ...)
it('refuses a bot or yourself picked in a reply, privately, and keeps the prompt', ...)
it('tells the owner privately to pick someone when the reply names nobody', ...)
it('posts /challenge @name at once with 3 days, random colour and the group rated default', ...)
it('ignores replies to cards and to other bot messages', ...)                       // Review Focus 1
it('posts the card in the reply topic, or the fixed topic when configured', ...)   // Review Focus 4
it('keeps the prompt and answers privately when Anyone hits the pending limit or open challenges are off', ...) // Review Focus 5
it('sends /chess and /settings privately', ...)
```

  In `main.test.ts`, assert that `setMyCommands` for `all_group_chats` sends the three commands, each
  with `is_ephemeral: true`.
- [ ] **Step 2: Run them.** `pnpm vitest run apps/server/test/integration/bot.test.ts apps/server/test/integration/main.test.ts`.
  Expected: FAIL.
- [ ] **Step 3: Implement** the behaviour above in `opponent.ts`, `bot.ts` and `main.ts`. Read
  `ephemeral_message_id` through a local type, since grammY's `Message` lacks it.
- [ ] **Step 4: Run the full server suite and `pnpm typecheck`.** Expected: PASS.
- [ ] **Step 5: Commit.** `Bot: private /challenge prompt with game settings`

### Task 7: Fallback when Telegram refuses an ephemeral message

**Files:**
- Modify: `apps/server/src/jobs/types.ts`, adding the `delete_message` job kind
- Modify: `apps/server/src/jobs/handlers/telegram.ts`
- Modify: `apps/server/src/bot/bot.ts`, in the fallback branches Task 6 left
- Test: `apps/server/test/integration/bot.test.ts`, `apps/server/test/integration/telegram-handlers.test.ts`

**Interfaces:**
- Produces: job `delete_message`, with payload `{ chatId: number; messageId: number }`, enqueued with
  `delaySeconds`. Its handler calls `deleteMessage` and treats "message to delete not found" as done.

**Behaviour:**
- **The prompt fallback** is a normal `sendMessage` straight from the handler (the 15 s rule doesn't
  apply to normal messages, but keep it direct for one code path). It:
  - replies to nothing, since the ephemeral command has `message_id` 0, and starts with the owner's
    mention (`@username`, or a `text_mention`) so `force_reply` targets them;
  - carries the same `promptView` markup;
  - is followed by an enqueued `delete_message` with `delaySeconds: 600`.
- **Prompt actions on a fallback prompt** (`message_id` ≠ 0) use `editMessageText` and
  `deleteMessage` in place of the ephemeral calls.
- **Taps or replies from anyone but the owner:** `alert.not_your_prompt`, or ignored for replies.
- **`sayPrivately` fallback:** a normal message, plus `delete_message` with `delaySeconds: 60`.

- [ ] **Step 1: Write the failing tests.**

```ts
it('falls back to a public prompt that deletes itself after ten minutes when Telegram refuses', ...)
  // fake.failNext('sendMessage', 400); then a normal sendMessage with the prompt markup; a delete_message job for that message_id, run_at ≈ now + 600 s.
it('works the fallback prompt with normal edits and deletes', ...)
it('ignores another member replying to, or tapping, the fallback prompt', ...)  // Review Focus 3
it('falls back to a public refusal that deletes itself after a minute', ...)
```

  In `telegram-handlers.test.ts`, the `delete_message` handler deletes, and finishes `done` when
  Telegram says the message is gone.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the full server suite.** Expected: PASS.
- [ ] **Step 5: Commit.** `Bot: public fallback for the private prompt and refusals`

### Task 8: Docs

**Files:**
- Modify: `docs/PRD.md`, in §6.2, §7.1, §7.2, §7.5, §8.3, §9 and §10, as listed under "Docs to update"
  in the spec
- Modify: `README.md`, wherever it describes `/challenge`

- [ ] **Step 1: Edit the docs.**
  - **§7.2:** drop the active-game and pair limits the code doesn't have.
  - **§8.3:** describe the menu tap → private prompt, and the instant `@name` / reply forms.
  - **§9:** add rows for ephemeral commands and messages (Bot API 10.2), `force_reply` on inline
    keyboards (10.3) and button `style` (9.4).
  - **§10:** the "unknown usernames" row now reads that challenges by username reach them.
- [ ] **Step 2: Run `pnpm format:check` and `pnpm lint`.** Expected: clean.
- [ ] **Step 3: Commit.** `Docs: the private /challenge prompt`

### Finish

- [ ] Run `pnpm typecheck && pnpm lint && pnpm test`. Expected: all pass.
- [ ] Deploy the branch to staging, using the Task 0 method with the real `Dockerfile`, and walk the
  owner through:
  - menu `/challenge`;
  - Game settings;
  - Anyone;
  - an `@` pick;
  - a reply-to challenge.

  Then restore staging to `main`.
