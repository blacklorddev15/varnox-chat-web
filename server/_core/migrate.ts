import fs from "fs";
import path from "path";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";

/**
 * Applies pending migrations when the server starts.
 *
 * This exists because the upload-only deployment - the one for a panel where you have no admin
 * rights - has no install step and therefore nothing to run `pnpm db:migrate`. Without this, the
 * database quietly stays at whatever schema it had and the features needing newer tables stay
 * switched off, which is exactly what happened with migration 0003 and typing.
 *
 * Drizzle records which migrations have run, so this is a no-op once the schema is current.
 *
 * Skipped on serverless. Vercel can run several function instances at once and they would all
 * migrate the same database concurrently; there it stays a deliberate step.
 *
 * Deliberately unable to stop the server. A migration failure is logged and the process continues,
 * because refusing to boot turns a schema problem into a total outage. The app failing the specific
 * queries that need a missing table is more useful than serving nothing at all.
 */
/** Rejects if `work` has not settled within `ms`, so boot cannot wait on a dead database. */
function withTimeout<T>(work: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

export async function runMigrationsOnBoot(): Promise<void> {
  if (process.env.VERCEL === "1") return;
  if (process.env.RUN_MIGRATIONS === "0") return;

  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    console.warn("[Migrate] DATABASE_URL is not set, so migrations were skipped.");
    return;
  }

  const migrationsFolder = path.resolve(process.cwd(), "drizzle");
  if (!fs.existsSync(migrationsFolder)) {
    console.warn("[Migrate] No drizzle/ folder beside the server, so migrations were skipped.");
    return;
  }

  // Two timeouts, because pg waits forever by default. Without them an unreachable database - a
  // dropped packet rather than a refused connection - would hang this await and the server would
  // never listen, which is the opposite of the "never stop the server" rule above.
  const pool = new Pool({ connectionString, max: 1, connectionTimeoutMillis: 10_000 });

  try {
    await withTimeout(
      migrate(drizzle(pool), { migrationsFolder }),
      25_000,
      "Timed out applying migrations after 25s.",
    );
    console.log("[Migrate] Schema is up to date.");
  } catch (error) {
    console.error("[Migrate] Could not apply migrations:", error instanceof Error ? error.message : error);
    // Points at the script that exists. The previous wording named `pnpm db:migrate`, which is not
    // in package.json, so following the advice led nowhere at exactly the moment someone needed it.
    console.error("[Migrate] Starting anyway. Run `pnpm db:push` from a machine with the repository to fix this.");
  } finally {
    await pool.end().catch(() => undefined);
  }
}
