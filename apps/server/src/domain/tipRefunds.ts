import { eq } from 'drizzle-orm';
import type { Api } from 'grammy';
import type { DbOrTx } from '../db/client';
import { tips, users, type TipRow } from '../db/schema';

/** What the operator is shown before a refund: the tip, and who paid it if their row still exists. */
export type RefundableTip = {
  tip: TipRow;
  payer: { firstName: string; username: string | null } | null;
};

export type TipRefund =
  | { outcome: 'refunded'; tip: TipRow }
  | { outcome: 'cancelled'; tip: TipRow }
  | { outcome: 'already_refunded'; tip: TipRow }
  | { outcome: 'not_found' };

/**
 * Refunds one tip by its transaction id, the payment's charge id that the payer
 * sees on their receipt. Nothing reaches Telegram until `confirm` has seen the tip and said yes.
 * `refunded_at` is left to the bot's `refunded_payment` handler, which runs when Telegram confirms
 * the refund. A Telegram refusal is thrown as grammY's `GrammyError`.
 */
export async function refundTip(
  db: DbOrTx,
  api: Api,
  transactionId: string,
  confirm: (candidate: RefundableTip) => Promise<boolean>,
): Promise<TipRefund> {
  const [row] = await db
    .select({ tip: tips, firstName: users.firstName, username: users.username })
    .from(tips)
    .leftJoin(users, eq(users.id, tips.userId))
    .where(eq(tips.telegramPaymentChargeId, transactionId))
    .limit(1);
  if (!row) return { outcome: 'not_found' };
  const { tip } = row;
  if (tip.refundedAt) return { outcome: 'already_refunded', tip };
  const payer =
    row.firstName === null ? null : { firstName: row.firstName, username: row.username };
  if (!(await confirm({ tip, payer }))) return { outcome: 'cancelled', tip };
  await api.refundStarPayment(tip.telegramUserId, transactionId);
  return { outcome: 'refunded', tip };
}
