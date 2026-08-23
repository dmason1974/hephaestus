import "dotenv/config";
import { Client } from "pg";

/**
 * Creates the database named by PGDATABASE, if it does not already exist.
 *
 * This cannot use src/db/pool.ts: that pool connects to PGDATABASE itself,
 * which is precisely what does not exist yet. We connect to the `postgres`
 * maintenance database instead. CREATE DATABASE also cannot run inside a
 * transaction or take a bound parameter, hence the quoted identifier below.
 */
function quoteIdentifier(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

const database = process.env.PGDATABASE;
if (!database) {
  throw new Error(
    "PGDATABASE is not set. Copy .env.example to .env and fill it in before running db:create."
  );
}

const client = new Client({
  host: process.env.PGHOST,
  port: Number(process.env.PGPORT ?? 5432),
  database: "postgres",
  user: process.env.PGUSER,
  password: process.env.PGPASSWORD,
  ssl: { rejectUnauthorized: false },
});

try {
  await client.connect();
} catch (err) {
  console.error(
    "Failed to connect. Is the SSH tunnel running? (`npm run db:tunnel` in another terminal)"
  );
  throw err;
}

try {
  const { rowCount } = await client.query("SELECT 1 FROM pg_database WHERE datname = $1", [
    database,
  ]);
  if (rowCount) {
    console.log(`Database "${database}" already exists — nothing to do.`);
  } else {
    await client.query(`CREATE DATABASE ${quoteIdentifier(database)}`);
    console.log(`Created database "${database}".`);
  }
} finally {
  await client.end();
}
