import process from "node:process";
import path from "node:path";
import dotenv from "dotenv";
import { Client } from "pg";

dotenv.config({ path: path.resolve(process.cwd(), "ops/.env") });
dotenv.config({ path: path.resolve(process.cwd(), "ops/env.example"), override: false });

async function run() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required.");
  }

  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await client.query(`
      drop schema public cascade;
      create schema public;
      grant all on schema public to postgres;
      grant all on schema public to public;
    `);
    console.log("[db:reset-local] public schema reset complete");
  } finally {
    await client.end();
  }
}

run().catch((error) => {
  console.error("[db:reset-local] failed:", error.message);
  process.exit(1);
});

