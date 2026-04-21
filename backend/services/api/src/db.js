import dotenv from "dotenv";
import path from "node:path";
import process from "node:process";
import { Pool } from "pg";
import { loadDatabaseConfig } from "../../../shared/config.js";

dotenv.config({ path: path.resolve(process.cwd(), "../../ops/.env") });
dotenv.config({ path: path.resolve(process.cwd(), "../../ops/env.example"), override: false });

const databaseConfig = loadDatabaseConfig(process.env, { applicationName: "api" });

export const pool = new Pool({
  connectionString: databaseConfig.databaseUrl,
  application_name: databaseConfig.applicationName,
  max: databaseConfig.poolMax,
  idleTimeoutMillis: databaseConfig.idleTimeoutMillis,
  connectionTimeoutMillis: databaseConfig.connectionTimeoutMillis,
  statement_timeout: databaseConfig.statementTimeoutMillis,
  query_timeout: databaseConfig.queryTimeoutMillis
});

export async function pingDb() {
  if (!pool) {
    return null;
  }

  const startedAt = Date.now();
  const result = await pool.query("select 1 as ok");
  return {
    status: "ok",
    ok: result.rows[0]?.ok === 1,
    latency_ms: Date.now() - startedAt,
    pool_total: pool.totalCount,
    pool_idle: pool.idleCount,
    pool_waiting: pool.waitingCount
  };
}
