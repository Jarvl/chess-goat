import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/postgres-js';
import { readMigrationFiles } from 'drizzle-orm/migrator';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';

const DEFAULT_FOLDER = fileURLToPath(new URL('../../drizzle', import.meta.url));
const MIGRATION_LOCK = 72_648_101;

export type MigrationOptions = {
  migrationsFolder?: string;
  /**
   * Staging only (`DATABASE_RESET_ON_MISMATCH`): wipe the database first when its applied
   * migrations are not a prefix of this build's. Never set in production.
   */
  resetOnMismatch?: boolean;
};

/**
 * Applies pending migrations under a session advisory lock so concurrent replicas serialise
 *. A dedicated single connection keeps the lock and the migrator in one session.
 *
 * Drizzle's migrator only compares timestamps with the newest applied migration, so on a database
 * that another branch has migrated it skips older migrations and stacks newer ones on a schema no
 * branch has. `resetOnMismatch` is for the one database that sees many branches: staging.
 */
export async function runMigrations(
  databaseUrl: string,
  { migrationsFolder = DEFAULT_FOLDER, resetOnMismatch = false }: MigrationOptions = {},
): Promise<{ reset: boolean }> {
  const client = postgres(databaseUrl, { max: 1, onnotice: () => undefined });
  const db = drizzle(client, { casing: 'snake_case' });
  try {
    await client`select pg_advisory_lock(${MIGRATION_LOCK})`;
    try {
      const reset = resetOnMismatch && !(await matchesBuild(client, migrationsFolder));
      if (reset) {
        await client.begin(async (tx) => {
          await tx`drop schema if exists drizzle cascade`;
          await tx`drop schema public cascade`;
          await tx`create schema public`;
        });
      }
      await migrate(db, { migrationsFolder });
      return { reset };
    } finally {
      await client`select pg_advisory_unlock(${MIGRATION_LOCK})`;
    }
  } finally {
    await client.end({ timeout: 5 });
  }
}

/** Whether every applied migration is this build's migration at the same position, by hash. */
async function matchesBuild(client: postgres.Sql, migrationsFolder: string): Promise<boolean> {
  const [table] = await client<{ exists: boolean }[]>`
    select to_regclass('drizzle.__drizzle_migrations') is not null as exists`;
  if (!table?.exists) return true;
  const applied = await client<{ hash: string }[]>`
    select hash from drizzle.__drizzle_migrations order by id`;
  const local = readMigrationFiles({ migrationsFolder });
  return applied.length <= local.length && applied.every((row, i) => row.hash === local[i]?.hash);
}
