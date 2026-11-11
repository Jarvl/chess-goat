import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { PresetSchema } from '@chess-goat/shared';

const FILE = 'config.json';

const Server = z
  .string()
  .refine((s) => {
    try {
      return ['http:', 'https:'].includes(new URL(s).protocol);
    } catch {
      return false;
    }
  }, 'must be an http(s) URL')
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
        baseUrl: z.string().min(1),
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

export function readConfig(dir: string): RunnerConfig | null {
  const file = fileIn(dir);
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
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
    // Paths and messages only; never the offending values, which may be the credential.
    const reason = parsed.error.issues
      .map((i) => `${i.path.join('.') || 'config'}: ${i.message}`)
      .join('; ');
    throw invalid(file, reason);
  }
  return parsed.data;
}

export function writeConfig(dir: string, config: RunnerConfig): void {
  const posix = process.platform !== 'win32';
  const data = ConfigSchema.parse(config);
  fs.mkdirSync(dir, posix ? { recursive: true, mode: 0o700 } : { recursive: true });
  const file = fileIn(dir);
  const tmp = `${file}.tmp-${process.pid}`;
  try {
    // Mode at creation so the secret is never briefly world-readable; chmod covers a umask.
    fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, posix ? { mode: 0o600 } : {});
    if (posix) fs.chmodSync(tmp, 0o600);
    fs.renameSync(tmp, file);
  } catch (e) {
    fs.rmSync(tmp, { force: true });
    throw e;
  }
}

export function removeConfig(dir: string): void {
  fs.rmSync(fileIn(dir), { force: true });
}
