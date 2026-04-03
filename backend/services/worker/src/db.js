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
  const result = await pool.query(
    `
      insert into ingest_messages
        (topic, channel, msg_id, tenant_code, vessel_code, edge_code, schema_version, payload, raw)
      values
        ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb)
      on conflict do nothing
      returning id
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

  return {
    inserted: result.rowCount > 0
  };
}

export async function insertIngestError(errorData) {
  await pool.query(
    `
      insert into ingest_errors
        (topic, channel, msg_id, reason, detail, raw)
      values
        ($1, $2, $3, $4, $5, $6::jsonb)
    `,
    [
      errorData.topic,
      errorData.channel ?? null,
      errorData.msgId ?? null,
      errorData.reason,
      errorData.detail ?? null,
      errorData.raw ? JSON.stringify(errorData.raw) : null
    ]
  );
}

export async function resolveTenantVesselContext({ tenantCode, vesselCode }) {
  const result = await pool.query(
    `
      select t.id as tenant_id, v.id as vessel_id
      from tenants t
      join vessels v on v.tenant_id = t.id
      where t.code = $1 and v.code = $2
      limit 1
    `,
    [tenantCode, vesselCode]
  );

  return result.rows[0] ?? null;
}

export async function resolveEdgeContext({ tenantCode, vesselCode, edgeCode }) {
  const result = await pool.query(
    `
      select t.id as tenant_id, v.id as vessel_id, e.id as edge_box_id
      from tenants t
      join vessels v on v.tenant_id = t.id
      left join edge_boxes e on e.vessel_id = v.id and e.edge_code = $3
      where t.code = $1 and v.code = $2
      limit 1
    `,
    [tenantCode, vesselCode, edgeCode]
  );

  return result.rows[0] ?? null;
}

export async function resolveUserId({ tenantId, userId, username }) {
  if (userId) {
    const byId = await pool.query(
      `
        select id
        from users
        where id = $1 and tenant_id = $2
        limit 1
      `,
      [userId, tenantId]
    );
    if (byId.rowCount > 0) {
      return byId.rows[0].id;
    }
  }

  if (username) {
    const byUsername = await pool.query(
      `
        select id
        from users
        where username = $1 and tenant_id = $2
        limit 1
      `,
      [username, tenantId]
    );
    if (byUsername.rowCount > 0) {
      return byUsername.rows[0].id;
    }
  }

  return null;
}

export async function markEdgeLastSeen({ vesselId, edgeCode, observedAt }) {
  await pool.query(
    `
      update edge_boxes
      set last_seen_at = $1
      where vessel_id = $2 and edge_code = $3
    `,
    [observedAt, vesselId, edgeCode]
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
      context.edge_box_id ?? null,
      payload.active_uplink ?? null,
      payload.latency_ms ?? null,
      payload.loss_pct ?? null,
      payload.jitter_ms ?? null,
      payload.throughput_kbps ?? null,
      observedAt
    ]
  );
}

export async function insertUsage({ context, userId, payload, observedAt }) {
  await pool.query(
    `
      insert into user_usage
        (tenant_id, vessel_id, user_id, session_id, upload_mb, download_mb, observed_at)
      values
        ($1, $2, $3, $4, $5, $6, $7)
    `,
    [
      context.tenant_id,
      context.vessel_id,
      userId,
      payload.session_id ?? null,
      payload.upload_mb ?? 0,
      payload.download_mb ?? 0,
      observedAt
    ]
  );
}

export async function insertEvent({ context, payload, observedAt }) {
  await pool.query(
    `
      insert into events
        (tenant_id, vessel_id, edge_box_id, event_type, severity, payload, observed_at)
      values
        ($1, $2, $3, $4, $5, $6::jsonb, $7)
    `,
    [
      context.tenant_id,
      context.vessel_id,
      context.edge_box_id ?? null,
      payload.event_type,
      payload.severity,
      JSON.stringify(payload.details ?? {}),
      observedAt
    ]
  );
}

export async function insertVms({ context, payload, observedAt }) {
  await pool.query(
    `
      insert into vms_positions
        (tenant_id, vessel_id, latitude, longitude, speed_knots, heading_deg, observed_at)
      values
        ($1, $2, $3, $4, $5, $6, $7)
    `,
    [
      context.tenant_id,
      context.vessel_id,
      payload.latitude,
      payload.longitude,
      payload.speed_knots ?? null,
      payload.heading_deg ?? null,
      observedAt
    ]
  );
}

