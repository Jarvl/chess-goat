import type { McpServer, ServerContext, ToolAnnotations } from '@modelcontextprotocol/server';
import type { ZodType } from 'zod';
import type { UserRow } from '../db/schema';
import { resolveOwnBot, touchBotActivity } from '../domain/bots';
import { isDomainError } from '../domain/errors';
import { requireLiveLease, spendCall } from '../domain/turnLeases';
import { scopeFromAuthInfo, type McpCall, type TurnCall } from './context';
import { toolError } from './errors';

export type ToolSpec<I, O> = {
  name: string;
  description: string;
  input: ZodType<I>;
  output: ZodType<O>;
  annotations: ToolAnnotations;
  run(call: McpCall, input: I): Promise<O>;
  /** The text rendering sent beside `structuredContent`, for clients that read only text. */
  text(output: O): string;
};

/** A tool of the turn surface: it runs as the turn's bot, under its lease. */
export type TurnToolSpec<I, O> = Omit<ToolSpec<I, O>, 'run'> & {
  /** Callable once the turn has resolved, while the lease still runs (set_notes after a move). */
  allowResolved?: boolean;
  run(call: TurnCall, input: I): Promise<O>;
};

/**
 * One of the owner's live bots, by name or id, with its activity recorded (spec: every tool call
 * naming a bot touches it). Runs in a transaction of its own, so a refusal later in the call doesn't
 * roll the touch back.
 */
export function resolveAndTouch(call: McpCall, ref: string | number): Promise<UserRow> {
  return call.deps.db.transaction(async (tx) => {
    const bot = await resolveOwnBot(tx, call.owner.id, ref);
    await touchBotActivity(tx, bot.id);
    return bot;
  });
}

/** The request's `signal` and `progress`, as both surfaces' calls carry them. */
function callHooks(ctx: ServerContext): Pick<McpCall, 'signal' | 'progress'> {
  const progressToken = ctx.mcpReq._meta?.progressToken;
  let progress = 0;
  return {
    signal: ctx.mcpReq.signal,
    progress: async (message) => {
      if (progressToken === undefined) return;
      progress += 1;
      await ctx.mcpReq.notify({
        method: 'notifications/progress',
        params: { progressToken, progress, message },
      });
    },
  };
}

function mcpCallFor(ctx: ServerContext): McpCall {
  const { deps, owner } = scopeFromAuthInfo(ctx.http?.authInfo, 'owner');
  return { deps, owner, ...callHooks(ctx) };
}

function turnCallFor(ctx: ServerContext): TurnCall {
  const { deps, bot, lease } = scopeFromAuthInfo(ctx.http?.authInfo, 'turn');
  return { deps, bot, lease, ...callHooks(ctx) };
}

/** A tool's output as its result: `structuredContent` and the text rendering. */
function toolResult<O>(spec: { text(output: O): string }, output: O) {
  return {
    content: [{ type: 'text' as const, text: spec.text(output) }],
    structuredContent: output as Record<string, unknown>,
  };
}

/**
 * Registers one tool: its schemas and annotations, `structuredContent` plus a text rendering, and
 * a thrown error turned into a tool error result. Every tool module goes through here.
 */
export function registerTool<I, O>(server: McpServer, spec: ToolSpec<I, O>): void {
  server.registerTool(
    spec.name,
    {
      description: spec.description,
      inputSchema: spec.input,
      outputSchema: spec.output,
      annotations: spec.annotations,
    },
    async (input: unknown, ctx: ServerContext) => {
      const call = mcpCallFor(ctx);
      const { log } = call.deps;
      try {
        return toolResult(spec, await spec.run(call, input as I));
      } catch (error) {
        if (isDomainError(error)) {
          // Code and ids only; a DomainError's details may carry display names.
          log.info(
            { tool: spec.name, ownerId: call.owner.id, code: error.code },
            'mcp tool refused',
          );
        } else {
          log.error({ err: error, tool: spec.name, ownerId: call.owner.id }, 'mcp tool failed');
        }
        return toolError(error, { ownerId: call.owner.id, tool: spec.name });
      }
    },
  );
}

/**
 * Registers one turn tool, as `registerTool` does, but each call first checks the lease is still
 * this token's claim and live (resolved too, with `allowResolved`), then spends one of its calls.
 * Those run in a transaction of their own, so a refusal inside `run` still counts the call.
 */
export function registerTurnTool<I, O>(server: McpServer, spec: TurnToolSpec<I, O>): void {
  server.registerTool(
    spec.name,
    {
      description: spec.description,
      inputSchema: spec.input,
      outputSchema: spec.output,
      annotations: spec.annotations,
    },
    async (input: unknown, ctx: ServerContext) => {
      const call = turnCallFor(ctx);
      const { bot, lease } = call;
      const { log } = call.deps;
      try {
        await call.deps.db.transaction(async (tx) => {
          await requireLiveLease(tx, lease.id, new Date(), {
            claimSeq: lease.claimSeq,
            allowResolved: spec.allowResolved ?? false,
          });
          await spendCall(tx, lease.id, lease.claimSeq);
        });
        return toolResult(spec, await spec.run(call, input as I));
      } catch (error) {
        // Ids only: never the bot's name, notes or the token.
        const ids = { tool: spec.name, botId: bot.id, leaseId: lease.id };
        if (isDomainError(error)) {
          log.info({ ...ids, code: error.code }, 'mcp turn tool refused');
        } else {
          log.error({ err: error, ...ids }, 'mcp turn tool failed');
        }
        // The routes admit only a bot, which always has an owner.
        return toolError(error, { ownerId: bot.ownerId!, botId: bot.id, tool: spec.name });
      }
    },
  );
}
