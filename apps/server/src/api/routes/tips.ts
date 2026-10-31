import { TipRequestSchema, type TipInvoiceDto } from '@chess-goat/shared';
import type { Hono } from 'hono';
import { DomainError } from '../../domain/errors';
import { createTipInvoiceLink } from '../../telegram/tips';
import type { ApiContext, ApiEnv } from '../context';
import { validate } from '../validate';

/**
 * Tip jar spec §2.1: one Stars invoice link per tap. A Bot API failure is left to the app's error
 * handler, which logs it and answers `internal`.
 */
export function tipRoutes(api: Hono<ApiEnv>, ctx: ApiContext): void {
  api.post('/tips', validate('json', TipRequestSchema), async (c) => {
    const user = c.get('user');
    if (!ctx.tipLimiter.allow(`tip:${user.id}`))
      throw new DomainError('rate_limited', 'too many tip invoices');
    const { stars } = c.req.valid('json');
    const body: TipInvoiceDto = { url: await createTipInvoiceLink(ctx.api, stars) };
    return c.json(body);
  });
}
