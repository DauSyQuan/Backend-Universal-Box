import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { Client } from "pg";
import dotenv from "dotenv";

dotenv.config({ path: path.resolve(process.cwd(), "ops/.env") });
dotenv.config({ path: path.resolve(process.cwd(), "ops/env.example"), override: false });

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function loadMigrationVersions() {
  const migrationsDir = path.resolve(__dirname, "../db/migrations");
  const entries = await fs.readdir(migrationsDir);
  return [
    "000_init",
    ...entries
      .sort()
      .filter((entry) => entry.endsWith(".sql") && !entry.endsWith(".down.sql"))
      .map((entry) => entry.replace(/\.sql$/, ""))
  ];
}

async function run() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required. Set it in ops/.env or environment.");
  }

  const client = new Client({ connectionString: databaseUrl });
  await client.connect();

  try {
    const appliedResult = await client.query(
      `
        select version, applied_at, checksum
        from schema_migrations
        order by applied_at asc, version asc
      `
    ).catch(() => ({ rows: [] }));

    const appliedVersions = new Set(appliedResult.rows.map((row) => row.version));
    const allVersions = await loadMigrationVersions();

    console.log("[db:status] applied migrations:");
    for (const row of appliedResult.rows) {
      console.log(`- ${row.version} applied_at=${row.applied_at} checksum=${row.checksum}`);
    }

    console.log("[db:status] pending migrations:");
    for (const version of allVersions) {
      if (!appliedVersions.has(version)) {
        console.log(`- ${version}`);
      }
    }
  } finally {
    await client.end();
  }
}

run().catch((error) => {
  console.error("[db:status] failed:", error.message);
  process.exit(1);
});
