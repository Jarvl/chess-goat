import { eq } from 'drizzle-orm';
import { GrammyError } from 'grammy';
import { z } from 'zod';
import type { Config } from '../../config';
import { users } from '../../db/schema';
import { getPhotoRow, storePhoto, touchPhoto } from '../../domain/photos';
import { getUserById } from '../../domain/users';
import type { JobHandler, JobHandlers } from '../types';
import type { TelegramHandlerContext } from './telegramCall';
import { can } from '../../domain/playerKind';

const payloadSchema = z.object({ userId: z.number().int() });

/** Telegram's 160×160 JPEG is far smaller; anything this big is not one. */
export const MAX_PHOTO_BYTES = 65_536;
const JPEG_MAGIC = Buffer.from([0xff, 0xd8, 0xff]);

/** The Bot API file endpoint. Its URL holds the bot token, so errors name the status only. */
export async function downloadTelegramFile(
  config: Pick<Config, 'BOT_TOKEN' | 'TELEGRAM_API_ROOT'>,
  filePath: string,
): Promise<Buffer> {
  const root = config.TELEGRAM_API_ROOT ?? 'https://api.telegram.org';
  const response = await fetch(`${root}/file/bot${config.BOT_TOKEN}/${filePath}`);
  if (!response.ok) throw new Error(`photo download failed: HTTP ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

function checkJpeg(bytes: Buffer): void {
  if (bytes.length >= MAX_PHOTO_BYTES)
    throw new Error(`photo download rejected: ${bytes.length} bytes`);
  if (!bytes.subarray(0, 3).equals(JPEG_MAGIC))
    throw new Error('photo download rejected: not a JPEG');
}

/** Writes `photo` unless the user was deleted meanwhile, so Delete my data always wins. */
async function write(
  ctx: TelegramHandlerContext,
  userId: number,
  photo: { fileUniqueId: string; bytes: Buffer } | null,
): Promise<void> {
  await ctx.deps.db.transaction(async (tx) => {
    const [user] = await tx
      .select({ deletedAt: users.deletedAt })
      .from(users)
      .where(eq(users.id, userId))
      .for('update');
    if (!user || user.deletedAt) return;
    await storePhoto(tx, userId, photo);
  });
}

/** Fetches the user's smallest Telegram profile photo and stores it, skipping the download when it is unchanged. */
const fetchUserPhoto =
  (ctx: TelegramHandlerContext): JobHandler =>
  async ({ job }) => {
    const { userId } = payloadSchema.parse(job.payload);
    const user = await getUserById(ctx.deps.db, userId);
    if (!user || user.deletedAt || !can(user, 'showPhoto') || user.telegramUserId === null)
      return { outcome: 'done' };
    let smallest;
    try {
      const result = await ctx.api.getUserProfilePhotos(user.telegramUserId, { limit: 1 });
      smallest = result.photos[0]?.[0];
    } catch (error) {
      if (!(error instanceof GrammyError)) throw error;
      if (error.error_code === 429)
        return {
          outcome: 'retry',
          delayMs: (error.parameters.retry_after ?? 5) * 1000,
          error: 'telegram 429',
        };
      if (error.error_code !== 400) throw error;
      smallest = undefined;
    }
    if (!smallest) {
      await write(ctx, userId, null);
      return { outcome: 'done' };
    }
    const stored = await getPhotoRow(ctx.deps.db, userId);
    if (stored?.fileUniqueId === smallest.file_unique_id) {
      await touchPhoto(ctx.deps.db, userId);
      return { outcome: 'done' };
    }
    const file = await ctx.api.getFile(smallest.file_id);
    if (!file.file_path) throw new Error('photo has no file path');
    const bytes = await downloadTelegramFile(ctx.config, file.file_path);
    checkJpeg(bytes);
    await write(ctx, userId, { fileUniqueId: smallest.file_unique_id, bytes });
    return { outcome: 'done' };
  };

export function userPhotoJobHandlers(ctx: TelegramHandlerContext): JobHandlers {
  return { fetch_user_photo: fetchUserPhoto(ctx) };
}
