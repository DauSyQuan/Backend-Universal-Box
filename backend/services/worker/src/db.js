import dotenv from "dotenv";
import path from "node:path";
import process from "node:process";
import { Pool } from "pg";
import { loadDatabaseConfig } from "../../../shared/config.js";

dotenv.config({ path: path.resolve(process.cwd(), "../../ops/.env") });
dotenv.config({ path: path.resolve(process.cwd(), "../../ops/env.example"), override: false });

const databaseConfig = loadDatabaseConfig(process.env, { applicationName: "worker" });

export const pool = new Pool({
  connectionString: databaseConfig.databaseUrl,
  application_name: databaseConfig.applicationName,
  max: databaseConfig.poolMax,
  idleTimeoutMillis: databaseConfig.idleTimeoutMillis,
  connectionTimeoutMillis: databaseConfig.connectionTimeoutMillis,
  statement_timeout: databaseConfig.statementTimeoutMillis,
  query_timeout: databaseConfig.queryTimeoutMillis
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

export async function hasRecentEvent({ vesselId, edgeBoxId, eventType, withinSeconds = 300 }) {
  const result = await pool.query(
    `
      select 1
      from events
      where vessel_id = $1
        and edge_box_id is not distinct from $2
        and event_type = $3
        and observed_at >= now() - ($4::int || ' seconds')::interval
      limit 1
    `,
    [vesselId, edgeBoxId, eventType, withinSeconds]
  );

  return result.rowCount > 0;
}

export async function listStaleEdges({ olderThanMinutes = 2, limit = 500 }) {
  const safeOlderThanMinutes = Math.max(1, Math.min(1440, Number.parseInt(String(olderThanMinutes), 10) || 2));
  const safeLimit = Math.max(1, Math.min(5000, Number.parseInt(String(limit), 10) || 500));

  const result = await pool.query(
    `
      select
        e.id as edge_box_id,
        e.edge_code,
        e.last_seen_at,
        e.created_at,
        v.id as vessel_id,
        v.code as vessel_code,
        t.id as tenant_id,
        t.code as tenant_code
      from edge_boxes e
      join vessels v on v.id = e.vessel_id
      join tenants t on t.id = v.tenant_id
      where coalesce(e.last_seen_at, e.created_at) <= now() - ($1::int || ' minutes')::interval
      order by coalesce(e.last_seen_at, e.created_at) asc
      limit $2
    `,
    [safeOlderThanMinutes, safeLimit]
  );

  return result.rows;
}

export async function getEdgeLastSeenSnapshot({ edgeBoxId }) {
  if (!edgeBoxId) {
    return null;
  }

  const result = await pool.query(
    `
      select
        id as edge_box_id,
        vessel_id,
        last_seen_at,
        created_at
      from edge_boxes
      where id = $1::uuid
      limit 1
    `,
    [edgeBoxId]
  );

  return result.rows[0] ?? null;
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

export async function resolveActivePackageAssignment({
  tenantId,
  vesselCode,
  userId
}) {
  const result = await pool.query(
    `
      select
        pa.id as package_assignment_id,
        pa.remaining_mb,
        pa.expires_at,
        pa.status,
        pa.is_active,
        p.id as package_id,
        p.code as package_code,
        p.name as package_name,
        p.tenant_code,
        p.quota_mb,
        coalesce(p.validity_days, p.duration_days) as validity_days,
        coalesce(pa.remaining_mb, p.quota_mb) as effective_remaining_mb
      from package_assignments pa
      join packages p on p.id = pa.package_id
      join users u on u.id = pa.user_id
      where pa.user_id = $1
        and u.tenant_id = $2
        and pa.status = 'active'
        and pa.is_active = true
        and ($3::text is null or pa.vessel_code = $3)
      order by pa.assigned_at desc
      limit 1
    `,
    [userId, tenantId, vesselCode ?? null]
  );

  return result.rows[0] ?? null;
}

function clampDay(year, monthIndex, day) {
  const lastDay = new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
  return Math.min(Math.max(1, day), lastDay);
}

function computeBillingCycleRange(now, resetDayOfMonth) {
  const current = new Date(now);
  const safeResetDay = Math.min(Math.max(1, Number.parseInt(String(resetDayOfMonth ?? 1), 10) || 1), 31);
  const year = current.getUTCFullYear();
  const monthIndex = current.getUTCMonth();
  const cycleStartDay = clampDay(year, monthIndex, safeResetDay);
  let start = new Date(Date.UTC(year, monthIndex, cycleStartDay, 0, 0, 0, 0));

  if (current < start) {
    const prevMonth = new Date(Date.UTC(year, monthIndex, 1, 0, 0, 0, 0));
    prevMonth.setUTCMonth(prevMonth.getUTCMonth() - 1);
    const prevYear = prevMonth.getUTCFullYear();
    const prevMonthIndex = prevMonth.getUTCMonth();
    const prevDay = clampDay(prevYear, prevMonthIndex, safeResetDay);
    start = new Date(Date.UTC(prevYear, prevMonthIndex, prevDay, 0, 0, 0, 0));
  }

  const end = new Date(start);
  end.setUTCMonth(end.getUTCMonth() + 1);
  return { start, end, resetDayOfMonth: safeResetDay };
}

function kbpsSumToGb(sumKbps) {
  const value = Number(sumKbps ?? 0);
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Number(((value * 5) / 8 / 1024 / 1024).toFixed(3));
}

export async function maybeCreateQuotaWarning({ context, observedAt }) {
  if (!context?.tenant_id || !context?.vessel_id) {
    return { triggered: false, reason: "missing_context" };
  }

  const assignmentResult = await pool.query(
    `
      select
        pa.id as package_assignment_id,
        pa.vessel_code,
        p.id as package_id,
        p.code as package_code,
        p.name as package_name,
        coalesce(pq.quota_gb, p.quota_mb::numeric / 1024) as quota_gb,
        coalesce(pq.reset_day_of_month, 1) as reset_day_of_month
      from package_assignments pa
      join packages p on p.id = pa.package_id
      left join package_quotas pq on pq.vessel_id = $1::uuid and pq.package_id = p.id
      where pa.vessel_code = (
          select code from vessels where id = $1::uuid limit 1
        )
        and pa.status = 'active'
        and pa.is_active = true
      order by pa.assigned_at desc
      limit 1
    `,
    [context.vessel_id]
  );

  const assignment = assignmentResult.rows[0] ?? null;
  if (!assignment) {
    return { triggered: false, reason: "no_assignment" };
  }

  const quotaGb = Number(assignment.quota_gb ?? 0);
  if (!Number.isFinite(quotaGb) || quotaGb <= 0) {
    return { triggered: false, reason: "no_quota" };
  }

  const cycle = computeBillingCycleRange(observedAt, assignment.reset_day_of_month ?? 1);
  const usageResult = await pool.query(
    `
      select
        coalesce(sum(coalesce(rx_kbps, 0)), 0) as rx_kbps,
        coalesce(sum(coalesce(tx_kbps, 0)), 0) as tx_kbps
      from telemetry
      where vessel_id = $1::uuid
        and observed_at >= $2::timestamptz
        and observed_at <= $3::timestamptz
    `,
    [context.vessel_id, cycle.start.toISOString(), new Date(observedAt).toISOString()]
  );

  const usageRow = usageResult.rows[0] ?? {};
  const usedGb = Number((kbpsSumToGb(usageRow.rx_kbps) + kbpsSumToGb(usageRow.tx_kbps)).toFixed(3));
  const ratio = quotaGb > 0 ? usedGb / quotaGb : 0;
  if (ratio < 0.9) {
    return {
      triggered: false,
      quota_gb: Number(quotaGb.toFixed(3)),
      used_gb: usedGb,
      ratio: Number(ratio.toFixed(3))
    };
  }

  const recent = await hasRecentEvent({
    vesselId: context.vessel_id,
    edgeBoxId: null,
    eventType: "quota_warning",
    withinSeconds: 3600
  });

  if (recent) {
    return {
      triggered: false,
      quota_gb: Number(quotaGb.toFixed(3)),
      used_gb: usedGb,
      ratio: Number(ratio.toFixed(3)),
      suppressed: true
    };
  }

  const remainingGb = Number((quotaGb - usedGb).toFixed(3));
  await insertEvent({
    context: {
      tenant_id: context.tenant_id,
      vessel_id: context.vessel_id,
      edge_box_id: null
    },
    payload: {
      event_type: "quota_warning",
      severity: "warning",
      details: {
        package_assignment_id: assignment.package_assignment_id,
        package_id: assignment.package_id,
        package_code: assignment.package_code,
        package_name: assignment.package_name,
        quota_gb: Number(quotaGb.toFixed(3)),
        used_gb: usedGb,
        remaining_gb: remainingGb,
        ratio: Number(ratio.toFixed(3)),
        cycle_start: cycle.start.toISOString(),
        cycle_end: cycle.end.toISOString()
      }
    },
    observedAt: new Date(observedAt).toISOString()
  });

  return {
    triggered: true,
    quota_gb: Number(quotaGb.toFixed(3)),
    used_gb: usedGb,
    remaining_gb: remainingGb,
    ratio: Number(ratio.toFixed(3))
  };
}

export async function recordUsageWithQuota({
  context,
  tenantCode,
  vesselCode,
  username,
  userId,
  payload,
  observedAt
}) {
  const uploadMb = Number(payload.upload_mb ?? 0);
  const downloadMb = Number(payload.download_mb ?? 0);
  const usageMb = Number.isFinite(uploadMb) && Number.isFinite(downloadMb) ? uploadMb + downloadMb : 0;

  const client = await pool.connect();
  try {
    await client.query("begin");

    const assignmentResult = await client.query(
      `
        select
          pa.id as package_assignment_id,
          pa.remaining_mb,
          pa.status,
          pa.is_active,
          p.id as package_id,
          p.code as package_code,
          p.name as package_name,
          coalesce(p.validity_days, p.duration_days) as validity_days,
          p.quota_mb,
          coalesce(pa.remaining_mb, p.quota_mb) as effective_remaining_mb
        from package_assignments pa
        join packages p on p.id = pa.package_id
        join users u on u.id = pa.user_id
        where pa.user_id = $1::uuid
          and u.tenant_id = $2::uuid
          and pa.status = 'active'
          and pa.is_active = true
          and ($3::text is null or pa.vessel_code = $3)
        order by pa.assigned_at desc
        limit 1
        for update
      `,
      [userId, context.tenant_id, vesselCode ?? null]
    );

    const assignment = assignmentResult.rows[0] ?? null;
    let remainingMb = null;
    let alertType = null;
    let quotaMb = null;

    if (assignment) {
      quotaMb = Number(assignment.quota_mb ?? 0);
      const startingRemaining = Number(assignment.effective_remaining_mb ?? assignment.quota_mb ?? 0);
      const normalizedStartingRemaining = Number.isFinite(startingRemaining) ? startingRemaining : 0;
      remainingMb = Math.max(0, normalizedStartingRemaining - usageMb);

      await client.query(
        `
          update package_assignments
          set
            remaining_mb = $2::bigint,
            status = case when $2::bigint <= 0 then 'expired' else status end,
            is_active = case when $2::bigint <= 0 then false else true end
          where id = $1::uuid
        `,
        [assignment.package_assignment_id, remainingMb]
      );

      if (quotaMb > 0) {
        const remainingRatio = remainingMb / quotaMb;
        if (remainingMb <= 0) {
          alertType = "quota_exhausted";
        } else if (remainingRatio <= 0.1) {
          alertType = "quota_90";
        } else if (remainingRatio <= 0.2) {
          alertType = "quota_80";
        }
      }
    }

    const usageResult = await client.query(
      `
        insert into user_usage
          (tenant_id, vessel_id, user_id, tenant_code, vessel_code, username, session_id, package_assignment_id, upload_mb, download_mb, observed_at)
        values
          ($1::uuid, $2::uuid, $3::uuid, $4::text, $5::text, $6::text, $7::text, $8::uuid, $9::numeric, $10::numeric, $11::timestamptz)
        returning id, total_mb
      `,
      [
        context.tenant_id,
        context.vessel_id,
        userId,
        tenantCode,
        vesselCode,
        username,
        payload.session_id ?? null,
        assignment?.package_assignment_id ?? null,
        payload.upload_mb ?? 0,
        payload.download_mb ?? 0,
        observedAt
      ]
    );

    let alertInserted = false;
    if (alertType) {
      const recentAlert = await client.query(
        `
          select 1
          from alerts
          where tenant_code = $1
            and vessel_code = $2
            and username = $3
            and alert_type = $4
            and created_at >= now() - interval '24 hours'
          limit 1
        `,
        [tenantCode, vesselCode, username, alertType]
      );

      if (recentAlert.rowCount === 0) {
        const quotaLabel =
          alertType === "quota_exhausted" ? "exhausted" : alertType === "quota_90" ? "below 10%" : "below 20%";
        await client.query(
          `
            insert into alerts
              (tenant_code, vessel_code, username, alert_type, message, remaining_mb)
            values
              ($1::text, $2::text, $3::text, $4::text, $5::text, $6::bigint)
          `,
          [
            tenantCode,
            vesselCode,
            username,
            alertType,
            `Package quota ${quotaLabel} for ${username}`,
            remainingMb
          ]
        );
        alertInserted = true;
      }
    }

    await client.query("commit");

    return {
      usage_id: usageResult.rows[0]?.id ?? null,
      total_mb: usageResult.rows[0]?.total_mb ?? null,
      package_assignment_id: assignment?.package_assignment_id ?? null,
      remaining_mb: remainingMb,
      alert_type: alertType,
      alert_inserted: alertInserted
    };
  } catch (err) {
    await client.query("rollback");
    throw err;
  } finally {
    client.release();
  }
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

export async function markCommandJobSent({ jobId, observedAt }) {
  const result = await pool.query(
    `
      update command_jobs
      set status = 'sent'
      where id = $1
        and status = 'queued'
      returning id
    `,
    [jobId]
  );

  return result.rowCount > 0;
}

export async function markCommandJobAck({ jobId, payload, observedAt }) {
  const result = await pool.query(
    `
      update command_jobs
      set
        status = 'ack',
        ack_at = coalesce(ack_at, $2),
        result_payload = coalesce($3::jsonb, result_payload)
      where id = $1
        and status not in ('success', 'failed')
      returning id
    `,
    [
      jobId,
      observedAt,
      payload ? JSON.stringify(payload) : null
    ]
  );

  return result.rowCount > 0;
}

export async function markCommandJobResult({ jobId, status, payload, observedAt }) {
  const normalizedStatus = String(status ?? "").trim();
  const result = await pool.query(
    `
      update command_jobs
      set
        status = $2,
        ack_at = coalesce(ack_at, $3),
        result_at = $3,
        result_payload = coalesce($4::jsonb, result_payload)
      where id = $1
        and status not in ('success', 'failed')
      returning id
    `,
    [
      jobId,
      normalizedStatus || "failed",
      observedAt,
      payload ? JSON.stringify(payload) : null
    ]
  );

  return result.rowCount > 0;
}
