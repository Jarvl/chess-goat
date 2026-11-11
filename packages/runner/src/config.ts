import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { PresetSchema } from '@chess-goat/shared';
import { isLoopbackHost } from './http.js';

const FILE = 'config.json';

// http(s) only, no userinfo, query or fragment (a path prefix is fine). Messages never echo the value.
function httpUrl(what: string, s: string, ctx: z.RefinementCtx): void {
  let url: URL;
  try {
    url = new URL(s);
  } catch {
    ctx.addIssue({ code: 'custom', message: `the ${what} must be an http(s) URL` });
    return;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    ctx.addIssue({ code: 'custom', message: `the ${what} must be an http(s) URL` });
  } else if (url.username || url.password || url.search || url.hash || /[?#]/.test(s)) {
    ctx.addIssue({
      code: 'custom',
      message: `the ${what} must not contain credentials, a query or a fragment`,
    });
  }
}

const Server = z
  .string()
  .superRefine((s, ctx) => {
    httpUrl('server URL', s, ctx);
    // Turns carry an MCP address on this origin, and the loop refuses plain http beyond loopback.
    try {
      const url = new URL(s);
      if (url.protocol === 'http:' && !isLoopbackHost(url.hostname)) {
        ctx.addIssue({ code: 'custom', message: 'the server address must use https' });
      }
    } catch {
      // httpUrl reported it
    }
  })
  .transform((s) => s.replace(/\/+$/, ''));

export const ConfigSchema = z
  .object({
    server: Server,
    credential: z.string().min(1),
    runnerId: z.number().int().positive(),
    preset: PresetSchema,
    custom: z.object({ command: z.string().min(1), args: z.array(z.string()) }).optional(),
    lean: z
      .object({
        baseUrl: z.string().superRefine((s, ctx) => httpUrl('base URL', s, ctx)),
        model: z.string().min(1),
        apiKeyEnv: z.string().min(1).optional(),
      })
      .optional(),
    concurrency: z.number().int().min(1).max(8).default(2),
    leaseSeconds: z.number().int().min(30).max(900).default(300),
  })
  .superRefine((c, ctx) => {
    for (const section of ['custom', 'lean'] as const) {
      if (c.preset === section && !c[section]) {
        ctx.addIssue({
          code: 'custom',
          path: [section],
          message: `preset "${section}" needs a "${section}" section`,
        });
      }
    }
  });

export type RunnerConfig = z.output<typeof ConfigSchema>;

const fileIn = (dir: string) => path.join(dir, FILE);

const invalid = (file: string, reason: string) =>
  new Error(`goat-runner's config at ${file} is not valid: ${reason}. Remove it and link again.`);

// Paths and messages only; never the offending values, which may be the credential.
const describe = (error: z.ZodError) =>
  error.issues.map((i) => `${i.path.join('.') || 'config'}: ${i.message}`).join('; ');

export function readConfig(dir: string): RunnerConfig | null {
  const file = fileIn(dir);
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw invalid(file, `cannot be read (${(e as NodeJS.ErrnoException).code ?? 'error'})`);
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    // Not the parser's message: it can quote the file.
    throw invalid(file, 'it is not JSON');
  }
  const parsed = ConfigSchema.safeParse(json);
  if (!parsed.success) {
    throw invalid(file, describe(parsed.error));
  }
  return parsed.data;
}

export function writeConfig(dir: string, config: RunnerConfig): void {
  const file = fileIn(dir);
  const parsed = ConfigSchema.safeParse(config);
  if (!parsed.success) throw invalid(file, describe(parsed.error));
  const posix = process.platform !== 'win32';
  fs.mkdirSync(dir, posix ? { recursive: true, mode: 0o700 } : { recursive: true });
  if (posix) fs.chmodSync(dir, 0o700); // mkdir leaves an existing folder as it was
  const tmp = `${file}.tmp-${process.pid}`;
  try {
    writeExclusive(tmp, `${JSON.stringify(parsed.data, null, 2)}\n`, posix);
    fs.renameSync(tmp, file);
  } catch (e) {
    fs.rmSync(tmp, { force: true });
    throw e;
  }
}

// Created exclusively with the mode set, so the secret never lands in a file (or through a
// symlink) someone else made, nor is it briefly world-readable. A stale one is removed and retried.
function writeExclusive(tmp: string, text: string, posix: boolean): void {
  let fd: number;
  try {
    fd = fs.openSync(tmp, 'wx', posix ? 0o600 : undefined);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    fs.rmSync(tmp, { force: true });
    fd = fs.openSync(tmp, 'wx', posix ? 0o600 : undefined);
  }
  try {
    fs.writeFileSync(fd, text);
    if (posix) fs.fchmodSync(fd, 0o600); // in case of a umask surprise
  } finally {
    fs.closeSync(fd);
  }
}

export function removeConfig(dir: string): void {
  fs.rmSync(fileIn(dir), { force: true });
}
