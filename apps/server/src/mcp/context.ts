import type { AuthInfo } from '@modelcontextprotocol/server';
import type { TurnLeaseRow, UserRow } from '../db/schema';
import type { Deps } from '../domain/deps';

/** The request's own hooks, the same on both surfaces. */
type CallHooks = {
  /** Sends `notifications/progress` when the request asked for it; a no-op otherwise. */
  progress(message: string): Promise<void>;
  /** Fires when the client cancels or disconnects. */
  signal: AbortSignal;
};

/**
 * What an owner tool's `run` gets: the owner the bearer token resolved to, and the request's own
 * hooks. The owner is who the call is for, never who it acts as: play tools act as one of the
 * owner's bots.
 */
export type McpCall = CallHooks & { deps: Deps; owner: UserRow; publicUrl: string };

/**
 * What a turn tool's `run` gets: the bot the turn token plays for and its lease as the routes
 * loaded it (`lease.claimSeq` is the token's claim).
 */
export type TurnCall = CallHooks & { deps: Deps; bot: UserRow; lease: TurnLeaseRow };

/** The per-request context the routes resolve and pass through the SDK. */
export type McpRequestScope =
  | { surface: 'owner'; deps: Deps; owner: UserRow; publicUrl: string }
  | { surface: 'turn'; deps: Deps; bot: UserRow; lease: TurnLeaseRow };

const SCOPE_KEY = 'chessGoat';

/**
 * The `authInfo` the routes hand the SDK for a resolved scope. It carries no token: nothing past
 * the routes needs one, so none can leak into a log or a reply.
 */
export function scopeAuthInfo(scope: McpRequestScope): AuthInfo {
  return {
    token: '',
    clientId: scope.surface === 'owner' ? String(scope.owner.id) : `lease:${scope.lease.id}`,
    scopes: [],
    extra: { [SCOPE_KEY]: scope },
  };
}

/**
 * The scope the routes resolved, read back from the SDK's per-request `authInfo`, on the surface
 * the tool belongs to.
 */
export function scopeFromAuthInfo<S extends McpRequestScope['surface']>(
  authInfo: AuthInfo | undefined,
  surface: S,
): Extract<McpRequestScope, { surface: S }> {
  const scope = authInfo?.extra?.[SCOPE_KEY] as McpRequestScope | undefined;
  // The routes never dispatch without one, nor to the other surface's server; reaching this is a
  // wiring bug, not a client error.
  if (scope?.surface !== surface)
    throw new Error(`MCP request without a resolved ${surface} scope`);
  return scope as Extract<McpRequestScope, { surface: S }>;
}
