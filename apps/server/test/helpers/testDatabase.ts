import postgres from 'postgres';
import { REPO_ROOT, testDatabaseName } from '../../../../scripts/test-database-name.mjs';
import { runMigrations } from '../../src/db/migrate';

const LOCAL_SERVER = 'postgres://postgres@127.0.0.1:54329/postgres';

export type TestDatabaseKind = 'test' | 'e2e';

export type TestDatabaseOptions = {
  /** The worktree whose database this is; this checkout by default. */
  root?: string;
  /**
   * The server, and the admin database on it: `TEST_DATABASE_URL`, else `scripts/local-postgres.sh`'s.
   * Its path is never the test database itself, which is always named after the worktree.
   */
  server?: string;
};

function serverUrl(options: TestDatabaseOptions): string {
  return options.server ?? process.env.TEST_DATABASE_URL ?? LOCAL_SERVER;
}

/** This worktree's test database (or its e2e one) on the test server. */
export function testDatabaseUrl(
  kind: TestDatabaseKind = 'test',
  options: TestDatabaseOptions = {},
): string {
  const url = new URL(serverUrl(options));
  url.pathname = `/${testDatabaseName(options.root ?? REPO_ROOT, kind)}`;
  return url.toString();
}

/**
 * Creates this worktree's database if it is missing and migrates it, wiping it first when another
 * branch's migrations are in it (the same reset staging uses). Returns its URL.
 */
export async function ensureTestDatabase(
  kind: TestDatabaseKind = 'test',
  options: TestDatabaseOptions = {},
): Promise<string> {
  const url = testDatabaseUrl(kind, options);
  const name = new URL(url).pathname.slice(1);
  await withAdmin(serverUrl(options), async (admin) => {
    try {
      await admin.unsafe(`create database ${name}`);
    } catch (error) {
      // Another process of this worktree (the e2e harness, say) created it first: `42P04` if it had
      // finished, `23505` on pg_database if both were creating it at the same moment.
      if (!['42P04', '23505'].includes(sqlState(error) ?? '')) throw error;
    }
  });
  await runMigrations(url, { resetOnMismatch: true });
  return url;
}

/** Runs `work` on the server's admin database, or on `postgres` when that one does not exist. */
async function withAdmin(
  server: string,
  work: (admin: postgres.Sql) => Promise<void>,
): Promise<void> {
  try {
    await withConnection(server, work);
  } catch (error) {
    if (sqlState(error) !== '3D000') throw error;
    const fallback = new URL(server);
    fallback.pathname = '/postgres';
    await withConnection(fallback.toString(), work);
  }
}

async function withConnection(
  url: string,
  work: (sql: postgres.Sql) => Promise<void>,
): Promise<void> {
  const sql = postgres(url, { max: 1, onnotice: () => undefined });
  try {
    await sql`select 1`.catch((error: unknown) => {
      if (error instanceof postgres.PostgresError) throw error;
      const { hostname, port } = new URL(url);
      throw new Error(
        `No PostgreSQL at ${hostname}:${port || 5432} for the tests. Start one with scripts/local-postgres.sh start, or set TEST_DATABASE_URL to a server.`,
        { cause: error },
      );
    });
    await work(sql);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

function sqlState(error: unknown): string | undefined {
  return error instanceof postgres.PostgresError ? error.code : undefined;
}
