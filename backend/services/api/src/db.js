import dotenv from "dotenv";
import path from "node:path";
import process from "node:process";
import { Pool } from "pg";

dotenv.config({ path: path.resolve(process.cwd(), "../../ops/.env") });
dotenv.config({ path: path.resolve(process.cwd(), "../../ops/env.example"), override: false });

const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  throw new Error("DATABASE_URL is required for API service");
}

export const pool = new Pool({
  connectionString: databaseUrl
});

export async function pingDb() {
  const result = await pool.query("select 1 as ok");
  return result.rows[0]?.ok === 1;
}

