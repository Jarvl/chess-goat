// Shared by the server client, the MCP client and the lean preset. Nothing here ever returns a
// request, header or body: only fixed phrases or bounded, cleaned text.

export function isAbort(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

export function abortError(): Error {
  const e = new Error('aborted');
  e.name = 'AbortError';
  return e;
}

/** The first allow-listed `code` in an error's cause chain, as a fixed string; never the cause. */
export function networkDetail(error: unknown): string {
  if (error instanceof Error && error.name === 'TimeoutError') return 'timed out';
  let node: unknown = error;
  for (let depth = 0; depth < 4 && node && typeof node === 'object'; depth++) {
    const code = (node as { code?: unknown }).code;
    if (typeof code === 'string') {
      if (code === 'ECONNREFUSED') return 'connection refused';
      if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return 'host not found';
      if (code === 'ECONNRESET') return 'connection reset';
      if (
        code.startsWith('CERT_') ||
        code === 'DEPTH_ZERO_SELF_SIGNED_CERT' ||
        code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE'
      ) {
        return 'certificate not trusted';
      }
    }
    node = (node as { cause?: unknown }).cause;
  }
  return 'connection failed';
}

/** The body as text, or null when it is longer than `limit` bytes (the rest is cancelled). */
export async function readLimited(res: Response, limit: number): Promise<string | null> {
  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** Text made safe to show: no control characters, runs of spaces folded, bounded. */
export function cleanText(text: string, max: number): string {
  const out = Array.from(text, (ch) => (ch < ' ' || ch === '\u007f' ? ' ' : ch))
    .join('')
    .replace(/ {2,}/g, ' ')
    .trim();
  return out.length > max ? out.slice(0, max).trim() : out;
}
