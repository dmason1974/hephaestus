import fs from "node:fs";
import path from "node:path";

import { pool } from "./pool.js";

const MIGRATIONS_DIR = path.resolve("sql");

/**
 * Bootstrap: the ledger has to exist before we can ask which migrations have
 * already run, so it is created here rather than in 001_core.sql.
 */
const BOOTSTRAP_SQL = `CREATE TABLE IF NOT EXISTS schema_migration (
  filename   TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
)`;

/**
 * Applies every .sql file in sql/ that is not yet recorded in schema_migration,
 * in lexical (i.e. numeric-prefix) order. Each file runs inside its own
 * transaction together with its ledger insert, so a failure part-way leaves no
 * partially-applied migration behind.
 *
 * Safe to re-run: already-applied files are skipped, and the DDL itself uses
 * CREATE TABLE IF NOT EXISTS as a second line of defence.
 */
async function runMigrations(): Promise<void> {
  await pool.query(BOOTSTRAP_SQL);

  const files = fs
    .readdirSync(MIGRATIONS_DIR)
    .filter(f => f.endsWith(".sql"))
    .sort();

  const { rows } = await pool.query<{ filename: string }>(
    "SELECT filename FROM schema_migration"
  );
  const applied = new Set(rows.map(r => r.filename));

  const pending = files.filter(f => !applied.has(f));
  if (pending.length === 0) {
    console.log(`Nothing to apply — ${files.length} migration(s) already up to date.`);
    return;
  }

  for (const file of pending) {
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), "utf8");
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(sql);
      await client.query("INSERT INTO schema_migration (filename) VALUES ($1)", [file]);
      await client.query("COMMIT");
      console.log(`Applied ${file}`);
    } catch (err) {
      await client.query("ROLLBACK");
      throw new Error(`Migration ${file} failed and was rolled back`, { cause: err });
    } finally {
      client.release();
    }
  }

  console.log(`Applied ${pending.length} migration(s).`);
}

try {
  await runMigrations();
} catch (err) {
  console.error(
    "Migration failed. Is the SSH tunnel running? (`npm run db:tunnel` in another terminal)"
  );
  throw err;
} finally {
  await pool.end();
}
