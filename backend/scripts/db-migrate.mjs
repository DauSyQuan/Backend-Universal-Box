import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { Client } from "pg";
import dotenv from "dotenv";

dotenv.config({ path: path.resolve(process.cwd(), "ops/.env") });
dotenv.config({ path: path.resolve(process.cwd(), "ops/env.example"), override: false });

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const schemaVersion = "000_init";

function checksum(contents) {
  return createHash("sha256").update(contents).digest("hex");
}

async function ensureSchemaMigrationsTable(client) {
  await client.query(`
    create table if not exists schema_migrations (
      version text primary key,
      applied_at timestamptz not null default now(),
      checksum text not null
    )
  `);
}

async function getAppliedVersions(client) {
  const result = await client.query(
    `
      select version, checksum, applied_at
      from schema_migrations
      order by applied_at asc, version asc
    `
  );
  return new Map(result.rows.map((row) => [row.version, row]));
}

async function loadMigrationFiles() {
  const schemaPath = path.resolve(__dirname, "../db/schema_v1.sql");
  const migrationsDir = path.resolve(__dirname, "../db/migrations");
  const migrationFiles = [
    {
      version: schemaVersion,
      path: schemaPath
    }
  ];

  const entries = await fs.readdir(migrationsDir);
  for (const entry of entries.sort()) {
    if (!entry.endsWith(".sql") || entry.endsWith(".down.sql")) {
      continue;
    }
    migrationFiles.push({
      version: entry.replace(/\.sql$/, ""),
      path: path.resolve(migrationsDir, entry)
    });
  }

  return migrationFiles;
}

async function applyMigration(client, migration) {
  const sql = await fs.readFile(migration.path, "utf8");
  const fileChecksum = checksum(sql);

  await client.query("begin");
  try {
    await client.query(sql);
    await client.query(
      `
        insert into schema_migrations (version, checksum)
        values ($1, $2)
        on conflict (version) do update
          set checksum = excluded.checksum,
              applied_at = now()
      `,
      [migration.version, fileChecksum]
    );
    await client.query("commit");
    console.log(`[db:migrate] applied ${migration.version}`);
  } catch (error) {
    await client.query("rollback");
    throw error;
  }
}

async function run() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required. Set it in ops/.env or environment.");
  }

  const client = new Client({ connectionString: databaseUrl });
  await client.connect();

  try {
    await ensureSchemaMigrationsTable(client);
    const appliedVersions = await getAppliedVersions(client);
    const migrations = await loadMigrationFiles();

    for (const migration of migrations) {
      if (appliedVersions.has(migration.version)) {
        continue;
      }
      await applyMigration(client, migration);
    }

    console.log("[db:migrate] completed");
  } catch (error) {
    console.error("[db:migrate] failed:", error.message);
    process.exitCode = 1;
    throw error;
  } finally {
    await client.end();
  }
}

run().catch((error) => {
  if (!process.exitCode) {
    console.error("[db:migrate] failed:", error.message);
  }
  process.exit(1);
});
