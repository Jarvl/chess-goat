import type { RegisterRoutes } from '../app';
import { adminRoutes } from './admin';
import { botsRoutes } from './bots';
import { challengeRoutes } from './challenges';
import { eventsRoutes } from './events';
import { flairRoutes } from './flair';
import { gamesRoutes } from './games';
import { groupsRoutes } from './groups';
import { tipRoutes } from './tips';

/** Everything behind a session besides the account routes. */
export const gameRoutes: RegisterRoutes[] = [
  groupsRoutes,
  botsRoutes,
  challengeRoutes,
  gamesRoutes,
  eventsRoutes,
  adminRoutes,
  tipRoutes,
  flairRoutes,
];
