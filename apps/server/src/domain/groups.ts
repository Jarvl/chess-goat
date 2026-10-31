import {
  GROUP_SETTINGS_DEFAULTS,
  GroupSettingsSchema,
  type GroupSettings,
} from '@chess-goat/shared';
import { eq, sql } from 'drizzle-orm';
import type { DbOrTx } from '../db/client';
import { generatePublicId } from '../db/ids';
import { groups, type GroupRow } from '../db/schema';
import { DomainError } from './errors';

export type TelegramChatInfo = {
  telegramChatId: number;
  title: string;
  type: 'group' | 'supergroup';
  isForum?: boolean;
};

export async function ensureGroup(tx: DbOrTx, info: TelegramChatInfo): Promise<GroupRow> {
  const fields = { title: info.title, type: info.type, isForum: info.isForum ?? false };
  const [row] = await tx
    .insert(groups)
    .values({ publicId: generatePublicId(), telegramChatId: info.telegramChatId, ...fields })
    .onConflictDoUpdate({
      target: groups.telegramChatId,
      set: { ...fields, updatedAt: sql`now()` },
    })
    .returning();
  if (!row) throw new Error('ensureGroup returned no row');
  return row;
}

export async function getGroupByPublicId(tx: DbOrTx, publicId: string): Promise<GroupRow | null> {
  const [row] = await tx.select().from(groups).where(eq(groups.publicId, publicId)).limit(1);
  return row ?? null;
}

export async function requireGroupByPublicId(tx: DbOrTx, publicId: string): Promise<GroupRow> {
  const row = await getGroupByPublicId(tx, publicId);
  if (!row) throw new DomainError('not_found', 'group not found');
  return row;
}

export async function getGroupByChatId(
  tx: DbOrTx,
  telegramChatId: number,
): Promise<GroupRow | null> {
  const [row] = await tx
    .select()
    .from(groups)
    .where(eq(groups.telegramChatId, telegramChatId))
    .limit(1);
  return row ?? null;
}

export function settingsOf(group: Pick<GroupRow, 'settings'>): GroupSettings {
  return { ...GROUP_SETTINGS_DEFAULTS, ...group.settings };
}

/** Merges a partial update and validates the whole result, so a bad field can never be stored. */
export async function updateGroupSettings(
  tx: DbOrTx,
  groupId: number,
  patch: Partial<GroupSettings>,
): Promise<GroupSettings> {
  const [current] = await tx.select().from(groups).where(eq(groups.id, groupId)).limit(1);
  if (!current) throw new DomainError('not_found', 'group not found');
  const parsed = GroupSettingsSchema.safeParse({ ...settingsOf(current), ...patch });
  if (!parsed.success) {
    throw new DomainError('validation', 'invalid group settings', {
      issues: parsed.error.issues.map((issue) => issue.path.join('.')),
    });
  }
  await tx
    .update(groups)
    .set({ settings: parsed.data, updatedAt: sql`now()` })
    .where(eq(groups.id, groupId));
  return parsed.data;
}

export async function setBotMembership(
  tx: DbOrTx,
  groupId: number,
  state: { botStatus: GroupRow['botStatus']; botIsAdmin: boolean; botCanPin: boolean },
): Promise<void> {
  await tx
    .update(groups)
    .set({ ...state, updatedAt: sql`now()` })
    .where(eq(groups.id, groupId));
}

/** `migrate_to_chat_id`: the Telegram id changes, the internal id and every game stay (spec §5.8). */
export async function migrateChatId(
  tx: DbOrTx,
  oldChatId: number,
  newChatId: number,
): Promise<void> {
  await tx
    .update(groups)
    .set({ telegramChatId: newChatId, type: 'supergroup', updatedAt: sql`now()` })
    .where(eq(groups.telegramChatId, oldChatId));
}
export async function getGroupById(tx: DbOrTx, id: number): Promise<GroupRow | null> {
  const [row] = await tx.select().from(groups).where(eq(groups.id, id)).limit(1);
  return row ?? null;
}

export async function requireGroup(tx: DbOrTx, id: number): Promise<GroupRow> {
  const row = await getGroupById(tx, id);
  if (!row) throw new DomainError('not_found', 'group not found', { groupId: id });
  return row;
}
