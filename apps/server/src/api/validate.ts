import { zValidator } from '@hono/zod-validator';
import type { ZodType } from 'zod';
import { DomainError } from '../domain/errors';

/** Shared-schema validation; failures become the API's `validation` error body. */
export function validate<T extends ZodType>(target: 'json' | 'query' | 'param', schema: T) {
  return zValidator(target, schema, (result) => {
    if (!result.success) {
      throw new DomainError('validation', 'invalid request', {
        issues: result.error.issues.map((issue) => issue.path.join('.')),
      });
    }
  });
}
