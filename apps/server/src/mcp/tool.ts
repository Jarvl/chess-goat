import type { McpServer, ServerContext, ToolAnnotations } from '@modelcontextprotocol/server';
import type { ZodType } from 'zod';
import { isDomainError } from '../domain/errors';
import { scopeFromAuthInfo, type McpCall } from './context';
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

function mcpCallFor(ctx: ServerContext): McpCall {
  const { deps, owner } = scopeFromAuthInfo(ctx.http?.authInfo);
  const progressToken = ctx.mcpReq._meta?.progressToken;
  let progress = 0;
  return {
    deps,
    owner,
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
        const output = await spec.run(call, input as I);
        return {
          content: [{ type: 'text' as const, text: spec.text(output) }],
          structuredContent: output as Record<string, unknown>,
        };
      } catch (error) {
        if (isDomainError(error)) {
          // Spec §12: code and ids only; a DomainError's details may carry display names.
          log.info(
            { tool: spec.name, ownerId: call.owner.id, code: error.code },
            'mcp tool refused',
          );
        } else {
          log.error({ err: error, tool: spec.name, ownerId: call.owner.id }, 'mcp tool failed');
        }
        return toolError(error);
      }
    },
  );
}
