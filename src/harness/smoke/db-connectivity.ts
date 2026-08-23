import { pool } from "../../db/pool.js";

try {
  const { rows } = await pool.query("SELECT NOW() AS now, version() AS version");
  console.log("Connected.");
  console.table(rows);
} catch (err) {
  console.error(
    "Failed to connect. Is the SSH tunnel running? (`npm run db:tunnel` in another terminal)"
  );
  throw err;
} finally {
  await pool.end();
}
