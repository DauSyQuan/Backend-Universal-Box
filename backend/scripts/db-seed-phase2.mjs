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
    await client.query("begin");

    const tenant = await client.query(
      `
        insert into tenants (code, name)
        values ($1, $2)
        on conflict (code) do update set name = excluded.name
        returning id, code
      `,
      ["tnr13", "TNR13 Demo Tenant"]
    );

    const tenantId = tenant.rows[0].id;

    const site = await client.query(
      `
        insert into sites (tenant_id, code, name)
        values ($1, $2, $3)
        on conflict (tenant_id, code) do update set name = excluded.name
        returning id, code
      `,
      [tenantId, "site-001", "Site 001"]
    );

    const siteId = site.rows[0].id;

    const vessel = await client.query(
      `
        insert into vessels (tenant_id, site_id, code, name)
        values ($1, $2, $3, $4)
        on conflict (tenant_id, code) do update
          set site_id = excluded.site_id, name = excluded.name
        returning id, code
      `,
      [tenantId, siteId, "vsl-001", "Vessel 001"]
    );

    const vesselId = vessel.rows[0].id;

    await client.query(
      `
        insert into edge_boxes (vessel_id, edge_code, firmware_version)
        values ($1, $2, $3)
        on conflict (vessel_id, edge_code) do update
          set firmware_version = excluded.firmware_version
      `,
      [vesselId, "edge-001", "1.0.0"]
    );

    await client.query(
      `
        insert into users (tenant_id, vessel_id, username, password_hash, role, is_active)
        values ($1, $2, $3, $4, $5::user_role, true)
        on conflict (tenant_id, username) do update
          set vessel_id = excluded.vessel_id, role = excluded.role, is_active = true
      `,
      [tenantId, vesselId, "crew01", "phase2_seed_placeholder", "customer"]
    );

    await client.query("commit");

    console.log("[phase2 seed] completed");
    console.log("tenant_code=tnr13");
    console.log("vessel_code=vsl-001");
    console.log("edge_code=edge-001");
    console.log("usage_user=crew01");
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    await client.end();
  }
}

run().catch((error) => {
  console.error("[phase2 seed] failed:", error.message);
  process.exit(1);
});

