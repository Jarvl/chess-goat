# Game switcher strip

Status: draft, awaiting owner approval, 2026-10-30. Mockups (option A was chosen):
https://claude.ai/artifact/Wv1TawEkppzkWgSA5SNM1w

## Why

Moving between your active games today means Back to the list, then a tap into the next game,
for every game. The owner wants a quicker way across from one game to the next.

## Goals, non-goals, anti-goals

**Goals**

- From inside one of your games, one tap opens any of your other active games.
- At a glance, the strip shows which games are waiting on you.

**Non-goals**

- Auto-advancing to the next game after a move. Considered and dropped: with confirmations off
  the move sends on drop, and jumping away would take away the moment for premoves and for seeing
  a quick reply.
- A swipe gesture on the board area. The board drag, the move slider and Android's edge-back
  gesture already claim horizontal swipes there.
- Server changes, or a new live feed for all games.

**Anti-goals**

- Thumbnails moving around while you're reaching for one.
- Back costing more taps the more games you've hopped through.
- The board shrinking noticeably on short phones.

## Approaches

1. **Refresh at sensible moments (chosen).** The strip reads `GET /me/games`: on entering a game,
   on every switch, when the app becomes visible again, and every ~30 s while a game screen is
   open. The current game stays live through its own stream as today. No server work. The cost:
   another game's thumbnail can lag by up to ~30 s.
2. **A per-user live feed.** A new SSE stream carrying summaries of all the viewer's games. Truly
   live, but it needs new server work and takes one of the four streams a user may open (spec
   §7.8). Not worth it while most games move over hours.
3. **One stream per thumbnail.** Rejected: the four-stream cap rules it out.

## What was decided

- **Placement:** a horizontally scrolling row at the very top of the game screen, above the meta
  line and the top player bar (mockup A).
- **Each thumbnail:** a 56 px `MiniBoard` with the real position and last move, seen from your
  side, and the opponent's name below it in 11 px, truncated. Games waiting on you are at full
  strength with a gold (`--move`) dot. Other games are greyed out, the way `GameCard` dims them.
  The game you're on has a green (`--acc`) ring and is never dimmed. Each thumbnail is a
  `<button>` with an accessible label (opponent, and whose move it is).
- **When it shows:** on a game where you're a player, active or finished, when you have at least
  one other active game. Hidden when spectating, and hidden when the strip would hold only the
  current game.
- **Which games:** all your active games across every group, the same set as the Games tab, bot
  games included.
- **Order:** captured once, when you arrive at a game from somewhere else (a list, a deep link, a
  DM). It is the Games tab order at that moment: your move first, then most recently moved. It
  stays fixed while you hop between games. Refreshes change positions, dots and dimming, never
  the order. A game that newly appears goes on the end. A game that ends drops out at the next
  refresh, except the one you're on.
- **Tapping a thumbnail:** `router.replace` to that game, so Back still returns to wherever you
  came from in one tap. The existing leave guard asks first when there's an unconfirmed move or
  premoves. Tapping the current game does nothing.
- **Scroll position:** the strip opens scrolled so the current game is in view.

## Constraints

- Board sizing: the board's height budget in `styles.css` (`--meta-rows`, `--replay-row`,
  `--board-reserve`) must account for the strip's height (~85 px) when the strip is shown, so the
  page doesn't scroll on short screens.
- The fixed order has to outlive the game screen, because each switch replaces the route. Module
  state, like `state/yourMove.ts`, fits.
- Each refresh also reconciles the Games-tab badge (`countYourMove`), which keeps the badge and
  the strip in agreement.
- The polling stops when the game screen unmounts or the app is hidden.

## Left to the builder

- Component and module names, and exactly where the fixed order is captured versus reused (for
  example, captured on `push`/`land` of a game route and kept on `replace`).
- Whether the first strip load reuses the Games tab's already-fetched list when there is one.
- The polling interval within ~20–60 s.
- Tests: unit tests for the ordering rules, and an e2e test that switches games and checks Back
  and the leave guard.
