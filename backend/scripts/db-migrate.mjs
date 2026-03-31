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

async function run() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required. Set it in ops/.env or environment.");
  }

  const schemaPath = path.resolve(__dirname, "../db/schema_v1.sql");
  const schemaSql = await fs.readFile(schemaPath, "utf8");

  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await client.query("begin");
    await client.query(schemaSql);
    await client.query("commit");
    console.log("[db:migrate] schema_v1.sql applied successfully");
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    await client.end();
  }
}

run().catch((error) => {
  console.error("[db:migrate] failed:", error.message);
  process.exit(1);
});

