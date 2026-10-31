import type { ErrorCode } from '@chess-goat/shared';

/** A business-rule failure; the HTTP and bot layers map `code` to a status or a one-line reply. */
export class DomainError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    /**
     * Machine-readable context for the caller (`reason`, ids, limits). It may carry display names
     * for one-line replies, so it is never written to logs (spec §12): log `code` and ids only.
     */
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'DomainError';
  }
}

export function isDomainError(error: unknown): error is DomainError {
  return error instanceof DomainError;
}
