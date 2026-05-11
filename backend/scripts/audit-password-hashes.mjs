import dotenv from "dotenv";
import path from "node:path";
import process from "node:process";
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
    const result = await client.query(
      `
        select
          id,
          username,
          role::text as role,
          tenant_id,
          vessel_id,
          password_hash,
          created_at
        from users
        where password_hash !~ '^pbkdf2\\$'
        order by created_at asc, username asc
      `
    );

    if (result.rowCount === 0) {
      console.log("[audit-password-hashes] ok: all user rows use pbkdf2$ hashes");
      return;
    }

    console.warn(`[audit-password-hashes] found ${result.rowCount} non-pbkdf2 hash row(s):`);
    for (const row of result.rows) {
      console.warn(
        [
          `- user_id=${row.id}`,
          `username=${row.username}`,
          `role=${row.role}`,
          `tenant_id=${row.tenant_id}`,
          `vessel_id=${row.vessel_id ?? ""}`,
          `created_at=${row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at}`,
          `hash_preview=${String(row.password_hash ?? "").slice(0, 24)}`
        ].join(" ")
      );
    }

    process.exitCode = 1;
  } finally {
    await client.end();
  }
}

run().catch((error) => {
  console.error("[audit-password-hashes] failed:", error.message);
  process.exit(1);
});
