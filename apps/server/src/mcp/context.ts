import type { AuthInfo } from '@modelcontextprotocol/server';
import type { UserRow } from '../db/schema';
import type { Deps } from '../domain/deps';

/**
 * What a tool's `run` gets: the owner the bearer token resolved to, and the request's own hooks.
 * The owner is who the call is for, never who it acts as: play tools act as one of the owner's bots.
 */
export type McpCall = {
  deps: Deps;
  owner: UserRow;
  /** Sends `notifications/progress` when the request asked for it; a no-op otherwise. */
  progress(message: string): Promise<void>;
  /** Fires when the client cancels or disconnects. */
  signal: AbortSignal;
};

/** The per-request context the routes resolve and pass through the SDK. */
export type McpRequestScope = { deps: Deps; owner: UserRow };

const SCOPE_KEY = 'chessGoat';

/**
 * The `authInfo` the routes hand the SDK for a resolved owner. It carries no token: nothing past
 * the routes needs one, so none can leak into a log or a reply.
 */
export function scopeAuthInfo(scope: McpRequestScope): AuthInfo {
  return {
    token: '',
    clientId: String(scope.owner.id),
    scopes: [],
    extra: { [SCOPE_KEY]: scope },
  };
}

/** The owner and deps the routes resolved, read back from the SDK's per-request `authInfo`. */
export function scopeFromAuthInfo(authInfo: AuthInfo | undefined): McpRequestScope {
  const scope = authInfo?.extra?.[SCOPE_KEY] as McpRequestScope | undefined;
  // The routes never dispatch without one; reaching this is a wiring bug, not a client error.
  if (!scope) throw new Error('MCP request without a resolved owner');
  return scope;
}
