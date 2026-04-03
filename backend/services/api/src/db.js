import dotenv from "dotenv";
import path from "node:path";
import process from "node:process";
import { Pool } from "pg";

dotenv.config({ path: path.resolve(process.cwd(), "../../ops/.env") });
dotenv.config({ path: path.resolve(process.cwd(), "../../ops/env.example"), override: false });

const databaseUrl = process.env.DATABASE_URL;

export const pool = databaseUrl
  ? new Pool({
      connectionString: databaseUrl
    })
  : null;

export async function pingDb() {
  if (!pool) {
    return false;
  }

  const result = await pool.query("select 1 as ok");
  return result.rows[0]?.ok === 1;
}
