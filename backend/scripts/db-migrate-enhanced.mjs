import crypto from "node:crypto";
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
const migrationsDir = path.resolve(__dirname, "../db/migrations");

function sha256(text) {
  return crypto.createHash("sha256").update(text).digest("hex");
}

function isRollbackMode(argv) {
  return argv.includes("--rollback") || argv.includes("rollback") || argv.includes("--down");
}

function parseSteps(argv) {
  const withEquals = argv.find((arg) => arg.startsWith("--steps=") || arg.startsWith("--count="));
  if (withEquals) {
    const value = Number.parseInt(withEquals.split("=")[1] || "1", 10);
    return Number.isFinite(value) && value > 0 ? value : 1;
  }

  const index = argv.findIndex((arg) => arg === "--steps" || arg === "--count");
  if (index >= 0 && argv[index + 1]) {
    const value = Number.parseInt(argv[index + 1], 10);
    return Number.isFinite(value) && value > 0 ? value : 1;
  }

  return 1;
}

async function ensureTrackingTable(client) {
  await client.query(`
    create table if not exists schema_migrations (
      id bigserial primary key,
      filename text not null unique,
      checksum text not null,
      applied_at timestamptz not null default now()
    )
  `);
}

async function listMigrations() {
  const entries = await fs.readdir(migrationsDir, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".sql") && !entry.name.endsWith(".down.sql"))
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b));
}

async function applyMigration(client, filename) {
  const upPath = path.resolve(migrationsDir, filename);
  const sql = await fs.readFile(upPath, "utf8");
  const checksum = sha256(sql);

  const alreadyApplied = await client.query(
    `select checksum from schema_migrations where filename = $1 limit 1`,
    [filename]
  );

  if (alreadyApplied.rowCount > 0) {
    const storedChecksum = alreadyApplied.rows[0].checksum;
    if (storedChecksum !== checksum) {
      throw new Error(`migration checksum mismatch for ${filename}`);
    }
    return { applied: false, filename };
  }

  await client.query("begin");
  try {
    await client.query(sql);
    await client.query(
      `insert into schema_migrations (filename, checksum) values ($1, $2)`,
      [filename, checksum]
    );
    await client.query("commit");
    return { applied: true, filename };
  } catch (error) {
    await client.query("rollback");
    throw error;
  }
}

async function rollbackMigration(client, filename) {
  const downPath = path.resolve(migrationsDir, filename.replace(/\.sql$/, ".down.sql"));
  const downSql = await fs.readFile(downPath, "utf8");

  await client.query("begin");
  try {
    await client.query(downSql);
    await client.query(`delete from schema_migrations where filename = $1`, [filename]);
    await client.query("commit");
    return { rolledBack: true, filename };
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
    await ensureTrackingTable(client);
    const migrations = await listMigrations();

    if (isRollbackMode(process.argv.slice(2))) {
      const steps = parseSteps(process.argv.slice(2));
      const applied = await client.query(
        `select filename from schema_migrations order by applied_at desc limit $1`,
        [steps]
      );

      for (const row of applied.rows) {
        const filename = row.filename;
        const downPath = path.resolve(migrationsDir, filename.replace(/\.sql$/, ".down.sql"));
        await fs.access(downPath);
        await rollbackMigration(client, filename);
        console.log(`[db:migrate:enhanced] rolled back ${filename}`);
      }
      return;
    }

    for (const filename of migrations) {
      const result = await applyMigration(client, filename);
      if (result.applied) {
        console.log(`[db:migrate:enhanced] applied ${filename}`);
      } else {
        console.log(`[db:migrate:enhanced] skipped ${filename} (already applied)`);
      }
    }
  } finally {
    await client.end();
  }
}

run().catch((error) => {
  console.error("[db:migrate:enhanced] failed:", error.message);
  process.exit(1);
});
