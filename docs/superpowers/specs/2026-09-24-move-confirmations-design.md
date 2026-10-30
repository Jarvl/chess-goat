# Move confirmations

Status: accepted for planning, 2026-09-24. Brings back the confirmation step that #16 removed,
as a three-way user setting. Supersedes the Settings card in §3.6 of the
[Chess Goat redesign](./2026-09-22-chess-goat-redesign-design.md) and the "Tab bar visibility"
paragraph of the [navigation spec](./2026-09-22-miniapp-tab-navigation.md) where they conflict
with this one.

Update, 2026-10-29: the [conditional premoves spec](./2026-10-29-conditional-premoves-design.md)
supersedes the minimise and leave rules below. Minimising keeps the waiting move, and leaving the
game asks first when it holds unconfirmed changes (Telegram's own prompt covers closing the app).

## Why

Alpha players asked to be able to turn move confirmations on or off. #16 made every move send
on drop, which suits bot games, where you make many moves in one sitting and a slip costs
nothing. It is riskier in games against people, where a mis-drop is permanent (there are no
takebacks), shows in the group, and can cost rating. Those games are usually one move per
visit, so one extra tap is cheap there.

Time control is not a factor. Every game against a person allows at least an hour per move,
and bot games have no clock, so a confirm tap never costs clock time.

## The setting

**Move confirmations**, one of:

| Value | Label | Confirms in |
|---|---|---|
| `always` | Always | Every game, the bot included |
| `people` | Only against people | Games against a person, rated or not. **Default** |
| `never` | Never | No game: every move sends on drop, as today |

A game is against a person when `GameDto.engineLevel` is `null`. Spectators never confirm,
because they cannot move.

### Data

- `packages/shared/src/protocol/enums.ts`: `MOVE_CONFIRMATIONS = ['always', 'people', 'never']`
  and `MoveConfirmationsSchema`.
- `PrefsSchema` gains `moveConfirmations: MoveConfirmationsSchema`, and `PREFS_DEFAULTS`
  gains `moveConfirmations: 'people'`.
- Storage is the existing `users.prefs` jsonb, so there is no migration. `PUT /api/me/prefs`
  validates the value through `PrefsSchema.partial()` as it does for every preference. An
  unknown value gets the existing `validation` error.
- **The pre-#16 preference.** Before #16 the preference was a boolean, `confirmMoves`.
  `updatePrefs` merges patches into the jsonb (`||`), so rows that turned it off still hold
  `confirmMoves: false`. `prefsOf` reads that as `moveConfirmations: 'never'`, so those players
  don't get confirmations back. A stored `moveConfirmations` always wins. `confirmMoves: true`,
  or no key at all, reads as the default. `prefsOf` still drops `confirmMoves` from what the API
  returns.
- The server only stores and validates the value. Whether to confirm is decided in the Mini
  App.

## The game screen

### Flow

When a move needs confirming (the setting against this game, see above):

1. **Drop, or pick a promotion piece.** The piece stays on its target square with the
   move highlight. The board holds that position (the `frozen` mode #16 removed): nothing else
   lifts, and incoming position updates are held back until the move resolves. The move strip
   ignores taps while a move waits. The drop haptic plays as it does today.
2. **Telegram's bottom bar** shows **Cancel** (SecondaryButton, which sits to the left of the
   MainButton by default) and **Confirm move** (MainButton, in the Chess Goat accent via the
   existing `setMainButtonColors`). The in-page **tab bar is hidden** (see below). Offer draw,
   Claim draw, Abort and Resign are disabled, as they already are while `busy`.
3. **Confirm.** The SecondaryButton hides and the MainButton shows its progress spinner, so
   the bar stays up and doesn't flash. The move is sent as today (`clientMoveId`,
   `expectedPly`). After the response:
   - **200:** the MainButton hides, the tab bar returns, and "Return to the chat after moving"
     behaves as today.
   - **409 / 422:** reload, snap back, no message, as today. The bar hides and the tab bar
     returns.
   - **Network error:** the existing retry state. The MainButton reads "Retry" and the tab bar
     stays hidden until the move settles.
4. **Cancel.** The piece snaps back (the `restore` effect), the buttons hide and the tab bar
   returns.
5. **The game changes while a move waits.** If a `state` arrives whose `plyCount` or `status`
   differs (the opponent resigns, you run out of time, an admin voids the game), the waiting
   move is cancelled as in step 4. The server would reject its `expectedPly` anyway.

When a move doesn't need confirming, nothing changes from today. It sends on drop, shows no
MainButton, and greys the board with a spinner if the send takes over 1 s.

Confirm is the point of no return. Leaving the screen afterwards does not withdraw a request
the server may already have. As today, unmounting stops any further retries.

### Leaving cancels a waiting move

A move waiting for Confirm is never sent if the player leaves the Game screen. Only the current
route is rendered (`App.tsx`), so every in-app exit unmounts `GameView` and the waiting move is
discarded with it:

- switching tabs;
- Telegram's BackButton;
- Telegram's Settings menu item (`onSettingsButton` selects the Settings tab);
- opening another game (a new `Game` key);
- closing the app. **There is no "close anyway?" prompt**: leaving is the cancel, so
  `setClosingConfirmation` is not used on this screen.

The unmount cleanup hides the MainButton and SecondaryButton and clears the tab-bar
suppression.

**Minimising.** Telegram 8.0 can collapse the app into a bar without unmounting anything. The
`Tg` wrapper gains `onDeactivated(callback)`, backed by the `deactivated` event and gated as a
new `Feature` at `'8.0'`. It is a no-op below 8.0. `GameView` subscribes to it, and a
deactivation while a move waits cancels it as in step 4. Below 8.0, a minimised app keeps its
waiting move.

### The tab bar while a move waits

The tab bar is hidden from the drop that starts a confirmation until the move settles
(sent, cancelled, rejected, or discarded), the same rule New game uses. Telegram's bar takes
roughly the space the tab bar frees up. So on phones where height sets the board size
(`min(100vw, stable-height − 200px − --board-reserve)`), the board barely changes size instead
of shrinking by the bar's height. Hiding it also means no tab switch can leave a move waiting
by accident, although leaving is covered anyway.

Mechanism: `Router` gains a writable `suppressTabs: Signal<boolean>`, and `showTabs` becomes
`!TABLESS.has(current.name) && !suppressTabs.value`. `GameView` sets it when it enters the
confirmation and clears it when the move settles and on unmount.

### Older clients and the browser

- **Below 7.10 (no SecondaryButton):** `setSecondaryButton` returns `false`, and an in-page
  **Cancel** pill appears at the start of the action row.
- **No MainButton** (a plain browser, where `tg.available` is false): `setMainButton` returns
  `false`, and both **Confirm move** (primary) and **Cancel** pills appear at the start of the
  action row.

### State machine

`apps/miniapp/src/state/moveMachine.ts` gets back the parts #16 removed, except the closing
confirmation:

- The `pendingConfirm` state, and the `confirm` and `cancel` events.
- `reduceMove(state, event, { confirm })`. From `idle`, a `drop` goes to `pendingConfirm`
  when `confirm` is true and to `sending` otherwise. `confirm` goes to `sending` with a
  `send` effect. `cancel` goes to `idle` with a `restore` effect.
- No `closingConfirmation` effect.

A pure helper next to it decides `confirm` per move:

```ts
needsConfirmation(setting: MoveConfirmations, game: { engineLevel: EngineLevel | null }): boolean
// always → true; people → game.engineLevel === null; never → false
```

`GameView` reads `prefs.value.moveConfirmations` when the drop happens, so a setting changed
mid-game applies from the next move.

## The Settings screen

- **Move confirmations** becomes the first row in the card that holds the two switches. It is
  a row button with the label on the left, the current choice in `--hint`, and a chevron, and
  `data-pref="moveConfirmations"`.
- Tapping it opens a new `choiceDialog` in `ui/dialog.tsx`, next to `confirmDialog` and
  `infoDialog`:
  - **Native (6.2+):** `showPopup` with the title "Move confirmations", the message "Ask before
    a move is sent. With "Only against people", moves against the bot send on drop.", and three
    `default` buttons, one per choice. The popup cannot mark a button as selected, so the
    current choice's text starts with "✓ ". It resolves to the chosen value, or `null` when the
    popup is dismissed.
  - **In-page fallback** (below 6.2, or a client that rejects the call, the same rule `ask`
    uses today): the existing bottom sheet, extended to show a list of choices with the current
    one checked.
- Picking the current choice, or dismissing, changes nothing. Picking another choice goes
  through the screen's existing `update`: the change applies at once, is sent to
  `PUT /api/me/prefs`, and reverts with the error toast on failure. The selection haptic plays
  on a change, as it does for the switches.

## Copy

New `en.ts` keys:

| Key | Text |
|---|---|
| `app.settings.move_confirmations` | Move confirmations |
| `app.settings.move_confirmations.always` | Always |
| `app.settings.move_confirmations.people` | Only against people |
| `app.settings.move_confirmations.never` | Never |
| `app.settings.move_confirmations_help` | Ask before a move is sent. With "Only against people", moves against the bot send on drop. |
| `app.game.confirm_move` | Confirm move |

Cancel uses the existing `app.game.cancel`, and sending uses `app.game.sending`.

## Out of scope

- A per-game override on the game screen.
- Any change to the dialogs that already confirm Resign, Abort and Void.
- Premoves, board themes and piece sets.

## Testing

**Shared**
- `PrefsSchema` accepts `always`, `people` and `never`, and rejects anything else.
  `PREFS_DEFAULTS.moveConfirmations` is `people`.

**Server** (integration, `TEST_DATABASE_URL`)
- `prefsOf`:
  - A stored `confirmMoves: false` reads as `never`.
  - `confirmMoves: true`, or no key, reads as `people`.
  - A stored `moveConfirmations` wins over `confirmMoves`.
  - `confirmMoves` is never returned.
- `PUT /api/me/prefs` stores and returns `moveConfirmations`, and refuses an unknown value
  with `validation`.

**Mini App unit** (happy-dom)
- `reduceMove`:
  - A drop with `confirm` goes to `pendingConfirm`.
  - Confirm sends; cancel restores.
  - A drop without `confirm` sends at once, as today.
- `needsConfirmation`: all three settings, against a person and against the bot.
- `GameView`, with a waiting move:
  - Buttons: Cancel and Confirm move are bound. Confirm shows progress and hides Cancel. The
    in-page Cancel appears when the SecondaryButton is unavailable, and both in-page pills
    appear without a MainButton.
  - Board: the promotion pick waits for Confirm, and the move strip is inert.
  - Tab bar: `router.showTabs` is false while the move waits and true once it settles.
  - Cancelled by: unmounting (buttons hidden, nothing sent), a deactivation, and a `state` with
    a new `plyCount` or `status`.
  - `never`, and a bot game under `people`, still send on drop.
- `Settings`:
  - The row shows the current choice.
  - `choiceDialog` puts the ✓ on the current choice.
  - Picking saves. A failed save reverts and toasts.
  - Dismissing does nothing.
  - The in-page sheet is used when `showPopup` is unavailable.
- `Tg`: `onDeactivated` subscribes at 8.0 and is a no-op below.

**End-to-end** (Playwright, `apps/miniapp/e2e`)
- In a game against a person with the default: drop, Confirm, and the move is sent; drop,
  Cancel, and the piece is back with nothing sent.
- In a bot game with the default, the move sends on drop.
- With `never`, a game against a person sends on drop.
- With a move waiting, selecting another tab cancels it, and the move was never sent.

**By hand, before merging**
- On a real iPhone and a real Android phone, drop a move in a game against a person and watch
  the board as Telegram's bar appears and the tab bar hides. It should keep its size, or
  change by a few pixels at most. If it jumps noticeably, stop and revisit the tab-bar decision
  before merging.

## Docs to update in the same change

- PRD §6.3 "Make a move" step 3, §7.4 "Confirm moves", and the Settings line in §8.2: the
  setting's name, its three values and its default.
- Technical design:
  - §6.2: the Settings (user) row.
  - §6.3: add the `pendingConfirm` branch to the move state machine.
  - §8: `users.prefs` gains `move_confirmations` (default `people`).
  - §6.6 already lists the SecondaryButton's in-page Cancel fallback, so it stays.
- Navigation spec, "Tab bar visibility": note that the tab bar is also hidden while a move
  waits for Confirm, and link here.
