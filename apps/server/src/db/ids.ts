import { randomInt } from 'node:crypto';

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

/** Ten base62 characters from the CSPRNG: ~59 bits, unguessable and unique-indexed. */
export function generatePublicId(): string {
  let out = '';
  for (let i = 0; i < 10; i += 1) out += ALPHABET[randomInt(ALPHABET.length)];
  return out;
}
