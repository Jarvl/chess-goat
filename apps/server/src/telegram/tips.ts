import { t, TIP_MAX_STARS, TIP_MIN_STARS } from '@chess-goat/shared';
import type { Api } from 'grammy';

/** The invoice payload names the amount, so pre-checkout can check it. */
const PAYLOAD = /^tip:v1:([1-9]\d{0,4})$/;

// grammY's Node build types `signal` against the `abort-controller` shim rather than the
// platform's own AbortSignal; the two are structurally different but behave identically, so a
// timeout signal from the global constructor needs a cast to that exact parameter type.
type InvoiceLinkSignal = Parameters<Api['createInvoiceLink']>[7];

/** A hung `createInvoiceLink` must still answer 500 `internal`, not hang the card. */
export const TIP_INVOICE_TIMEOUT_MS = 10_000;

export function tipPayload(stars: number): string {
  return `tip:v1:${stars}`;
}

export function parseTipPayload(payload: string): number | null {
  const match = PAYLOAD.exec(payload);
  if (!match) return null;
  const stars = Number(match[1]);
  return stars >= TIP_MIN_STARS && stars <= TIP_MAX_STARS ? stars : null;
}

/** Approve only a well-formed payload whose amount and currency match. */
export function tipCheckoutAccepted(query: {
  invoice_payload: string;
  total_amount: number;
  currency: string;
}): boolean {
  const stars = parseTipPayload(query.invoice_payload);
  return stars !== null && stars === query.total_amount && query.currency === 'XTR';
}

/** A fresh link per tap; an empty provider token means Telegram Stars. */
export function createTipInvoiceLink(
  api: Api,
  stars: number,
  timeoutMs: number = TIP_INVOICE_TIMEOUT_MS,
): Promise<string> {
  return api.createInvoiceLink(
    t('invoice.tip.title'),
    t('invoice.tip.description'),
    tipPayload(stars),
    '',
    'XTR',
    [{ label: t('invoice.tip.label'), amount: stars }],
    undefined,
    AbortSignal.timeout(timeoutMs) as InvoiceLinkSignal,
  );
}
