import { createInterface } from 'node:readline';
import { GrammyError } from 'grammy';
import { loadConfig } from '../config';
import { createDb } from '../db/client';
import { refundTip, type RefundableTip } from '../domain/tipRefunds';
import { createTelegramApi } from '../telegram/client';

/**
 * Refunds a Stars tip. Run it inside the app container, from apps/server:
 *
 *   pnpm run refund-tip <transaction id>
 *
 * The transaction id is the one on the payer's Telegram receipt. It shows the tip and asks for a
 * y/N confirmation before anything reaches Telegram. The bot token and the database come from the
 * container's own environment, so the token is never typed, pasted or kept in a shell history.
 */

/** One line of input; an empty answer when input ends (a closed or piped stdin) reads as "no". */
function ask(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    let answered = false;
    rl.on('close', () => {
      if (!answered) resolve('');
    });
    rl.question(question, (answer) => {
      answered = true;
      rl.close();
      resolve(answer);
    });
  });
}

async function confirmRefund({ tip, payer }: RefundableTip): Promise<boolean> {
  const who = payer
    ? `${payer.firstName}${payer.username ? ` (@${payer.username})` : ''}, Telegram id ${tip.telegramUserId}`
    : `Telegram id ${tip.telegramUserId}`;
  console.log(`Transaction  ${tip.telegramPaymentChargeId}`);
  console.log(`Amount       ★${tip.stars}`);
  console.log(`Paid at      ${tip.paidAt.toISOString()}`);
  console.log(`Payer        ${who}`);
  console.log(`Tip          #${tip.id}`);
  const answer = await ask(`Refund ★${tip.stars} to this payer? This cannot be undone. [y/N] `);
  return /^(y|yes)$/i.test(answer.trim());
}

const transactionId = process.argv[2]?.trim();
if (!transactionId) {
  console.error('usage: pnpm run refund-tip <transaction id>');
  process.exit(2);
}

const config = loadConfig();
const { db, close } = createDb(config.DATABASE_URL, { max: 1 });
const api = createTelegramApi(config, { apiRoot: config.TELEGRAM_API_ROOT, throttle: false });
try {
  const result = await refundTip(db, api, transactionId, confirmRefund);
  if (result.outcome === 'not_found') {
    console.error(
      'No tip has that transaction id. Copy it again from the receipt, or list recent ones with getStarTransactions.',
    );
    process.exitCode = 1;
  } else if (result.outcome === 'already_refunded') {
    console.log(`Already refunded at ${result.tip.refundedAt!.toISOString()}; nothing to do.`);
  } else if (result.outcome === 'cancelled') {
    console.log('Cancelled; nothing was refunded.');
  } else {
    console.log(`Refunded ★${result.tip.stars}. The bot sets refunded_at when Telegram confirms.`);
  }
} catch (error) {
  // GrammyError carries Telegram's own reason; neither message includes the bot token.
  const reason = error instanceof GrammyError ? error.description : String(error);
  console.error(`The refund failed: ${reason}`);
  process.exitCode = 1;
} finally {
  await close();
}
