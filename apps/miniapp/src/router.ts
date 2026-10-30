import type { GroupRef } from '@group-chess/shared';
import { computed, signal, type ReadonlySignal, type Signal } from '@preact/signals';
import type { LobbyScope } from './state/lobby';
import type { Tg } from './tg/webapp';

export type Route =
  | { name: 'loading' }
  | { name: 'error' }
  | { name: 'reopen' }
  | { name: 'locked'; group: GroupRef }
  | { name: 'games' }
  | { name: 'groups' }
  /** `scope` is the Games tab left selected, kept for coming back from a game (dropped with the entry). */
  | { name: 'lobby'; groupId: string; scope?: LobbyScope }
  | { name: 'leaderboard'; groupId: string }
  | { name: 'newGame'; groupId: string; opponentId?: string }
  /** `hop` marks a game reached from the switcher strip, which keeps the strip's order. */
  | { name: 'game'; gameId: string; hop?: true }
  | { name: 'player'; groupId: string; userId: string }
  | { name: 'settings' }
  | { name: 'flair' }
  | { name: 'groupSettings'; groupId: string };

/** The bottom bar's sections; each keeps its own back stack. */
export type TabName = 'games' | 'groups' | 'settings';

export const TABS: readonly TabName[] = ['games', 'groups', 'settings'];

const TAB_ROOT: Record<TabName, Route> = {
  games: { name: 'games' },
  groups: { name: 'groups' },
  settings: { name: 'settings' },
};

/** Screens with no tab bar: before a session, and New game, whose MainButton owns the bottom. */
const TABLESS: ReadonlySet<Route['name']> = new Set([
  'loading',
  'error',
  'reopen',
  'locked',
  'newGame',
]);

type Stacks = Record<TabName, Route[]>;

/**
 * A game resumed from another section is arrived at, not hopped to: the switcher strip takes a
 * fresh order (game switcher spec), not whatever the other section's games left behind.
 */
function arrival(route: Route): Route {
  return route.name === 'game' && route.hop ? { name: 'game', gameId: route.gameId } : route;
}

/**
 * A tabbed in-memory router (Telegram owns the URL fragment). Tabs carry lateral movement and
 * never deepen a stack; the BackButton carries depth only, so it stays a single tap from the
 * way out (nav spec, superseding technical design §6.1 step 5).
 *
 * `closeFromRoot` is set for a launch that came from a chat link: there the BackButton also
 * shows at the root, where it closes, so "back to the chat I came from" keeps costing one tap.
 */
export class Router {
  readonly tab: Signal<TabName> = signal('games');
  readonly stacks: Signal<Stacks> = signal({ games: [], groups: [], settings: [] });
  /** Set by a screen that needs the bottom edge to itself for a while (a move waiting for Confirm move). */
  readonly suppressTabs: Signal<boolean> = signal(false);
  /**
   * Set by a screen that holds something to lose (an unconfirmed draft): every way out of it
   * (Back, a tab, Telegram's Settings item, push, replace) asks first and goes on only on true.
   */
  leaveGuard: (() => Promise<boolean>) | null = null;
  private asking = false;
  readonly stack: ReadonlySignal<Route[]>;
  readonly current: ReadonlySignal<Route>;
  readonly showTabs: ReadonlySignal<boolean>;

  constructor(
    private readonly tg: Tg,
    private readonly options: { closeFromRoot: boolean } = { closeFromRoot: false },
  ) {
    this.stack = computed(() => this.stacks.value[this.tab.value]);
    this.current = computed(() => this.stack.value.at(-1) ?? { name: 'loading' });
    this.showTabs = computed(
      () => !TABLESS.has(this.current.value.name) && !this.suppressTabs.value,
    );
    this.sync();
  }

  /**
   * Where a launch lands: one screen in one tab, so back never becomes the way home. `below`
   * slips screens under it for a form whose back should lead somewhere before it closes.
   */
  land(tab: TabName, route: Route, below: Route[] = []): void {
    this.tab.value = tab;
    this.write(tab, [...below, route]);
  }

  /** A lateral move: another tab resumes where it was left, the active one returns to its root. */
  select(tab: TabName): void {
    void this.leave(() => {
      const kept = this.stacks.value[tab].map(arrival);
      const next = tab === this.tab.value || kept.length === 0 ? [TAB_ROOT[tab]] : kept;
      this.tab.value = tab;
      this.write(tab, next);
    });
  }

  push(route: Route): void {
    void this.leave(() => this.write(this.tab.value, [...this.stack.value, route]));
  }

  replace(route: Route): void {
    void this.leave(() => this.write(this.tab.value, [...this.stack.value.slice(0, -1), route]));
  }

  /**
   * Runs `action` when nothing guards the screen, or when the guard agrees to leave. With no
   * guard it runs in the same tick, so unguarded navigation stays synchronous.
   */
  async leave(action: () => void): Promise<void> {
    const guard = this.leaveGuard;
    if (guard) {
      // One question at a time: a second tap while it is open is not a second request.
      if (this.asking) return;
      this.asking = true;
      try {
        if (!(await guard())) return;
      } finally {
        this.asking = false;
      }
    }
    action();
  }

  /** Pops one level within the active tab; false at its root, where the caller may close. */
  back(): boolean {
    if (this.stack.value.length <= 1) return false;
    this.write(this.tab.value, this.stack.value.slice(0, -1));
    return true;
  }

  private write(tab: TabName, stack: Route[]): void {
    this.stacks.value = { ...this.stacks.value, [tab]: stack };
    this.sync();
  }

  private sync(): void {
    const visible = this.stack.value.length > 1 || this.options.closeFromRoot;
    this.tg.setBackButton(visible, () => {
      void this.leave(() => {
        if (!this.back()) this.tg.close();
      });
    });
  }
}
