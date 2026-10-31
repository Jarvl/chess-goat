import {
  ENGINE_LEVELS,
  INITIAL_FEN,
  type ColourChoice,
  type EngineLevel,
} from '@chess-goat/shared';
import { eq } from 'drizzle-orm';
import type { DbOrTx } from '../db/client';
import { games, users, type GameRow, type UserRow } from '../db/schema';
import { enqueue } from '../jobs/queue';
import { randomColour } from './challenges';
import type { Deps } from './deps';
import { DomainError } from './errors';
import { requireGroup } from './groups';
import { isBlocked } from './members';
import { generatePublicId } from '../db/ids';
import { requireUser } from './users';

/** The single engine user, created by migration 0002 (spec §5). */
export async function getEngineUser(tx: DbOrTx): Promise<UserRow> {
  const [row] = await tx.select().from(users).where(eq(users.isEngine, true)).limit(1);
  if (!row) throw new Error('the engine user is missing; migration 0002 did not run');
  return row;
}

export function isEngineGame(game: Pick<GameRow, 'engineLevel'>): boolean {
  return game.engineLevel !== null;
}

export type CreateEngineGameInput = {
  groupId: number;
  userId: number;
  level: EngineLevel;
  colour: ColourChoice;
};

/** Spec §6.1. No challenge, no card, no expiry: there is nothing to accept. */
export async function createEngineGame(deps: Deps, input: CreateEngineGameInput): Promise<GameRow> {
  if (!ENGINE_LEVELS.includes(input.level)) {
    throw new DomainError('validation', 'unknown engine level', {
      reason: 'invalid_level',
      level: input.level,
    });
  }
  const result = await deps.db.transaction(async (tx) => {
    const group = await requireGroup(tx, input.groupId);
    const player = await requireUser(tx, input.userId);
    const engine = await getEngineUser(tx);
    if (await isBlocked(tx, group.id, player.id)) {
      throw new DomainError('forbidden', 'blocked in this group', { reason: 'blocked' });
    }
    const playerColour = input.colour === 'random' ? randomColour() : input.colour;
    const white = playerColour === 'white' ? player : engine;
    const black = playerColour === 'white' ? engine : player;
    const engineToMove = white.isEngine;
    const [game] = await tx
      .insert(games)
      .values({
        publicId: generatePublicId(),
        groupId: group.id,
        whiteId: white.id,
        blackId: black.id,
        // Spec §8: a bot game has no clock. The bot replies immediately, so a deadline measures
        // nothing about it, and its only possible effect is losing a casual game to inattention.
        timePerMove: null,
        rated: false,
        engineLevel: input.level,
        fen: INITIAL_FEN,
        // Spec §9: the engine never carries a deadline, so it can never be forfeited.
        // Follows from the null clock above, and stated outright so it survives a later edit.
        deadlineAt: null,
        // Spec §8: a bot game sends no move notifications, so it never carries a reminder —
        // not even on the human's turn.
        reminderAt: null,
      })
      .returning();
    if (!game) throw new Error('engine game insert returned no row');
    if (engineToMove) await enqueueEngineMove(tx, game);
    return game;
  });
  deps.bus.publish(result.publicId);
  return result;
}

export function enqueueEngineMove(
  tx: DbOrTx,
  game: Pick<GameRow, 'id' | 'publicId' | 'plyCount'>,
): Promise<void> {
  return enqueue(tx, {
    kind: 'engine_move',
    payload: { gameId: game.id },
    dedupKey: `engine:g:${game.publicId}:ply:${game.plyCount}`,
  });
}
