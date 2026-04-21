import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { EventEmitter } from "node:events";
import { isIP } from "node:net";
import { pool } from "./db.js";
import { realtimeBus } from "../../../shared/realtime-bus.js";
import { createLogger } from "../../../shared/logger.js";

const console = createLogger("api:mcu");
const sseEmitter = new EventEmitter();
const sseMaxListeners = Number(process.env.SSE_MAX_LISTENERS || 100);
sseEmitter.setMaxListeners(Number.isFinite(sseMaxListeners) && sseMaxListeners > 0 ? sseMaxListeners : 100);
let sharedListenerClient = null;
let sharedListenerReconnectAttempts = 0;
let sharedListenerReconnectTimer = null;

const ALLOWED_COMMAND_TYPES = new Set([
  "policy_sync",
  "failback_vsat",
  "failover_starlink",
  "restore_automatic"
]);

function safeEqual(left, right) {
  const leftBuffer = Buffer.from(String(left ?? ""), "utf8");
  const rightBuffer = Buffer.from(String(right ?? ""), "utf8");
  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }
  return timingSafeEqual(leftBuffer, rightBuffer);
}

function normalizeToken(value) {
  if (value === null || value === undefined) {
    return "";
  }
  return String(value).trim();
}

function generateDeviceToken() {
  return randomBytes(24).toString("base64url");
}

function hashDeviceToken(token) {
  return createHash("sha256").update(normalizeToken(token)).digest("hex");
}

function firstPresentString(input, keys) {
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(input ?? {}, key)) {
      const value = input[key];
      if (value !== null && value !== undefined && value !== "") {
        return String(value).trim();
      }
    }
  }
  return "";
}

async function ensureNotificationListener() {
  if (sharedListenerClient || !pool) return;
  sharedListenerClient = await pool.connect();
  await sharedListenerClient.query("LISTEN mcu_telemetry_stream");
  sharedListenerReconnectAttempts = 0;
  if (sharedListenerReconnectTimer) {
    clearTimeout(sharedListenerReconnectTimer);
    sharedListenerReconnectTimer = null;
  }
  sharedListenerClient.on("notification", async (msg) => {
    if (msg.channel === "mcu_telemetry_stream") {
      try {
        const payload = JSON.parse(msg.payload);
        if (payload?.edge_box_id && payload?.telemetry_id) {
          const locationResult = await pool.query(
            `
              select
                t.code as tenant_code,
                v.code as vessel_code,
                e.edge_code
              from edge_boxes e
              join vessels v on v.id = e.vessel_id
              join tenants t on t.id = v.tenant_id
              where e.id = $1
              limit 1
            `,
            [payload.edge_box_id]
          );
          const location = locationResult.rows[0] ?? {};
          const telemetry = {
            id: payload.telemetry_id,
            edge_box_id: payload.edge_box_id,
            tenant_code: location.tenant_code ?? null,
            vessel_code: location.vessel_code ?? null,
            edge_code: location.edge_code ?? null,
            active_interface: payload.active_interface ?? null,
            rx_kbps: payload.rx_kbps ?? null,
            tx_kbps: payload.tx_kbps ?? null,
            throughput_kbps: payload.throughput_kbps ?? null,
            observed_at: payload.observed_at ?? null,
            interfaces: Array.isArray(payload.interfaces) ? payload.interfaces : []
          };
          sseEmitter.emit(`edge:${payload.edge_box_id}`, telemetry);
          realtimeBus.emit("telemetry", telemetry);
          return;
        }

        if (payload?.telemetry_id) {
          const telemetryResult = await pool.query(
            `
              select
                t.id,
                t.edge_box_id,
                t.tenant_id,
                t.active_uplink as active_interface,
                t.rx_kbps,
                t.tx_kbps,
                t.throughput_kbps,
                t.observed_at,
                v.code as vessel_code,
                te.code as tenant_code,
                e.edge_code,
                (
                  select json_agg(json_build_object(
                    'name', ti.interface_name,
                    'rx_kbps', ti.rx_kbps,
                    'tx_kbps', ti.tx_kbps,
                    'throughput_kbps', ti.throughput_kbps,
                    'total_gb', ti.total_gb
                  ))
                  from telemetry_interfaces ti
                  where ti.telemetry_id = t.id
                ) as interfaces
              from telemetry t
              join vessels v on v.id = t.vessel_id
              join tenants te on te.id = t.tenant_id
              left join edge_boxes e on e.id = t.edge_box_id
              where t.id = $1
            `,
            [payload.telemetry_id]
          );
          if (telemetryResult.rowCount > 0) {
            const t = telemetryResult.rows[0];
            sseEmitter.emit(`edge:${t.edge_box_id}`, t);
            realtimeBus.emit("telemetry", {
              id: t.id,
              edge_box_id: t.edge_box_id,
              tenant_code: t.tenant_code ?? null,
              vessel_code: t.vessel_code ?? null,
              edge_code: t.edge_code ?? null,
              active_interface: t.active_interface ?? null,
              rx_kbps: t.rx_kbps ?? null,
              tx_kbps: t.tx_kbps ?? null,
              throughput_kbps: t.throughput_kbps ?? null,
              observed_at: t.observed_at ?? null,
              interfaces: Array.isArray(t.interfaces) ? t.interfaces : []
            });
          }
        }
      } catch (err) {
        console.error("Failed to process notification", err);
      }
    }
  });
  sharedListenerClient.on("error", (err) => {
    console.error("Shared listener client error", err);
    sharedListenerClient.release(true);
    sharedListenerClient = null;
    sharedListenerReconnectAttempts += 1;
    const backoff = Math.min(30_000, 1_000 * 2 ** Math.min(sharedListenerReconnectAttempts, 5));
    if (sharedListenerReconnectTimer) {
      clearTimeout(sharedListenerReconnectTimer);
    }
    sharedListenerReconnectTimer = setTimeout(() => {
      sharedListenerReconnectTimer = null;
      ensureNotificationListener().catch((error) => {
        console.error("Failed to re-establish notification listener", error);
      });
    }, backoff);
  });
  sharedListenerClient.on("end", () => {
    sharedListenerClient = null;
  });
}

export async function ensureMcuTelemetryListener() {
  await ensureNotificationListener();
}

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

function latestObservedAt(...values) {
  let latest = null;
  for (const value of values) {
    if (!value) {
      continue;
    }
    const timestamp = new Date(value).getTime();
    if (Number.isNaN(timestamp)) {
      continue;
    }
    if (latest === null || timestamp > latest) {
      latest = timestamp;
    }
  }
  return latest === null ? null : new Date(latest).toISOString();
}

function isOnline(activityAt, onlineSeconds) {
  if (!activityAt) {
    return false;
  }
  const last = new Date(activityAt).getTime();
  if (Number.isNaN(last)) {
    return false;
  }
  return Date.now() - last <= onlineSeconds * 1000;
}

function asFiniteNumber(value) {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function firstPresent(payload, keys) {
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(payload, key)) {
      const value = payload[key];
      if (value !== null && value !== undefined && value !== "") {
        return value;
      }
    }
  }
  return undefined;
}

function normalizeWanIp(value) {
  if (value === null || value === undefined || value === "") {
    return null;
  }

  const [first] = String(value).split(",");
  const trimmed = first?.trim();
  if (!trimmed) {
    return null;
  }

  const normalized = trimmed.startsWith("::ffff:") ? trimmed.slice(7) : trimmed;
  return isIP(normalized) ? normalized : null;
}

function parseWanIpInput(value, { required = false } = {}) {
  if (value === null || value === undefined || value === "") {
    if (required) {
      const error = new Error("wan_ip is required");
      error.code = "bad_request";
      throw error;
    }
    return null;
  }

  const normalized = normalizeWanIp(value);
  if (!normalized) {
    const error = new Error("wan_ip must be a valid IPv4 or IPv6 address");
    error.code = "bad_request";
    throw error;
  }

  return normalized;
}

function normalizeTrafficSample(row) {
  const payload = row?.payload && typeof row.payload === "object" ? row.payload : {};
  const rxKbps = asFiniteNumber(firstPresent(payload, ["rx_kbps", "download_kbps", "rx_rate_kbps"]));
  const txKbps = asFiniteNumber(firstPresent(payload, ["tx_kbps", "upload_kbps", "tx_rate_kbps"]));
  const throughputRaw = asFiniteNumber(firstPresent(payload, ["throughput_kbps", "total_kbps", "bandwidth_kbps"]));
  const throughputKbps = throughputRaw ?? ((rxKbps ?? 0) + (txKbps ?? 0));

  const interfacesRaw = Array.isArray(payload.interfaces) ? payload.interfaces : [];
  const interfaces = interfacesRaw
    .map((iface) => ({
      name: String(iface?.name ?? iface?.interface ?? iface?.if ?? "").trim(),
      rx_kbps: asFiniteNumber(firstPresent(iface ?? {}, ["rx_kbps", "download_kbps", "rx_rate_kbps"])),
      tx_kbps: asFiniteNumber(firstPresent(iface ?? {}, ["tx_kbps", "upload_kbps", "tx_rate_kbps"])),
      throughput_kbps:
        asFiniteNumber(firstPresent(iface ?? {}, ["throughput_kbps", "total_kbps", "bandwidth_kbps"])) ??
        ((asFiniteNumber(firstPresent(iface ?? {}, ["rx_kbps", "download_kbps", "rx_rate_kbps"])) ?? 0) +
          (asFiniteNumber(firstPresent(iface ?? {}, ["tx_kbps", "upload_kbps", "tx_rate_kbps"])) ?? 0)),
      total_gb: asFiniteNumber(firstPresent(iface ?? {}, ["total_gb", "total_traffic_gb", "cum_gb"]))
    }))
    .filter((iface) => iface.name);

  return {
    observed_at: row.observed_at,
    active_interface: String(
      firstPresent(payload, ["active_interface", "active_uplink", "interface", "wan_interface", "uplink_if"]) ?? ""
    ),
    rx_kbps: rxKbps,
    tx_kbps: txKbps,
    throughput_kbps: throughputKbps,
    source: String(firstPresent(payload, ["source"]) ?? "unknown"),
    mk_status: String(firstPresent(payload, ["mk_status", "status"]) ?? "unknown"),
    total_gb: asFiniteNumber(firstPresent(payload, ["total_gb", "total_traffic_gb", "cum_gb"])),
    interfaces,
    raw: payload
  };
}

function avg(values) {
  if (values.length === 0) {
    return 0;
  }
  const sum = values.reduce((acc, value) => acc + value, 0);
  return sum / values.length;
}

function validateCommandPayload(commandType, commandPayload) {
  const errors = [];
  if (!ALLOWED_COMMAND_TYPES.has(commandType)) {
    errors.push(`unsupported command_type: ${commandType}`);
  }

  if (!commandPayload || typeof commandPayload !== "object" || Array.isArray(commandPayload)) {
    errors.push("command_payload must be an object");
    return errors;
  }

  const preferredUplink = String(commandPayload.preferred_uplink ?? "").trim().toLowerCase();
  if (preferredUplink && !["vsat", "starlink", "automatic"].includes(preferredUplink)) {
    errors.push("preferred_uplink must be vsat, starlink, or automatic when provided");
  }

  const scope = String(commandPayload.scope ?? "").trim().toLowerCase();
  if (scope && !["critical", "uplink_policy", "automatic", "manual"].includes(scope)) {
    errors.push("scope must be critical, uplink_policy, automatic, or manual when provided");
  }

  const mode = String(commandPayload.mode ?? "").trim().toLowerCase();
  if (mode && !["automatic", "manual"].includes(mode)) {
    errors.push("mode must be automatic or manual when provided");
  }

  return errors;
}

function normalizeCommandJobRow(row) {
  if (!row) {
    return null;
  }

  return {
    id: row.id,
    tenant_code: row.tenant_code,
    vessel_code: row.vessel_code,
    edge_code: row.edge_code,
    edge_box_id: row.edge_box_id,
    command_type: row.command_type,
    command_payload: row.command_payload ?? {},
    status: row.status,
    ack_at: row.ack_at,
    result_at: row.result_at,
    result_payload: row.result_payload ?? null,
    created_by: row.created_by ?? null,
    created_at: row.created_at
  };
}

async function resolveEdgeCommandContext({ tenantCode, vesselCode, edgeCode }) {
  ensurePool();

  const result = await pool.query(
    `
      select
        t.id as tenant_id,
        t.code as tenant_code,
        v.id as vessel_id,
        v.code as vessel_code,
        e.id as edge_box_id,
        e.edge_code
      from tenants t
      join vessels v on v.tenant_id = t.id
      join edge_boxes e on e.vessel_id = v.id
      where t.code = $1
        and v.code = $2
        and e.edge_code = $3
      limit 1
    `,
    [tenantCode, vesselCode, edgeCode]
  );

  return result.rows[0] ?? null;
}

function classifyUplinkName(value) {
  const normalized = String(value ?? "").toLowerCase();
  if (normalized.includes("starlink")) {
    return "starlink";
  }
  if (normalized.includes("vsat")) {
    return "vsat";
  }
  return null;
}

function findInterfaceByClass(interfaces, className) {
  if (!Array.isArray(interfaces) || !className) {
    return null;
  }

  return interfaces.find((iface) => classifyUplinkName(iface?.name) === className) ?? null;
}

function resolveUplinkPolicy(interfaces, activeUplink) {
  const starlink = findInterfaceByClass(interfaces, "starlink");
  const vsat = findInterfaceByClass(interfaces, "vsat");
  const activeRole = classifyUplinkName(activeUplink);

  const workInterface = vsat || starlink;
  const entertainmentInterface = starlink || vsat;

  const buildEntry = (label, preferredClass, interfaceRow, fallbackRow) => {
    const detected = Boolean(interfaceRow);
    const fallback = !detected && Boolean(fallbackRow);
    return {
      label,
      preferred: preferredClass === "vsat" ? "VSAT" : "Starlink",
      interface_name: interfaceRow?.name ?? null,
      detected,
      fallback,
      status: detected ? "ready" : fallback ? "fallback" : "missing",
      note: detected
        ? `Detected ${interfaceRow.name}`
        : fallbackRow
          ? `Falling back to ${fallbackRow.name}`
          : `No ${label.toLowerCase()} uplink telemetry yet`
    };
  };

  return {
    active_role: activeRole,
    active_interface: activeUplink ?? null,
    work: buildEntry("Work", "vsat", workInterface, starlink),
    entertainment: buildEntry("Entertainment", "starlink", entertainmentInterface, vsat)
  };
}

async function findEdgeByWanIp(publicWanIp) {
  const normalizedWanIp = parseWanIpInput(publicWanIp, { required: true });
  const result = await pool.query(
    `
      select
        t.id as tenant_id,
        t.code as tenant_code,
        v.id as vessel_id,
        v.code as vessel_code,
        e.id as edge_box_id,
        e.edge_code,
        host(e.public_wan_ip) as public_wan_ip,
        e.device_token_hash,
        e.device_token_issued_at,
        e.device_last_register_at,
        host(e.device_last_register_ip) as device_last_register_ip
      from edge_boxes e
      join vessels v on v.id = e.vessel_id
      join tenants t on t.id = v.tenant_id
      where e.public_wan_ip = $1::inet
      order by coalesce(e.last_seen_at, e.created_at) desc
      limit 1
    `,
    [normalizedWanIp]
  );

  return result.rows[0] ?? null;
}

export async function listMcuEdges({
  tenantCode = null,
  vesselCode = null,
  wanIp = null,
  limit = 50,
  offset = 0,
  after = null,
  onlineSeconds = 120
}) {
  ensurePool();

  const safeLimit = Math.max(1, Math.min(500, toInt(limit, 50)));
  const safeOffset = Math.max(0, toInt(offset, 0));
  const safeOnlineSeconds = Math.max(10, Math.min(3600, toInt(onlineSeconds, 120)));
  const normalizedWanIp = parseWanIpInput(wanIp);
  const afterValue = after ? new Date(String(after)) : null;
  const safeAfter = afterValue && !Number.isNaN(afterValue.getTime()) ? afterValue.toISOString() : null;

  const filters = [
    "($1::text is null or t.code = $1)",
    "($2::text is null or v.code = $2)",
    "($3::inet is null or e.public_wan_ip = $3::inet)"
  ];
  const params = [tenantCode, vesselCode, normalizedWanIp];

  if (safeAfter) {
    params.push(safeAfter);
    filters.push(`coalesce(hb.observed_at, e.last_seen_at, e.created_at) < $${params.length}::timestamptz`);
  }

  const result = await pool.query(
    `
      select
        t.code as tenant_code,
        t.name as tenant_name,
        v.code as vessel_code,
        v.name as vessel_name,
        e.id as edge_id,
        e.edge_code,
        host(e.public_wan_ip) as public_wan_ip,
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
      where ${filters.join(" and ")}
      order by coalesce(hb.observed_at, e.last_seen_at, e.created_at) desc
      offset $${params.length + 1}
      limit $${params.length + 2}
    `,
    [...params, safeOffset, safeLimit]
  );

  return {
    total: result.rowCount,
    limit: safeLimit,
    offset: safeOffset,
    next_after: result.rows.at(-1)
      ? latestObservedAt(result.rows.at(-1).heartbeat_at, result.rows.at(-1).telemetry_at, result.rows.at(-1).last_seen_at)
      : null,
    online_seconds: safeOnlineSeconds,
    items: result.rows.map((row) => ({
      ...row,
      online: isOnline(latestObservedAt(row.heartbeat_at, row.telemetry_at, row.last_seen_at), safeOnlineSeconds)
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
        host(e.public_wan_ip) as public_wan_ip,
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

  const [heartbeat, telemetry, usageStats, usageRecent, usageOverview, vms, events, ingestErrors, channelActivity, recentAlerts] = await Promise.all([
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
        select observed_at, active_uplink, latency_ms, loss_pct, jitter_ms, throughput_kbps, rx_kbps, tx_kbps, interfaces
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
        select
          max(observed_at) as latest_usage_at,
          count(*)::int as total_samples
        from user_usage
        where vessel_id = $1
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
        where topic like ('mcu/' || $1::text || '/' || $2::text || '/' || $3::text || '/%')
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
    ),
    pool.query(
      `
        select created_at, alert_type, message, remaining_mb
        from alerts
        where tenant_code = $1
          and vessel_code = $2
        order by created_at desc
        limit 20
      `,
      [tenantCode, vesselCode]
    )
  ]);

  const heartbeatRow = heartbeat.rows[0] ?? null;

  let telemetryRow = telemetry.rows[0] ?? null;
  if (!telemetryRow && summary.edge_id) {
    const fallbackTelemetry = await pool.query(
      `
        select observed_at, active_uplink, latency_ms, loss_pct, jitter_ms, throughput_kbps, rx_kbps, tx_kbps, interfaces
        from telemetry
        where edge_box_id is null 
          and tenant_id = $1 
          and vessel_id = $2
        order by observed_at desc
        limit 1
      `,
      [summary.tenant_id, summary.vessel_id]
    );
    telemetryRow = fallbackTelemetry.rows[0] ?? null;
  }

  const uplinkPolicy = resolveUplinkPolicy(telemetryRow?.interfaces ?? [], telemetryRow?.active_uplink ?? null);

  return {
    summary: {
      ...summary,
      online_seconds: safeOnlineSeconds,
      online: isOnline(
        latestObservedAt(heartbeatRow?.observed_at, telemetryRow?.observed_at, summary.last_seen_at),
        safeOnlineSeconds
      )
    },
    latest: {
      heartbeat: heartbeatRow,
      telemetry: telemetryRow,
      vms: vms.rows[0] ?? null
    },
    usage_24h: usageStats.rows[0] ?? { upload_mb_24h: 0, download_mb_24h: 0, samples_24h: 0 },
    top_users_24h: usageRecent.rows,
    usage_overview: usageOverview.rows[0] ?? { latest_usage_at: null, total_samples: 0 },
    uplink_policy: uplinkPolicy,
    recent_events: events.rows,
    ingest_errors: ingestErrors.rows,
    ingest_activity_24h: channelActivity.rows,
    recent_alerts: recentAlerts.rows
  };
}

export async function getMcuEdgeDetailByWanIp({ publicWanIp, onlineSeconds = 120 }) {
  ensurePool();

  const edge = await findEdgeByWanIp(publicWanIp);
  if (!edge) {
    return null;
  }

  return getMcuEdgeDetail({
    tenantCode: edge.tenant_code,
    vesselCode: edge.vessel_code,
    edgeCode: edge.edge_code,
    onlineSeconds
  });
}

export async function registerMcuEdge(input) {
  ensurePool();
  const explicitTenantCode = String(input.tenant_code || "").trim();
  const explicitVesselCode = String(input.vessel_code || "").trim();
  const explicitEdgeCode = String(input.edge_code || "").trim();
  const explicitWanIpInput = firstPresent(input, ["public_wan_ip", "wan_ip", "public_ip", "wan_ipv4", "ip_wan"]);
  const detectedWanIpInput = firstPresent(input, ["detected_public_wan_ip", "request_ip"]);
  const deviceTokenCandidate = firstPresentString(input, ["device_token", "mcu_device_token", "register_device_token"]);

  const publicWanIp =
    explicitWanIpInput !== undefined ? parseWanIpInput(explicitWanIpInput) : parseWanIpInput(detectedWanIpInput);
  const edgeByIp = publicWanIp ? await findEdgeByWanIp(publicWanIp) : null;
  const tenantCode = edgeByIp?.tenant_code ?? explicitTenantCode;
  const vesselCode = edgeByIp?.vessel_code ?? explicitVesselCode;
  const edgeCode = edgeByIp?.edge_code ?? explicitEdgeCode;

  if (!tenantCode || !vesselCode || !edgeCode) {
    const error = new Error("tenant_code, vessel_code, edge_code are required unless public_wan_ip is already mapped");
    error.code = "bad_request";
    throw error;
  }

  if (edgeByIp) {
    if (
      (explicitTenantCode && explicitTenantCode !== edgeByIp.tenant_code) ||
      (explicitVesselCode && explicitVesselCode !== edgeByIp.vessel_code) ||
      (explicitEdgeCode && explicitEdgeCode !== edgeByIp.edge_code)
    ) {
      const error = new Error(
        `public_wan_ip is already bound to ${edgeByIp.tenant_code}/${edgeByIp.vessel_code}/${edgeByIp.edge_code}`
      );
      error.code = "bad_request";
      throw error;
    }
  }

  const tenantName = String(input.tenant_name || tenantCode).trim();
  const vesselName = String(input.vessel_name || vesselCode).trim();
  const firmwareVersion = input.firmware_version ? String(input.firmware_version).trim() : null;
  let observedAt = null;
  if (input.observed_at) {
    const observedAtDate = new Date(input.observed_at);
    if (Number.isNaN(observedAtDate.getTime())) {
      const error = new Error("observed_at must be valid ISO-8601");
      error.code = "bad_request";
      throw error;
    }
    observedAt = observedAtDate.toISOString();
  }
  const registerAt = observedAt ?? new Date().toISOString();
  const registerIp = publicWanIp ?? parseWanIpInput(detectedWanIpInput);

  const client = await pool.connect();
  try {
    await client.query("begin");

    const tenantResult = await client.query(
      `
        insert into tenants (code, name)
        values ($1, $2)
        on conflict (code)
        do update set name = tenants.name
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
        do update set name = vessels.name
        returning id, code, name
      `,
      [tenant.id, vesselCode, vesselName]
    );
    const vessel = vesselResult.rows[0];

    const edgeResult = await client.query(
      `
        insert into edge_boxes (vessel_id, edge_code, firmware_version, last_seen_at, public_wan_ip)
        values ($1, $2, $3, $4, $5::inet)
        on conflict (vessel_id, edge_code)
        do update
          set firmware_version = coalesce(excluded.firmware_version, edge_boxes.firmware_version),
              last_seen_at = coalesce(excluded.last_seen_at, edge_boxes.last_seen_at),
              public_wan_ip = coalesce(excluded.public_wan_ip, edge_boxes.public_wan_ip)
        returning
          id,
          edge_code,
          host(public_wan_ip) as public_wan_ip,
          firmware_version,
          last_seen_at,
          host(device_last_register_ip) as device_last_register_ip,
          device_token_hash,
          device_token_issued_at,
          device_last_register_at
      `,
      [vessel.id, edgeCode, firmwareVersion, registerAt, publicWanIp]
    );
    const edge = edgeResult.rows[0];

    const deviceTokenRequired = Boolean(edge?.device_token_hash);
    let deviceToken = null;
    let deviceTokenHash = edge?.device_token_hash ?? null;
    let deviceTokenIssuedAt = edge?.device_token_issued_at ?? null;

    if (deviceTokenRequired) {
      if (!deviceTokenCandidate) {
        const error = new Error("device_token_required");
        error.code = "unauthorized";
        throw error;
      }

      if (!safeEqual(hashDeviceToken(deviceTokenCandidate), edge.device_token_hash)) {
        const error = new Error("invalid_device_token");
        error.code = "forbidden";
        throw error;
      }
    }

    if (!deviceTokenHash) {
      deviceToken = deviceTokenCandidate || generateDeviceToken();
      deviceTokenHash = hashDeviceToken(deviceToken);
      deviceTokenIssuedAt = registerAt;
    }

    const deviceTokenIp = registerIp ?? publicWanIp ?? null;
    await client.query(
      `
        update edge_boxes
        set
          firmware_version = coalesce($2, firmware_version),
          last_seen_at = coalesce($3, last_seen_at),
          public_wan_ip = coalesce($4::inet, public_wan_ip),
          device_token_hash = coalesce($5, device_token_hash),
          device_token_issued_at = coalesce($6, device_token_issued_at),
          device_last_register_at = $7,
          device_last_register_ip = coalesce($8::inet, device_last_register_ip)
        where id = $1
      `,
      [
        edge.id,
        firmwareVersion,
        registerAt,
        publicWanIp,
        deviceTokenHash,
        deviceTokenIssuedAt,
        registerAt,
        deviceTokenIp
      ]
    );

    await client.query("commit");

    return {
      tenant,
      vessel,
      device_token: deviceToken,
      edge: {
        ...edge,
        public_wan_ip: publicWanIp ?? edge.public_wan_ip ?? null,
        device_last_register_ip: deviceTokenIp ?? edge.device_last_register_ip ?? null,
        device_token_bound: Boolean(deviceTokenHash),
        device_token: deviceToken
      }
    };
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

export async function listCommandJobs({
  tenantCode,
  vesselCode,
  edgeCode,
  status,
  limit = 50,
  offset = 0,
  after = null
}) {
  ensurePool();

  const safeLimit = Math.max(1, Math.min(200, toInt(limit, 50)));
  const safeOffset = Math.max(0, toInt(offset, 0));
  const afterValue = after ? new Date(String(after)) : null;
  const safeAfter = afterValue && !Number.isNaN(afterValue.getTime()) ? afterValue.toISOString() : null;
  const filters = [];
  const params = [];

  if (tenantCode) {
    params.push(String(tenantCode).trim());
    filters.push(`t.code = $${params.length}`);
  }

  if (vesselCode) {
    params.push(String(vesselCode).trim());
    filters.push(`v.code = $${params.length}`);
  }

  if (edgeCode) {
    params.push(String(edgeCode).trim());
    filters.push(`e.edge_code = $${params.length}`);
  }

  if (status) {
    params.push(String(status).trim());
    filters.push(`cj.status = $${params.length}`);
  }

  if (safeAfter) {
    params.push(safeAfter);
    filters.push(`cj.created_at < $${params.length}::timestamptz`);
  }

  const query = `
    select
      cj.id,
      t.code as tenant_code,
      v.code as vessel_code,
      e.edge_code,
      cj.edge_box_id,
      cj.command_type,
      cj.command_payload,
      cj.status,
      cj.ack_at,
      cj.result_at,
      cj.result_payload,
      cj.created_by,
      cj.created_at
    from command_jobs cj
    join tenants t on t.id = cj.tenant_id
    join vessels v on v.id = cj.vessel_id
    left join edge_boxes e on e.id = cj.edge_box_id
    ${filters.length ? `where ${filters.join(" and ")}` : ""}
    order by cj.created_at desc
    offset $${params.length + 1}
    limit $${params.length + 2}
  `;

  const result = await pool.query(query, [...params, safeOffset, safeLimit]);
  return {
    total: result.rowCount,
    limit: safeLimit,
    offset: safeOffset,
    next_after: result.rows.at(-1)?.created_at ?? null,
    items: result.rows.map(normalizeCommandJobRow)
  };
}

export async function getCommandJob(commandJobId) {
  ensurePool();

  const result = await pool.query(
    `
      select
        cj.id,
        t.code as tenant_code,
        v.code as vessel_code,
        e.edge_code,
        cj.edge_box_id,
        cj.command_type,
        cj.command_payload,
        cj.status,
        cj.ack_at,
        cj.result_at,
        cj.result_payload,
        cj.created_by,
        cj.created_at
      from command_jobs cj
      join tenants t on t.id = cj.tenant_id
      join vessels v on v.id = cj.vessel_id
      left join edge_boxes e on e.id = cj.edge_box_id
      where cj.id = $1
      limit 1
    `,
    [commandJobId]
  );

  return normalizeCommandJobRow(result.rows[0] ?? null);
}

export async function createCommandJob({
  tenantCode,
  vesselCode,
  edgeCode,
  commandType,
  commandPayload = {},
  createdBy = null
}) {
  ensurePool();

  const tenant = String(tenantCode ?? "").trim();
  const vessel = String(vesselCode ?? "").trim();
  const edge = String(edgeCode ?? "").trim();
  const type = String(commandType ?? "").trim();

  if (!tenant || !vessel || !edge || !type) {
    const error = new Error("tenant_code, vessel_code, edge_code, command_type are required");
    error.code = "bad_request";
    throw error;
  }

  if (!commandPayload || typeof commandPayload !== "object" || Array.isArray(commandPayload)) {
    const error = new Error("command_payload must be an object");
    error.code = "bad_request";
    throw error;
  }

  const commandErrors = validateCommandPayload(type, commandPayload);
  if (commandErrors.length > 0) {
    const error = new Error(commandErrors.join("; "));
    error.code = "bad_request";
    throw error;
  }

  const context = await resolveEdgeCommandContext({
    tenantCode: tenant,
    vesselCode: vessel,
    edgeCode: edge
  });

  if (!context) {
    return null;
  }

  const result = await pool.query(
    `
      insert into command_jobs
        (tenant_id, vessel_id, edge_box_id, command_type, command_payload, status, created_by)
      values
        ($1, $2, $3, $4, $5::jsonb, 'queued', $6)
      returning id
    `,
    [
      context.tenant_id,
      context.vessel_id,
      context.edge_box_id,
      type,
      JSON.stringify(commandPayload),
      createdBy
    ]
  );

  return getCommandJob(result.rows[0].id);
}

export async function markCommandJobStatus(commandJobId, {
  status,
  ackAt = null,
  resultAt = null,
  resultPayload = null
} = {}) {
  ensurePool();

  const normalizedStatus = String(status ?? "").trim();
  if (!normalizedStatus) {
    const error = new Error("status is required");
    error.code = "bad_request";
    throw error;
  }

  const result = await pool.query(
    `
      update command_jobs
      set
        status = $2,
        ack_at = coalesce($3, ack_at),
        result_at = coalesce($4, result_at),
        result_payload = coalesce($5::jsonb, result_payload)
      where id = $1
      returning id
    `,
    [
      commandJobId,
      normalizedStatus,
      ackAt,
      resultAt,
      resultPayload !== null && resultPayload !== undefined ? JSON.stringify(resultPayload) : null
    ]
  );

  if (result.rowCount === 0) {
    return null;
  }

  return getCommandJob(commandJobId);
}

export async function getMcuEdgeTraffic({
  tenantCode,
  vesselCode,
  edgeCode,
  interfaceName,
  windowMinutes = 60,
  limit = 300
}) {
  ensurePool();

  const safeWindowMinutes = Math.max(1, Math.min(1440, toInt(windowMinutes, 60)));
  const safeLimit = Math.max(1, Math.min(2000, toInt(limit, 300)));

  const edgeQuery = await pool.query(
    `
      select
        t.id as tenant_id,
        t.code as tenant_code,
        v.id as vessel_id,
        v.code as vessel_code,
        e.id as edge_id,
        e.edge_code,
        host(e.public_wan_ip) as public_wan_ip
      from edge_boxes e
      join vessels v on v.id = e.vessel_id
      join tenants t on t.id = v.tenant_id
      where t.code = $1 and v.code = $2 and e.edge_code = $3
      limit 1
    `,
    [tenantCode, vesselCode, edgeCode]
  );

  if (edgeQuery.rowCount === 0) {
    return null;
  }
  
  const edgeRow = edgeQuery.rows[0];

  let samplesResult;
  if (interfaceName) {
    samplesResult = await pool.query(
      `
        select
          t.active_uplink as active_interface,
          ti.rx_kbps,
          ti.tx_kbps,
          ti.throughput_kbps,
          t.interfaces,
          t.observed_at
        from telemetry t
        join telemetry_interfaces ti on ti.telemetry_id = t.id
        where t.edge_box_id = $1
          and ti.interface_name = $4
          and t.observed_at >= now() - make_interval(mins => $2::int)
        order by t.observed_at desc
        limit $3
      `,
      [edgeRow.edge_id, safeWindowMinutes, safeLimit, interfaceName]
    );
  } else {
    samplesResult = await pool.query(
      `
        select
          active_uplink as active_interface,
          rx_kbps,
          tx_kbps,
          throughput_kbps,
          interfaces,
          observed_at
        from telemetry
        where edge_box_id = $1
          and observed_at >= now() - make_interval(mins => $2::int)
        order by observed_at desc
        limit $3
      `,
      [edgeRow.edge_id, safeWindowMinutes, safeLimit]
    );
  }

  const samples = samplesResult.rows.map(row => ({
    observed_at: row.observed_at,
    active_interface: String(row.active_interface ?? ""),
    rx_kbps: row.rx_kbps ? Number(row.rx_kbps) : null,
    tx_kbps: row.tx_kbps ? Number(row.tx_kbps) : null,
    throughput_kbps: row.throughput_kbps ? Number(row.throughput_kbps) : null,
    interfaces: row.interfaces ?? [],
    source: "unknown",
    mk_status: "unknown",
    total_gb: null,
    raw: {}
  })).sort((a, b) => {
    const ta = new Date(a.observed_at).getTime();
    const tb = new Date(b.observed_at).getTime();
    return ta - tb;
  });

  const rxSeries = samples.map((s) => s.rx_kbps ?? 0);
  const txSeries = samples.map((s) => s.tx_kbps ?? 0);
  const throughputSeries = samples.map((s) => s.throughput_kbps ?? 0);

  const latest = samples.length > 0 ? samples[samples.length - 1] : null;
  const uniqueInterfaces = Array.from(
    new Set(
      samples
        .flatMap((sample) => {
          const byActive = sample.active_interface ? [sample.active_interface] : [];
          const byInterfaces = sample.interfaces.map((iface) => iface.name);
          return [...byActive, ...byInterfaces];
        })
        .filter(Boolean)
    )
  ).sort();

  return {
    edge: edgeRow,
    window_minutes: safeWindowMinutes,
    interface_filter: interfaceName || null,
    sample_count: samples.length,
    latest,
    summary: {
      avg_rx_kbps: Number(avg(rxSeries).toFixed(2)),
      avg_tx_kbps: Number(avg(txSeries).toFixed(2)),
      avg_throughput_kbps: Number(avg(throughputSeries).toFixed(2)),
      peak_rx_kbps: Number((rxSeries.length ? Math.max(...rxSeries) : 0).toFixed(2)),
      peak_tx_kbps: Number((txSeries.length ? Math.max(...txSeries) : 0).toFixed(2)),
      peak_throughput_kbps: Number((throughputSeries.length ? Math.max(...throughputSeries) : 0).toFixed(2)),
      interfaces_seen: uniqueInterfaces
    },
    samples
  };
}

export async function getMcuEdgeTrafficByWanIp({ publicWanIp, interfaceName, windowMinutes = 60, limit = 300 }) {
  ensurePool();

  const edge = await findEdgeByWanIp(publicWanIp);
  if (!edge) {
    return null;
  }

  return getMcuEdgeTraffic({
    tenantCode: edge.tenant_code,
    vesselCode: edge.vessel_code,
    edgeCode: edge.edge_code,
    interfaceName,
    windowMinutes,
    limit
  });
}

export async function listTelemetry({ vesselCode, edgeCode = null, limit = 100, from = null, to = null }) {
  ensurePool();

  const safeLimit = Math.min(Math.max(toInt(limit, 100), 1), 1000);
  const where = [];
  const params = [];
  const addCondition = (sql, value) => {
    params.push(value);
    where.push(sql.replace("$", `$${params.length}`));
  };

  if (!String(vesselCode ?? "").trim()) {
    const error = new Error("vessel_code is required");
    error.code = "bad_request";
    throw error;
  }

  addCondition("v.code = $", String(vesselCode).trim());

  const normalizedEdgeCode = String(edgeCode ?? "").trim();
  if (normalizedEdgeCode) {
    addCondition("e.edge_code = $", normalizedEdgeCode);
  }

  if (from) {
    const fromDate = new Date(from);
    if (Number.isNaN(fromDate.getTime())) {
      const error = new Error("from must be a valid ISO-8601 timestamp");
      error.code = "bad_request";
      throw error;
    }
    addCondition("t.observed_at >= $::timestamptz", fromDate.toISOString());
  }

  if (to) {
    const toDate = new Date(to);
    if (Number.isNaN(toDate.getTime())) {
      const error = new Error("to must be a valid ISO-8601 timestamp");
      error.code = "bad_request";
      throw error;
    }
    addCondition("t.observed_at <= $::timestamptz", toDate.toISOString());
  }

  params.push(safeLimit);

  const query = `
    select
      t.observed_at,
      t.active_uplink,
      t.latency_ms,
      t.loss_pct,
      t.rx_kbps,
      t.tx_kbps,
      coalesce(
        nullif(t.interfaces, 'null'::jsonb),
        coalesce(
          (
            select jsonb_agg(
              jsonb_build_object(
                'name', ti.interface_name,
                'rx_kbps', ti.rx_kbps,
                'tx_kbps', ti.tx_kbps,
                'throughput_kbps', ti.throughput_kbps,
                'total_gb', ti.total_gb
              )
              order by ti.interface_name
            )
            from telemetry_interfaces ti
            where ti.telemetry_id = t.id
          ),
          '[]'::jsonb
        )
      ) as interfaces
    from telemetry t
    join vessels v on v.id = t.vessel_id
    left join edge_boxes e on e.id = t.edge_box_id
    where ${where.join(" and ")}
    order by t.observed_at desc
    limit $${params.length}
  `;

  const result = await pool.query(query, params);

  return result.rows.map((row) => ({
    observed_at: row.observed_at,
    active_uplink: row.active_uplink,
    latency_ms: row.latency_ms === null || row.latency_ms === undefined ? null : Number(row.latency_ms),
    loss_pct: row.loss_pct === null || row.loss_pct === undefined ? null : Number(row.loss_pct),
    rx_kbps: row.rx_kbps === null || row.rx_kbps === undefined ? null : Number(row.rx_kbps),
    tx_kbps: row.tx_kbps === null || row.tx_kbps === undefined ? null : Number(row.tx_kbps),
    interfaces: Array.isArray(row.interfaces) ? row.interfaces : []
  }));
}

const ALERT_EVENT_TYPES = ["edge_offline", "edge_online", "link_down", "quota_warning"];

export async function listAlerts({ tenantCode = null, vesselCode = null, unreadOnly = false, limit = 100, offset = 0 }) {
  ensurePool();

  const safeLimit = Math.min(Math.max(toInt(limit, 100), 1), 500);
  const safeOffset = Math.max(0, toInt(offset, 0));

  const baseConditions = ["e.event_type = ANY($1::text[])"];
  const baseParams = [ALERT_EVENT_TYPES];

  if (String(tenantCode ?? "").trim()) {
    baseParams.push(String(tenantCode).trim());
    baseConditions.push(`t.code = $${baseParams.length}`);
  }

  if (String(vesselCode ?? "").trim()) {
    baseParams.push(String(vesselCode).trim());
    baseConditions.push(`v.code = $${baseParams.length}`);
  }

  if (unreadOnly) {
    baseConditions.push("e.read_at is null");
  }

  const listParams = [...baseParams, safeOffset, safeLimit];

  const result = await pool.query(
    `
      select
        e.id,
        t.code as tenant_code,
        v.code as vessel_code,
        eb.edge_code,
        e.event_type as alert_type,
        e.severity,
        e.payload,
        e.observed_at,
        e.created_at,
        e.read_at,
        case
          when e.event_type = 'edge_offline' then coalesce(e.payload->'details'->>'reason', 'Edge offline')
          when e.event_type = 'edge_online' then 'Edge online'
          when e.event_type = 'link_down' then coalesce(e.payload->'details'->>'reason', 'Link down')
          when e.event_type = 'quota_warning' then coalesce(e.payload->'details'->>'message', 'Quota warning')
          else coalesce(e.payload->>'message', e.event_type)
        end as message
      from events e
      join tenants t on t.id = e.tenant_id
      join vessels v on v.id = e.vessel_id
      left join edge_boxes eb on eb.id = e.edge_box_id
      where ${baseConditions.join(" and ")}
      order by e.observed_at desc, e.created_at desc
      offset $${listParams.length - 1}
      limit $${listParams.length}
    `,
    listParams
  );

  const countResult = await pool.query(
    `
      select count(*)::int as total
      from events e
      join tenants t on t.id = e.tenant_id
      join vessels v on v.id = e.vessel_id
      where ${baseConditions.join(" and ")}
    `,
    baseParams
  );

  return {
    total: countResult.rows[0]?.total ?? result.rowCount,
    limit: safeLimit,
    offset: safeOffset,
    items: result.rows
  };
}

export async function markAlertRead({ alertId, readAt = new Date().toISOString() }) {
  ensurePool();
  const result = await pool.query(
    `
      update events
      set read_at = coalesce(read_at, $2::timestamptz)
      where id = $1::uuid
      returning id
    `,
    [alertId, readAt]
  );

  return result.rowCount > 0;
}

export async function getLatestHeartbeat({ edgeCode, vesselCode = null, tenantCode = null }) {
  ensurePool();

  const normalizedEdgeCode = String(edgeCode ?? "").trim();
  if (!normalizedEdgeCode) {
    const error = new Error("edge_code is required");
    error.code = "bad_request";
    throw error;
  }

  const where = ["e.edge_code = $1"];
  const params = [normalizedEdgeCode];

  if (String(vesselCode ?? "").trim()) {
    params.push(String(vesselCode).trim());
    where.push(`v.code = $${params.length}`);
  }

  if (String(tenantCode ?? "").trim()) {
    params.push(String(tenantCode).trim());
    where.push(`t.code = $${params.length}`);
  }

  const query = `
    select
      hb.observed_at,
      hb.status,
      hb.firmware_version,
      hb.cpu_usage_pct,
      hb.ram_usage_pct,
      hb.tenant_code,
      hb.vessel_code,
      hb.edge_code,
      e.public_wan_ip,
      v.code as vessel_lookup_code,
      t.code as tenant_lookup_code
    from edge_heartbeats hb
    join edge_boxes e on e.edge_code = hb.edge_code
    join vessels v on v.id = e.vessel_id
    join tenants t on t.id = v.tenant_id
    where ${where.join(" and ")}
    order by hb.observed_at desc
    limit 1
  `;

  const result = await pool.query(query, params);
  if (result.rowCount === 0) {
    return null;
  }

  const row = result.rows[0];
  return {
    observed_at: row.observed_at,
    status: row.status,
    firmware_version: row.firmware_version,
    cpu_usage_pct: row.cpu_usage_pct === null || row.cpu_usage_pct === undefined ? null : Number(row.cpu_usage_pct),
    ram_usage_pct: row.ram_usage_pct === null || row.ram_usage_pct === undefined ? null : Number(row.ram_usage_pct),
    tenant_code: row.tenant_code ?? row.tenant_lookup_code ?? null,
    vessel_code: row.vessel_code ?? row.vessel_lookup_code ?? null,
    edge_code: row.edge_code ?? normalizedEdgeCode,
    public_wan_ip: row.public_wan_ip ? String(row.public_wan_ip) : null
  };
}

export async function streamMcuTelemetry(req, res, { tenantCode, vesselCode, edgeCode }) {
  ensurePool();
  
  const edgeQuery = await pool.query(
    `
      select e.id as edge_id
      from edge_boxes e
      join vessels v on v.id = e.vessel_id
      join tenants t on t.id = v.tenant_id
      where t.code = $1 and v.code = $2 and e.edge_code = $3
      limit 1
    `,
    [tenantCode, vesselCode, edgeCode]
  );

  if (edgeQuery.rowCount === 0) {
    res.writeHead(404, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ error: "not_found" }));
    return;
  }
  const edgeId = edgeQuery.rows[0].edge_id;

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();

  // Send initial connected message
  res.write('data: {"type":"connected"}\n\n');

  await ensureNotificationListener();

  const handleUpdate = (data) => {
    res.write(`data: ${JSON.stringify({ type: "telemetry", data })}\n\n`);
  };

  const topicStr = `edge:${edgeId}`;
  sseEmitter.on(topicStr, handleUpdate);

  const cleanup = () => {
    sseEmitter.off(topicStr, handleUpdate);
  };

  req.on("close", cleanup);
  req.on("aborted", cleanup);
  req.on("error", cleanup);
}
