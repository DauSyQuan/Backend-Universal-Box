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

const contextCache = new Map();

function getCachedContext(key) {
  const cached = contextCache.get(key);
  // Cache for 5 minutes
  if (cached && Date.now() - cached.time < 5 * 60 * 1000) {
    return cached.data;
  }
  return null;
}

function setCachedContext(key, data) {
  contextCache.set(key, { data, time: Date.now() });
  if (contextCache.size > 5000) {
    const oldestKey = contextCache.keys().next().value;
    contextCache.delete(oldestKey);
  }
}

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
  const cacheKey = `tv:${tenantCode}:${vesselCode}`;
  const cached = getCachedContext(cacheKey);
  if (cached !== null) return cached;

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

  const data = result.rows[0] ?? null;
  setCachedContext(cacheKey, data);
  return data;
}

export async function resolveEdgeContext({ tenantCode, vesselCode, edgeCode }) {
  const cacheKey = `edge:${tenantCode}:${vesselCode}:${edgeCode}`;
  const cached = getCachedContext(cacheKey);
  if (cached !== null) return cached;

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

  const data = result.rows[0] ?? null;
  setCachedContext(cacheKey, data);
  return data;
}

export async function ensureEdgeExists({ tenantCode, vesselCode, edgeCode }) {
  const client = await pool.connect();
  try {
    await client.query("begin");

    // Find or create tenant
    let tenantResult = await client.query(
      "select id from tenants where code = $1",
      [tenantCode]
    );
    let tenantId = tenantResult.rows[0]?.id;

    if (!tenantId) {
      const createTenant = await client.query(
        "insert into tenants (code, name) values ($1, $2) returning id",
        [tenantCode, tenantCode]
      );
      tenantId = createTenant.rows[0].id;
    }

    // Find or create vessel
    let vesselResult = await client.query(
      "select id from vessels where tenant_id = $1 and code = $2",
      [tenantId, vesselCode]
    );
    let vesselId = vesselResult.rows[0]?.id;

    if (!vesselId) {
      const createVessel = await client.query(
        "insert into vessels (tenant_id, code, name) values ($1, $2, $3) returning id",
        [tenantId, vesselCode, vesselCode]
      );
      vesselId = createVessel.rows[0].id;
    }

    // Find or create edge_box
    let edgeResult = await client.query(
      "select id from edge_boxes where vessel_id = $1 and edge_code = $2",
      [vesselId, edgeCode]
    );
    let edgeBoxId = edgeResult.rows[0]?.id;

    if (!edgeBoxId) {
      const createEdge = await client.query(
        "insert into edge_boxes (vessel_id, edge_code) values ($1, $2) returning id",
        [vesselId, edgeCode]
      );
      edgeBoxId = createEdge.rows[0].id;
    }

    await client.query("commit");

    const context = { tenant_id: tenantId, vessel_id: vesselId, edge_box_id: edgeBoxId };

    // Update cache
    const cacheKey = `edge:${tenantCode}:${vesselCode}:${edgeCode}`;
    setCachedContext(cacheKey, context);

    return context;
  } catch (err) {
    await client.query("rollback");
    throw err;
  } finally {
    client.release();
  }
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

export async function updateEdgePublicWanIp({ edgeBoxId, publicWanIp }) {
  if (!edgeBoxId || !publicWanIp) {
    return;
  }

  await pool.query(
    `
      update edge_boxes
      set public_wan_ip = $2::inet
      where id = $1
        and public_wan_ip is distinct from $2::inet
    `,
    [edgeBoxId, publicWanIp]
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
  const client = await pool.connect();
  try {
    await client.query("begin");

    const result = await client.query(
      `
        insert into telemetry
          (tenant_id, vessel_id, edge_box_id, active_uplink, latency_ms, loss_pct, jitter_ms, throughput_kbps, rx_kbps, tx_kbps, interfaces, observed_at)
        values
          ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12)
        returning id
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
        payload.rx_kbps ?? null,
        payload.tx_kbps ?? null,
        JSON.stringify(payload.interfaces ?? []),
        observedAt
      ]
    );

    const telemetryId = result.rows[0].id;

    if (payload.interfaces && Array.isArray(payload.interfaces) && payload.interfaces.length > 0) {
      const values = [];
      const flatParams = [];
      let i = 1;

      for (const iface of payload.interfaces) {
        flatParams.push(
          telemetryId,
          iface.name,
          iface.rx_kbps ?? null,
          iface.tx_kbps ?? null,
          iface.throughput_kbps ?? null,
          iface.total_gb ?? null,
          observedAt
        );
        values.push(`($${i++}, $${i++}, $${i++}, $${i++}, $${i++}, $${i++}, $${i++})`);
      }

      await client.query(
        `
          insert into telemetry_interfaces
            (telemetry_id, interface_name, rx_kbps, tx_kbps, throughput_kbps, total_gb, observed_at)
          values
            ${values.join(", ")}
        `,
        flatParams
      );
    }

    await client.query("commit");
  } catch (err) {
    await client.query("rollback");
    throw err;
  } finally {
    client.release();
  }
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
