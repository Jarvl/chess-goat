# Challenging from the chat: a private prompt for `/challenge`

Status: design, 2026-10-31. Mockup: https://claude.ai/artifact/TQzDAB7K8M6fiFBgcBqH8f (private to the owner).

## Why

Group members don't know how `/challenge` works. Its three forms (`/challenge @name`, `/challenge` as a
reply to someone, bare `/challenge` for an open challenge) are invisible, and the common path breaks
them: picking a command from Telegram's command menu sends it immediately with no arguments
(core.telegram.org/bots/features). Today that bare `/challenge` posts an open challenge, whatever the
person meant.

People in the chat want two things equally: to play a particular friend, and to get any game going.
They must be able to challenge **anyone in the group**, including members the bot has never seen. The
bot only knows a member once they have used a command or button, been challenged by reply or text
mention, or joined after the bot arrived. The app's opponent picker is therefore not an answer, and
the Bot API still has no way to list a group's members (checked against Bot API 10.3, 2026-08-24).

## Goals

- A bare `/challenge` (the command-menu tap) leads to a clear choice: a particular person or anyone.
- Anyone in the group can be challenged from the chat, seen by the bot or not.
- The person challenging can change time per move, colour and rated/casual from the chat.
- The group still sees no command chatter: only challenge cards, game cards and shared positions
  (PRD §3 goal 4, §7.5).

## Non-goals

- Changing the app's New game screen, the group admin settings, or the app's time-control list.
- Turning privacy mode off. The bot keeps receiving only commands, replies to its messages and button
  taps.
- Any in-chat move entry or board (PRD §3 non-goals stand).

## Anti-goals

- Any prompt, error or help text visible to the whole group when it concerns only one person.
- A challenge flow that only reaches people the bot has already seen.

## What the spike established

A throwaway bot ran on the staging token (@ChessGoatTestBot) in a real group on 2026-10-31:

- **Reply prompt with buttons works.** A message with an inline keyboard plus `force_reply: true` on
  `InlineKeyboardMarkup` (Bot API 10.3) opened the sender's reply box automatically. The reply reached
  the bot under privacy mode, and callback taps on its buttons arrived normally.
- **Ephemeral commands work.** A command registered with `is_ephemeral: true` (Bot API 10.2) arrived
  with `message_id: 0` and an `ephemeral_message_id`. The bot's answer, sent with
  `reply_parameters.ephemeral_message_id` and `ephemeral_message_parameters.receiver_user_id`, appeared
  only for the sender, carrying its inline keyboard and `force_reply`.
- **Slow replies to a private prompt work.** The user's reply came 76 s after the prompt, arrived as an
  ephemeral message with `reply_to_message` set to the prompt (including the prompt's `reply_markup`),
  and the bot's ephemeral answer to it succeeded. The 15-second rule binds the **bot**: it must answer
  within 15 s of each user action (command, reply or callback), not the user.
- **Telegram's `@` autocomplete lists bots.** The tester picked a bot. Picks of members with a username
  arrive as a plain `mention` entity (text only, no user id).
- **Prompt copy:** a literal "@name" in the prompt text was parsed as a mention entity. Don't write a
  bare `@word` in prompt copy.

Not verified, because only one human account was in the group:
- that other members see neither the ephemeral command nor the prompt (the docs say so);
- that picking a member **without** a username yields a `text_mention` with the user;
- button taps on the *ephemeral* prompt, and the `editEphemeralMessage…` / `deleteEphemeralMessage`
  calls. Taps were only tried on the normal prompt; nothing was edited or deleted;
- **whether an ephemeral `/challenge` sent as a reply to someone's message still carries
  `reply_to_message`.** See Risks.

## Approaches considered

1. **Private (ephemeral) prompt with a normal-message fallback** (chosen). This is the only approach
   that keeps the group quiet. It relies on Bot API 10.2/10.3 features and needs two delivery paths.
2. **Normal messages only.** The same prompt as ordinary messages, deleted after use. It is simpler,
   with one path, but the group sees every command and prompt until they're used. It's also unknown
   whether the auto-opened reply box pops up for other members. It survives inside approach 1 as the
   fallback.
3. **Hand off to the app.** A bare `/challenge` posts a link to New game. Rejected: the app only knows
   players the bot has seen.

The owner picked approach 1.

## The design

### Commands

All group commands are registered with `is_ephemeral: true`. The group menu still holds exactly three
commands (PRD §7.1).

| Command | Behaviour |
|---|---|
| `/challenge` (bare) | Private prompt (below). |
| `/challenge @name`, or replying `/challenge` to someone's message | Post the challenge card **at once**. Time 3 days, colour random, rated from the group's `ratedDefault`. No prompt. |
| `/chess` | The same buttons as today, sent privately. |
| `/settings` | The same button as today, sent privately. |

Every error or refusal is private to the sender. This covers self, bots, anonymous senders,
`pending_limit`, `open_disabled` and blocked. These are the existing `reply.*` lines, sent ephemerally.

Private commands stay as they are; `/paysupport` is untouched.

### The prompt

This is the mockup's layout. A private message to the sender:

> Who do you want to play? Type @ and pick them from the list, or tap Anyone.
> `3 days per move · Random colour · Rated`

- **Main view keyboard:** **Anyone** (green, `style: "success"`) and **Game settings**.
  `force_reply: true` on the keyboard, so the reply box opens straight away.
- **Settings view:** the same message, with its keyboard edited in place
  (`editEphemeralMessageReplyMarkup`) to show:
  - Time: **1 day**, **3 days**, **7 days**
  - Colour: **Random**, **White**, **Black**
  - **Rated** or **Casual**
  - **Done**

  The current choice in each row uses `style: "primary"` (blue). Each tap re-renders the keyboard and
  the summary line (`editEphemeralMessageText`). **Done** returns to the main view.
- **Starting values:** 3 days, Random, and the group's `ratedDefault`. The chat prompt **always starts at
  3 days**, ignoring the group's `defaultTimePerMove` (owner's decision: the 1d/3d/7d list and the 3d
  default apply to the chat only). The admin default keeps governing the app only.

**Anyone** creates an open challenge with the current settings. A **reply** to the prompt creates a
direct challenge with the current settings, against the person named in it (below). On success the
prompt is deleted (`deleteEphemeralMessage`), and the public challenge card is posted exactly as
today, so the existing card, DM and expiry machinery is unchanged.

The settings are always available, but the starting values make the common path one step.

### Who the reply names

The reply's first `text_mention` or `mention` entity decides:

- **`text_mention`** (a member without a username): Telegram hands over the user. `ensureUser` and
  `touchMember`, then challenge them directly, as today.
- **`mention` of a member the bot knows** (`findMemberByUsername` hits): challenge that user directly,
  as today.
- **`mention` of a username the bot has never seen:** a new **challenge by username** (next section).
- **Bot usernames, the sender's own username, and the bot itself** are refused privately ("Bots don't
  play here." / "You can't challenge yourself."). Every bot username ends in "bot", so the suffix
  identifies a bot without a lookup.
- **No mention in the reply:** answer privately with one line explaining how to pick someone. Keep the
  prompt open.

The same resolution applies to `/challenge @name` typed by hand. This replaces today's
`reply.unknown_mention` refusal.

### Challenge by username

A pending challenge can name its opponent by Telegram username alone:

- **Schema:** `challenges.opponent_username` (text, nullable, stored lower-case). It is set only when
  `opponent_id` is null. A challenge is open only when both are null.
- **Card:** "♟ Alice challenges @bob" in plain text. Telegram notifies @bob of a plain username mention
  in a group message. No DM is possible, because there is no user id.
- **Accept from the card:** allowed only when the tapper's `from.username` matches, case-insensitively. On accept,
  set `opponent_id`, run the blocked check (the only accept-time check today; the code has no
  game caps, whatever PRD §7.2 says) and proceed as a normal accept. A non-matching tapper gets the existing
  `alert.not_your_challenge` with name "@bob".
- **Decline:** the same username check.
- **Withdraw:** the challenger, as today.
- **In the app** (owner's decision): the lobby shows the challenge with "@bob" as the opponent. Only
  a user whose current Telegram username (from the launch's `initData`) matches can accept or decline
  it there. Nobody else sees it as acceptable. This touches the shared `ChallengeDto`, `challengeToDto`
  (today it treats "no opponent" as open), the accept/decline routes, and the app's challenge rows.
  The username check belongs in the domain layer, so the bot and the API share it. Each passes the
  username it has live: the callback's `from.username`, or the launch's username.
- **Members without a username** never become challenges by username. Picking them from the `@` list
  yields a `text_mention` with the user, so they're challenged directly. A name typed without picking
  has no entity, and gets the private "pick them from the list" line.
- **Username changed before accepting:** nobody matches, so the challenge expires.
- **Expiry:** 24 h, as today. A mistyped username or a non-member simply expires. That's acceptable
  because the `@` autocomplete is the normal input.

### Delivery

- **Answer in time.** Ephemeral answers must be sent within 15 s of the triggering update, so they are
  sent directly from the update handler, not through the job queue. The public challenge card keeps
  going through `createChallenge` and its existing jobs.
- **Fallback when Telegram refuses an ephemeral send** (an older client, or any error on the ephemeral
  call):
  - Send the same prompt as a normal message, replying to the command, with `force_reply` and the same
    keyboard, and delete it when the flow completes or the challenge is created.
  - A fallback prompt still only acts on the original sender's taps and replies. Anyone else gets a
    private callback toast or is ignored.
- **Abandoned prompts:** a prompt that is never answered is simply left; ephemeral messages vanish on
  their own. A fallback prompt is deleted after 10 minutes. That cleanup is the job queue's job.

### Keeping prompt state

The reply to a prompt arrives with `reply_to_message` containing the prompt's keyboard, and callbacks
carry the message. The current settings can therefore travel in the buttons' `callback_data`
(64-byte limit), and the prompt itself needs no server-side state. A short-lived server row is equally
acceptable if it is simpler; this is the builder's call (see below).

### Docs to update

- **PRD:** §6.2, §7.1, §7.2, §7.5 (the "Reply to `/challenge`" row becomes private), §8.3, §9 (add
  ephemeral messages and commands, and `force_reply` on inline keyboards), and §10 (the "unknown
  usernames" row).
- **Welcome card copy** (`card.welcome`), which mentions `/challenge @name`.
- **Command descriptions:** `command.challenge.description` should describe the menu-tap behaviour.

## Risks

1. **Ephemeral `/challenge` as a reply to someone.** If Telegram drops `reply_to_message` on ephemeral
   commands, the reply-to form breaks. **Check this first on staging, before building anything else.**
   The spike's method: temporarily point the staging Dokploy app at a throwaway branch with a small
   bot, then restore it to `main`.
   - If it is dropped, keep `/challenge` **non-ephemeral**. The bot cannot answer a normal command
     privately unless it is a group admin. The docs allow an ephemeral answer only to a callback, to
     an ephemeral message, or from an admin bot. So:
     - a bare `/challenge` from an admin bot gets the private prompt;
     - otherwise it gets the fallback prompt;
     - in either case, delete the user's command message when the bot has delete rights.
   - Refusals to a non-ephemeral `/challenge` from a non-admin bot (my call, as designer): a one-line
     public reply to the command, as today, deleted after 60 s.
   - `/chess` and `/settings` stay ephemeral either way; they don't depend on reply targets.
   - **Decision, 2026-11-01 (owner):** the staging test showed ephemeral commands arrive without
     `reply_to_message`. The owner dropped the reply-to form instead of keeping `/challenge`
     non-ephemeral. `/challenge` is now ephemeral, so the prompt and every refusal are private in
     every group, admin or not. A `/challenge` replying to a message opens the prompt; replying to
     the prompt itself replaces it. The non-ephemeral path above remains only for clients that send
     `/challenge` as a normal message.
2. **New Bot API surface.** The grammY version in use (1.46) may lack types for the 10.2/10.3 fields.
   Use raw calls with local types rather than upgrading for this alone.
3. **Delivery isn't guaranteed.** Telegram does not promise ephemeral delivery, especially when the
   user is offline. The user is online by definition when they've just sent a command, but the
   fallback must cover an outright refusal.

## Left to the builder

- Whether prompt state lives in `callback_data` or a short-lived row.
- Exact copy for new lines. Follow PRD §8.4: short, and no bare `@word` in prompt text.
- How the ephemeral send/edit/delete calls are wrapped, and how the fallback is detected (error
  classification).
- Test shape, following the existing bot handler tests.
