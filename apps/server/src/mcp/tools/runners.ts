import { PresetSchema } from '@chess-goat/shared';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import { listBots, resolveOwnBot } from '../../domain/bots';
import {
  createLinkCode,
  listRunners,
  onlineBotIds,
  PRESETS,
  revokeRunner,
} from '../../domain/runners';
import { registerTool } from '../tool';
import { botRef, READ_ONLY } from './manage';

const linkOutput = z.object({
  alreadyServed: z.boolean(),
  /** With `alreadyServed`: whether it was every bot of the owner or the ones named. */
  served: z.enum(['all', 'named']).optional(),
  command: z.string().optional(),
  code: z.string().optional(),
  expiresAt: z.string().optional(),
});

function registerLinkRunner(server: McpServer): void {
  registerTool(server, {
    name: 'link_runner',
    description: `Connects a runner: the program on your owner's machine that plays their bots by starting a short session for each turn. Returns a one-time command to run there. Pass \`preset\` for the harness you are running in, if it is one of: ${PRESETS.join(', ')}; without it the runner picks an installed harness. Pass \`bots\` to make this runner serve only some bots. Not destructive; safe to call again.`,
    input: z.object({
      label: z
        .string()
        .max(64)
        .optional()
        .describe('A name for the machine, e.g. "Living-room PC".'),
      bots: z.array(botRef).min(1).max(20).optional().describe('Serve only these bots.'),
      preset: PresetSchema.optional(),
    }),
    output: linkOutput,
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    run: async ({ deps, owner, publicUrl }, input) => {
      const now = new Date();
      return deps.db.transaction(async (tx) => {
        const named = input.bots
          ? await Promise.all(input.bots.map((ref) => resolveOwnBot(tx, owner.id, ref)))
          : await listBots(tx, owner.id);
        const ids = [...new Set(named.map((bot) => bot.id))];
        if (ids.length > 0) {
          const online = await onlineBotIds(tx, ids, now);
          if (ids.every((id) => online.has(id)))
            return {
              alreadyServed: true,
              served: input.bots ? ('named' as const) : ('all' as const),
            };
        }
        const { code, expiresAt } = await createLinkCode(
          tx,
          owner.id,
          { label: input.label, botIds: input.bots ? ids : undefined, preset: input.preset },
          now,
        );
        const server = publicUrl.replace(/\/+$/, '');
        const preset = input.preset ? ` --preset ${input.preset}` : '';
        return {
          alreadyServed: false,
          code,
          command: `npx goat-runner link ${code} --server ${server}${preset}`,
          expiresAt: expiresAt.toISOString(),
        };
      });
    },
    text: (out) =>
      out.alreadyServed
        ? `A connected runner already serves ${out.served === 'all' ? 'all your bots' : 'these bots'}. Nothing to do. Call list_runners to see it.`
        : `Run this command on the machine that will play your bots:\n\n${out.command}\n\nRun it yourself if you have a shell; otherwise give it to your owner. It links the runner, starts it in the background and registers it to start at login (\`goat-runner autostart off\` undoes that). The code works once and expires at ${out.expiresAt}. Then call list_runners to check it connected.`,
  });
}

const runnerSchema = z.object({
  id: z.number().int(),
  label: z.string(),
  harness: z.string().nullable(),
  bots: z.union([z.literal('all'), z.array(z.string())]),
  connected: z.boolean(),
  lastSeenAt: z.string().nullable(),
});

function registerListRunners(server: McpServer): void {
  registerTool(server, {
    name: 'list_runners',
    description:
      'List your runners: the programs that play your bots, with the harness each uses, which bots it serves, and whether it is connected now.',
    input: z.object({}),
    output: z.object({ runners: z.array(runnerSchema) }),
    annotations: READ_ONLY,
    run: async ({ deps, owner }) => ({
      runners: (await deps.db.transaction((tx) => listRunners(tx, owner.id, new Date()))).map(
        (r) => ({ ...r, lastSeenAt: r.lastSeenAt?.toISOString() ?? null }),
      ),
    }),
    text: ({ runners }) =>
      runners.length === 0
        ? 'No runners yet. Call link_runner.'
        : runners
            .map((r) => {
              const head = `#${r.id} "${r.label}"${r.harness ? ` (${r.harness})` : ''}`;
              const serves = r.bots === 'all' ? 'all bots' : r.bots.join(', ');
              const state = r.connected
                ? 'connected'
                : r.lastSeenAt
                  ? `last seen ${r.lastSeenAt}`
                  : 'never connected';
              return r.lastSeenAt || r.connected
                ? `${head}: ${state}, serves ${serves}`
                : `${head}: ${state}`;
            })
            .join('\n'),
  });
}

function registerRevokeRunner(server: McpServer): void {
  registerTool(server, {
    name: 'revoke_runner',
    description:
      'Disconnects and forgets a runner (an id from list_runners). Its bots stop playing until another runner serves them.',
    input: z.object({ runner: z.number().int().describe('The runner id, from list_runners.') }),
    output: z.object({ revoked: z.literal(true) }),
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    run: async ({ deps, owner }, input) => {
      await deps.db.transaction((tx) => revokeRunner(tx, owner.id, input.runner));
      return { revoked: true as const };
    },
    text: () => 'Runner revoked. Its bots stop playing until another runner serves them.',
  });
}

export const registerRunnerTools = (server: McpServer): void => {
  registerLinkRunner(server);
  registerListRunners(server);
  registerRevokeRunner(server);
};
