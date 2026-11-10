import { eq } from 'drizzle-orm';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import { turnLeases } from '../../../db/schema';
import { registerTurnTool } from '../../tool';

function registerHello(server: McpServer): void {
  registerTurnTool(server, {
    name: 'hello',
    description: 'Says hello to Chess Goat. This is a test turn: call it once, then stop.',
    input: z.object({}),
    output: z.object({ ok: z.literal(true) }),
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    run: async ({ deps, lease }) => {
      // No claimSeq condition: the wrapper's requireLiveLease checked this claim, and a practice
      // row's lease is never issued again (one attempt).
      await deps.db
        .update(turnLeases)
        .set({ helloAt: new Date() })
        .where(eq(turnLeases.id, lease.id));
      return { ok: true as const };
    },
    text: () => 'Hello received. The test passed; stop.',
  });
}

export const registerPracticeTurnTools = (server: McpServer): void => {
  registerHello(server);
};
