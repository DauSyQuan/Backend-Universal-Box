import process from "node:process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "pg";
import dotenv from "dotenv";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Ensure we load the env from ops/.env (assuming script is run from backend/)
dotenv.config({ path: path.resolve(process.cwd(), "ops/.env") });
dotenv.config({ path: path.resolve(process.cwd(), "ops/env.example"), override: false });

async function run() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required. Set it in ops/.env or environment.");
  }

  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  
  try {
    console.log("Creating new schema and triggers...");
    await client.query("begin");

    await client.query(`
      create table if not exists telemetry_interfaces (
        id uuid primary key default gen_random_uuid(),
        telemetry_id uuid not null references telemetry(id) on delete cascade,
        interface_name text not null,
        rx_kbps numeric(12,2),
        tx_kbps numeric(12,2),
        throughput_kbps numeric(12,2),
        total_gb numeric(14,3),
        observed_at timestamptz not null,
        created_at timestamptz not null default now()
      );

      create index if not exists idx_telemetry_interfaces_lookup
        on telemetry_interfaces(telemetry_id);

      create index if not exists idx_telemetry_interfaces_name_observed
        on telemetry_interfaces(interface_name, observed_at desc);

      create or replace function fn_notify_telemetry()
      returns trigger as $$
      begin
        perform pg_notify(
          'mcu_telemetry_stream',
          json_build_object(
            'tenant_id', new.tenant_id,
            'vessel_id', new.vessel_id,
            'edge_box_id', new.edge_box_id,
            'telemetry_id', new.id
          )::text
        );
        return new;
      end;
      $$ language plpgsql;

      drop trigger if exists trg_notify_telemetry on telemetry;
      create trigger trg_notify_telemetry
        after insert on telemetry
        for each row
        execute function fn_notify_telemetry();
    `);

    console.log("Schema created. Starting data migration...");

    // Extract existing interfaces into the new table
    // For each telemetry row with non-empty interfaces jsonb:
    const insertQuery = `
      insert into telemetry_interfaces
        (telemetry_id, interface_name, rx_kbps, tx_kbps, throughput_kbps, total_gb, observed_at)
      select
        t.id,
        iface->>'name' as interface_name,
        (iface->>'rx_kbps')::numeric as rx_kbps,
        (iface->>'tx_kbps')::numeric as tx_kbps,
        (iface->>'throughput_kbps')::numeric as throughput_kbps,
        (iface->>'total_gb')::numeric as total_gb,
        t.observed_at
      from telemetry t,
      jsonb_array_elements(t.interfaces) as iface
      where jsonb_array_length(t.interfaces) > 0
      on conflict do nothing;
    `;
    
    const result = await client.query(insertQuery);
    console.log(`Migrated ${result.rowCount} interface records.`);

    await client.query("commit");
    console.log("Migration completed successfully.");
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    await client.end();
  }
}

run().catch((error) => {
  console.error("Migration failed:", error);
  process.exit(1);
});
