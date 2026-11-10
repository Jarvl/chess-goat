import { useEffect, useState } from 'preact/hooks';
import { serverNow } from '../../state/session';
import type { GameStore } from '../../state/game';

/** A once-a-second `now` on the server's clock while the game is running. */
export function useClock(store: GameStore): Date {
  const [now, setNow] = useState(() => serverNow());
  const active = store.dto.value.status === 'active';
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setNow(serverNow()), 1_000);
    return () => clearInterval(timer);
  }, [active]);
  return now;
}
