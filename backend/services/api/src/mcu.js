import { pool } from "./db.js";

function ensurePool() {
  if (!pool) {
    throw new Error("database_unavailable");
  }
}

function toInt(value, fallback) {
  const parsed = Number.parseInt(String(value), 10);
  if (Number.isNaN(parsed)) {
    return fallback;
  }
  return parsed;
}

function isOnline(heartbeatAt, onlineSeconds) {
  if (!heartbeatAt) {
    return false;
  }
  const last = new Date(heartbeatAt).getTime();
  if (Number.isNaN(last)) {
    return false;
  }
  return Date.now() - last <= onlineSeconds * 1000;
}

export async function listMcuEdges({ tenantCode = null, vesselCode = null, limit = 50, onlineSeconds = 120 }) {
  ensurePool();

  const safeLimit = Math.max(1, Math.min(500, toInt(limit, 50)));
  const safeOnlineSeconds = Math.max(10, Math.min(3600, toInt(onlineSeconds, 120)));

  const result = await pool.query(
    `
      select
        t.code as tenant_code,
        t.name as tenant_name,
        v.code as vessel_code,
        v.name as vessel_name,
        e.id as edge_id,
        e.edge_code,
        e.firmware_version as edge_firmware_version,
        e.last_seen_at,
        hb.observed_at as heartbeat_at,
        hb.status as heartbeat_status,
        hb.cpu_usage_pct,
        hb.ram_usage_pct,
        hb.firmware_version as heartbeat_firmware_version,
        tm.observed_at as telemetry_at,
        tm.active_uplink,
        tm.latency_ms,
        tm.loss_pct,
        tm.jitter_ms,
        tm.throughput_kbps,
        vp.observed_at as vms_at,
        vp.latitude,
        vp.longitude,
        vp.speed_knots,
        vp.heading_deg,
        coalesce(err.error_count_24h, 0) as error_count_24h,
        err.last_error_at
      from edge_boxes e
      join vessels v on v.id = e.vessel_id
      join tenants t on t.id = v.tenant_id
      left join lateral (
        select observed_at, status, cpu_usage_pct, ram_usage_pct, firmware_version
        from edge_heartbeats hb
        where hb.tenant_code = t.code
          and hb.vessel_code = v.code
          and hb.edge_code = e.edge_code
        order by hb.observed_at desc
        limit 1
      ) hb on true
      left join lateral (
        select observed_at, active_uplink, latency_ms, loss_pct, jitter_ms, throughput_kbps
        from telemetry tm
        where tm.edge_box_id = e.id
        order by tm.observed_at desc
        limit 1
      ) tm on true
      left join lateral (
        select observed_at, latitude, longitude, speed_knots, heading_deg
        from vms_positions vp
        where vp.vessel_id = v.id
        order by vp.observed_at desc
        limit 1
      ) vp on true
      left join lateral (
        select
          count(*) filter (where created_at >= now() - interval '24 hours')::int as error_count_24h,
          max(created_at) as last_error_at
        from ingest_errors ie
        where ie.topic like concat('mcu/', t.code, '/', v.code, '/', e.edge_code, '/%')
      ) err on true
      where ($1::text is null or t.code = $1)
        and ($2::text is null or v.code = $2)
      order by coalesce(hb.observed_at, e.last_seen_at, e.created_at) desc
      limit $3
    `,
    [tenantCode, vesselCode, safeLimit]
  );

  return {
    total: result.rowCount,
    online_seconds: safeOnlineSeconds,
    items: result.rows.map((row) => ({
      ...row,
      online: isOnline(row.heartbeat_at, safeOnlineSeconds)
    }))
  };
}

export async function getMcuEdgeDetail({ tenantCode, vesselCode, edgeCode, onlineSeconds = 120 }) {
  ensurePool();
  const safeOnlineSeconds = Math.max(10, Math.min(3600, toInt(onlineSeconds, 120)));

  const edge = await pool.query(
    `
      select
        t.id as tenant_id,
        t.code as tenant_code,
        t.name as tenant_name,
        v.id as vessel_id,
        v.code as vessel_code,
        v.name as vessel_name,
        e.id as edge_id,
        e.edge_code,
        e.firmware_version as edge_firmware_version,
        e.last_seen_at
      from edge_boxes e
      join vessels v on v.id = e.vessel_id
      join tenants t on t.id = v.tenant_id
      where t.code = $1 and v.code = $2 and e.edge_code = $3
      limit 1
    `,
    [tenantCode, vesselCode, edgeCode]
  );

  if (edge.rowCount === 0) {
    return null;
  }

  const summary = edge.rows[0];

  const [heartbeat, telemetry, usageStats, usageRecent, vms, events, ingestErrors, channelActivity] = await Promise.all([
    pool.query(
      `
        select observed_at, status, cpu_usage_pct, ram_usage_pct, firmware_version
        from edge_heartbeats
        where tenant_code = $1 and vessel_code = $2 and edge_code = $3
        order by observed_at desc
        limit 1
      `,
      [tenantCode, vesselCode, edgeCode]
    ),
    pool.query(
      `
        select observed_at, active_uplink, latency_ms, loss_pct, jitter_ms, throughput_kbps
        from telemetry
        where edge_box_id = $1
        order by observed_at desc
        limit 1
      `,
      [summary.edge_id]
    ),
    pool.query(
      `
        select
          coalesce(sum(upload_mb), 0)::numeric(14,3) as upload_mb_24h,
          coalesce(sum(download_mb), 0)::numeric(14,3) as download_mb_24h,
          count(*)::int as samples_24h
        from user_usage
        where vessel_id = $1
          and observed_at >= now() - interval '24 hours'
      `,
      [summary.vessel_id]
    ),
    pool.query(
      `
        select
          u.username,
          sum(uu.upload_mb)::numeric(14,3) as upload_mb,
          sum(uu.download_mb)::numeric(14,3) as download_mb,
          max(uu.observed_at) as last_seen
        from user_usage uu
        join users u on u.id = uu.user_id
        where uu.vessel_id = $1
          and uu.observed_at >= now() - interval '24 hours'
        group by u.username
        order by (sum(uu.upload_mb) + sum(uu.download_mb)) desc
        limit 10
      `,
      [summary.vessel_id]
    ),
    pool.query(
      `
        select observed_at, latitude, longitude, speed_knots, heading_deg
        from vms_positions
        where vessel_id = $1
        order by observed_at desc
        limit 1
      `,
      [summary.vessel_id]
    ),
    pool.query(
      `
        select observed_at, event_type, severity, payload
        from events
        where vessel_id = $1
        order by observed_at desc
        limit 20
      `,
      [summary.vessel_id]
    ),
    pool.query(
      `
        select created_at, reason, detail, topic
        from ingest_errors
        where topic like concat('mcu/', $1, '/', $2, '/', $3, '/%')
        order by created_at desc
        limit 20
      `,
      [tenantCode, vesselCode, edgeCode]
    ),
    pool.query(
      `
        select channel, count(*)::int as total
        from ingest_messages
        where tenant_code = $1
          and vessel_code = $2
          and edge_code = $3
          and received_at >= now() - interval '24 hours'
        group by channel
        order by channel
      `,
      [tenantCode, vesselCode, edgeCode]
    )
  ]);

  const heartbeatRow = heartbeat.rows[0] ?? null;

  return {
    summary: {
      ...summary,
      online_seconds: safeOnlineSeconds,
      online: isOnline(heartbeatRow?.observed_at, safeOnlineSeconds)
    },
    latest: {
      heartbeat: heartbeatRow,
      telemetry: telemetry.rows[0] ?? null,
      vms: vms.rows[0] ?? null
    },
    usage_24h: usageStats.rows[0] ?? { upload_mb_24h: 0, download_mb_24h: 0, samples_24h: 0 },
    top_users_24h: usageRecent.rows,
    recent_events: events.rows,
    ingest_errors: ingestErrors.rows,
    ingest_activity_24h: channelActivity.rows
  };
}

export async function registerMcuEdge(input) {
  ensurePool();
  const tenantCode = String(input.tenant_code || "").trim();
  const vesselCode = String(input.vessel_code || "").trim();
  const edgeCode = String(input.edge_code || "").trim();

  if (!tenantCode || !vesselCode || !edgeCode) {
    const error = new Error("tenant_code, vessel_code, edge_code are required");
    error.code = "bad_request";
    throw error;
  }

  const tenantName = String(input.tenant_name || tenantCode).trim();
  const vesselName = String(input.vessel_name || vesselCode).trim();
  const firmwareVersion = input.firmware_version ? String(input.firmware_version).trim() : null;
  const observedAt = input.observed_at ? new Date(input.observed_at).toISOString() : null;

  const client = await pool.connect();
  try {
    await client.query("begin");

    const tenantResult = await client.query(
      `
        insert into tenants (code, name)
        values ($1, $2)
        on conflict (code)
        do update set name = excluded.name
        returning id, code, name
      `,
      [tenantCode, tenantName]
    );
    const tenant = tenantResult.rows[0];

    const vesselResult = await client.query(
      `
        insert into vessels (tenant_id, code, name)
        values ($1, $2, $3)
        on conflict (tenant_id, code)
        do update set name = excluded.name
        returning id, code, name
      `,
      [tenant.id, vesselCode, vesselName]
    );
    const vessel = vesselResult.rows[0];

    const edgeResult = await client.query(
      `
        insert into edge_boxes (vessel_id, edge_code, firmware_version, last_seen_at)
        values ($1, $2, $3, $4)
        on conflict (vessel_id, edge_code)
        do update
          set firmware_version = coalesce(excluded.firmware_version, edge_boxes.firmware_version),
              last_seen_at = coalesce(excluded.last_seen_at, edge_boxes.last_seen_at)
        returning id, edge_code, firmware_version, last_seen_at
      `,
      [vessel.id, edgeCode, firmwareVersion, observedAt]
    );
    const edge = edgeResult.rows[0];

    await client.query("commit");

    return {
      tenant,
      vessel,
      edge
    };
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}
