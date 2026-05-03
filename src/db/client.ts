import pg from "pg";
import { getConfig } from "../config.js";

const cfg = getConfig();

// Strip sslmode from the URL so pg-connection-string doesn't promote it
// to verify-full (Supabase's pooler chains through an Amazon RDS cert that
// the system trust store doesn't include by default).
const cleanUrl = cfg.POSTGRES_URL.replace(/[?&]sslmode=[^&]*/, "").replace(/[?&]supa=[^&]*/, "");

export const pool = new pg.Pool({
  connectionString: cleanUrl,
  ssl: { rejectUnauthorized: false },
  max: 5,
});

export async function query<T extends pg.QueryResultRow = pg.QueryResultRow>(
  sql: string,
  params: unknown[] = [],
): Promise<pg.QueryResult<T>> {
  return pool.query<T>(sql, params);
}

export async function closeDb(): Promise<void> {
  await pool.end();
}
