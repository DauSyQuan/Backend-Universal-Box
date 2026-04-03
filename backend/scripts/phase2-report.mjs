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
    const totals = await client.query(`
      select 'ingest_messages' as table_name, count(*)::int as total from ingest_messages
      union all
      select 'ingest_errors', count(*)::int from ingest_errors
      union all
      select 'edge_heartbeats', count(*)::int from edge_heartbeats
      union all
      select 'telemetry', count(*)::int from telemetry
      union all
      select 'user_usage', count(*)::int from user_usage
      union all
      select 'events', count(*)::int from events
      union all
      select 'vms_positions', count(*)::int from vms_positions
    `);

    const channelStats = await client.query(`
      select channel, count(*)::int as total
      from ingest_messages
      group by channel
      order by channel
    `);

    const errorStats = await client.query(`
      select reason, count(*)::int as total
      from ingest_errors
      group by reason
      order by total desc, reason
    `);

    const latestErrors = await client.query(`
      select created_at, topic, channel, msg_id, reason, detail
      from ingest_errors
      order by created_at desc
      limit 10
    `);

    console.log("\n[phase2 report] table totals");
    console.table(totals.rows);

    console.log("\n[phase2 report] ingest per channel");
    console.table(channelStats.rows);

    console.log("\n[phase2 report] errors by reason");
    console.table(errorStats.rows);

    if (latestErrors.rowCount > 0) {
      console.log("\n[phase2 report] latest ingest errors");
      console.table(latestErrors.rows);
    }
  } finally {
    await client.end();
  }
}

run().catch((error) => {
  console.error("[phase2 report] failed:", error.message);
  process.exit(1);
});

