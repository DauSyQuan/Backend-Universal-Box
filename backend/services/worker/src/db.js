import dotenv from "dotenv";
import path from "node:path";
import process from "node:process";
import { Pool } from "pg";

dotenv.config({ path: path.resolve(process.cwd(), "../../ops/.env") });
dotenv.config({ path: path.resolve(process.cwd(), "../../ops/env.example"), override: false });

const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  throw new Error("DATABASE_URL is required for worker");
}

export const pool = new Pool({
  connectionString: databaseUrl
});

export async function insertIngestMessage(message) {
  await pool.query(
    `
      insert into ingest_messages
        (topic, channel, msg_id, tenant_code, vessel_code, edge_code, schema_version, payload, raw)
      values
        ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb)
    `,
    [
      message.topic,
      message.channel,
      message.msgId,
      message.tenantCode,
      message.vesselCode,
      message.edgeCode,
      message.schemaVersion,
      JSON.stringify(message.payload ?? {}),
      JSON.stringify(message.raw ?? {})
    ]
  );
}

export async function insertHeartbeat(heartbeat) {
  await pool.query(
    `
      insert into edge_heartbeats
        (tenant_code, vessel_code, edge_code, firmware_version, cpu_usage_pct, ram_usage_pct, status, observed_at)
      values
        ($1, $2, $3, $4, $5, $6, $7, $8)
    `,
    [
      heartbeat.tenantCode,
      heartbeat.vesselCode,
      heartbeat.edgeCode,
      heartbeat.firmwareVersion ?? null,
      heartbeat.cpuUsagePct ?? null,
      heartbeat.ramUsagePct ?? null,
      heartbeat.status ?? null,
      heartbeat.observedAt
    ]
  );
}

export async function resolveEdgeContext({ tenantCode, vesselCode, edgeCode }) {
  const result = await pool.query(
    `
      select t.id as tenant_id, v.id as vessel_id, e.id as edge_box_id
      from tenants t
      join vessels v on v.tenant_id = t.id
      join edge_boxes e on e.vessel_id = v.id
      where t.code = $1 and v.code = $2 and e.edge_code = $3
      limit 1
    `,
    [tenantCode, vesselCode, edgeCode]
  );

  return result.rows[0] ?? null;
}

export async function insertTelemetry({ context, payload, observedAt }) {
  await pool.query(
    `
      insert into telemetry
        (tenant_id, vessel_id, edge_box_id, active_uplink, latency_ms, loss_pct, jitter_ms, throughput_kbps, observed_at)
      values
        ($1, $2, $3, $4, $5, $6, $7, $8, $9)
    `,
    [
      context.tenant_id,
      context.vessel_id,
      context.edge_box_id,
      payload.active_uplink ?? null,
      payload.latency_ms ?? null,
      payload.loss_pct ?? null,
      payload.jitter_ms ?? null,
      payload.throughput_kbps ?? null,
      observedAt
    ]
  );
}

