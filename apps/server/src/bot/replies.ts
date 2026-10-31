import { t, type MessageKey, type MessageParams } from '@chess-goat/shared';
import type { Deps } from '../domain/deps';
import { isDomainError } from '../domain/errors';
import { displayName, getUserById } from '../domain/users';

/** The one-line command replies of spec §5.5, chosen from a DomainError's reason. */
export function replyFor(error: unknown): { key: MessageKey; params: MessageParams } | null {
  if (!isDomainError(error)) return null;
  const count = Number(error.details.count ?? 0);
  switch (error.details.reason) {
    case 'self':
      return { key: 'reply.self', params: {} };
    case 'blocked':
    case 'opponent_gone':
      return { key: 'reply.blocked', params: {} };
    case 'pending_limit':
      return { key: 'reply.pending_limit', params: { count } };
    case 'open_disabled':
      return { key: 'reply.open_disabled', params: {} };
    default:
      return null;
  }
}

/** Private toasts for callback taps (spec §11); null means "answer silently, rethrow". */
export async function alertFor(
  deps: Deps,
  error: unknown,
  action: 'accept_challenge' | 'decline_challenge' | 'rematch',
): Promise<string | null> {
  if (!isDomainError(error)) return null;
  switch (error.details.reason) {
    case 'not_your_challenge': {
      const { opponentId, opponentUsername } = error.details;
      const opponent =
        typeof opponentId === 'number' ? await getUserById(deps.db, opponentId) : null;
      return t('alert.not_your_challenge', {
        name:
          typeof opponentUsername === 'string'
            ? `@${opponentUsername}`
            : opponent
              ? displayName(opponent)
              : 'the challenged player',
      });
    }
    case 'not_the_challenger': {
      const challengerId = error.details.challengerId;
      const challenger =
        typeof challengerId === 'number' ? await getUserById(deps.db, challengerId) : null;
      return t('alert.not_the_challenger', {
        name: challenger ? displayName(challenger) : 'the challenger',
      });
    }
    case 'own_challenge':
      return t('alert.own_challenge');
    case 'accepted_first':
      return t('alert.accepted_first');
    case 'challenge_gone':
      return t('alert.challenge_gone');
    default: {
      const reply = replyFor(error);
      if (reply) return t(reply.key, reply.params);
      if (action === 'rematch' && error.code === 'forbidden')
        return t('alert.only_players_rematch');
      if (error.code === 'not_found' || error.code === 'expired' || error.code === 'stale_state') {
        return t('alert.challenge_gone');
      }
      return null;
    }
  }
}
