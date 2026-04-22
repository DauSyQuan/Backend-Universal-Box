import "dotenv/config";
import { createHmac, pbkdf2Sync, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { isIP } from "node:net";
import mqtt from "mqtt";
import { getHealth, getReady, getMemoryHealth } from "./health.js";
import { pingDb, pool } from "./db.js";
import { loadApiRuntimeConfig } from "../../../shared/config.js";
import { createLogger } from "../../../shared/logger.js";
import { normalizeSecret, parseBoolean, safeEqual } from "../../../shared/utils.js";
import {
  createCommandJob,
  getMcuEdgeDetail,
  getMcuEdgeDetailByWanIp,
  getMcuEdgeTraffic,
  getMcuEdgeTrafficByWanIp,
  getLatestHeartbeat,
  getCommandJob,
  listMcuEdges,
  listCommandJobs,
  listAlerts,
  listTelemetry,
  markCommandJobStatus,
  markAlertRead,
  registerMcuEdge,
  streamMcuTelemetry
} from "./mcu.js";
import {
  ensureTrafficHourlyCron,
  getQuotaRemaining,
  getTrafficSummary,
  syncPackageQuotaForAssignment
} from "./traffic.js";
import { attachRealtimeServer } from "./realtime.js";
import { maybeServeStatic } from "./static.js";

const console = createLogger("api");
const apiConfig = loadApiRuntimeConfig(process.env);

const mqttUrl = apiConfig.mqttUrl;
const mqttClient = mqtt.connect(mqttUrl, {
  username: apiConfig.mqttUsername,
  password: apiConfig.mqttPassword
});

function toInt(value, fallback) {
  const parsed = Number.parseInt(String(value), 10);
  return Number.isNaN(parsed) ? fallback : parsed;
}

const basicAuthEnabled = apiConfig.basicAuthEnabled;
const basicAuthUsername = apiConfig.basicAuthUsername;
const generatedBasicAuthPassword = basicAuthEnabled && !normalizeSecret(apiConfig.basicAuthPassword)
  ? randomBytes(18).toString("base64url")
  : null;
const basicAuthPassword = generatedBasicAuthPassword ?? normalizeSecret(apiConfig.basicAuthPassword);
const basicAuthRole = apiConfig.basicAuthRole;
const authTokenSecret = normalizeSecret(apiConfig.authTokenSecret || basicAuthPassword || "mcu-dev-auth-secret");
const authTokenTtlSeconds = apiConfig.authTokenTtlSeconds;
const trustProxyHeaders = apiConfig.trustProxyHeaders;
const mcuRegisterEnabled = apiConfig.mcuRegisterEnabled;
const mcuRegisterToken = normalizeSecret(apiConfig.mcuRegisterToken);

if (basicAuthEnabled && !basicAuthPassword) {
  throw new Error("BASIC_AUTH_PASSWORD is required when BASIC_AUTH_ENABLED=true");
}

if (mcuRegisterEnabled && !mcuRegisterToken) {
  throw new Error("MCU_REGISTER_TOKEN is required when MCU_REGISTER_ENABLED=true");
}

const sendJson = (res, statusCode, data, extraHeaders = {}) => {
  res.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    ...extraHeaders
  });
  res.end(JSON.stringify(data));
};

const roleOrder = new Map([
  ["customer", 1],
  ["captain", 2],
  ["noc", 3],
  ["admin", 4]
]);

const allowedCommandRoles = new Set(["admin", "noc"]);
const scopedRoles = new Set(["captain", "customer"]);

function getRoleRank(role) {
  return roleOrder.get(String(role ?? "").trim().toLowerCase()) ?? 0;
}

function isRoleAllowed(role, allowedRoles) {
  return allowedRoles.includes(String(role ?? "").trim().toLowerCase());
}

function isScopedRole(role) {
  return scopedRoles.has(String(role ?? "").trim().toLowerCase());
}

function base64UrlJson(value) {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function parseBase64UrlJson(value) {
  return JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
}

function signAuthToken(claims) {
  const issuedAt = Math.floor(Date.now() / 1000);
  const expiresAt = issuedAt + authTokenTtlSeconds;
  const payload = {
    ...claims,
    iat: issuedAt,
    exp: expiresAt
  };
  const body = base64UrlJson(payload);
  const signature = createHmac("sha256", authTokenSecret).update(body).digest("base64url");
  return `${body}.${signature}`;
}

function verifyAuthToken(token) {
  const trimmed = String(token ?? "").trim();
  if (!trimmed) {
    return null;
  }

  const parts = trimmed.split(".");
  if (parts.length !== 2) {
    return null;
  }

  const [body, signature] = parts;
  const expectedSignature = createHmac("sha256", authTokenSecret).update(body).digest("base64url");
  if (!safeEqual(signature, expectedSignature)) {
    return null;
  }

  let payload;
  try {
    payload = parseBase64UrlJson(body);
  } catch {
    return null;
  }

  if (!payload || typeof payload !== "object") {
    return null;
  }

  if (typeof payload.exp !== "number" || Date.now() / 1000 >= payload.exp) {
    return null;
  }

  return payload;
}

function hashPasswordPasswordMismatch() {
  const error = new Error("invalid_credentials");
  error.code = "unauthorized";
  return error;
}

function verifyPasswordHash(password, storedHash) {
  const passwordText = String(password ?? "");
  const hashText = String(storedHash ?? "");

  if (!hashText) {
    return false;
  }

  if (hashText.startsWith("plain:") || hashText.startsWith("plaintext:")) {
    const prefixLength = hashText.indexOf(":") + 1;
    return safeEqual(passwordText, hashText.slice(prefixLength));
  }

  if (hashText.startsWith("pbkdf2$")) {
    const parts = hashText.split("$");
    const iterations = Number.parseInt(parts[1] || "", 10);
    const salt = parts[2] || "";
    const expectedHex = parts[3] || "";
    if (!Number.isFinite(iterations) || !salt || !expectedHex) {
      return false;
    }

    const derivedLength = Math.max(1, Math.floor(expectedHex.length / 2));
    const derived = pbkdf2Sync(passwordText, salt, iterations, derivedLength, "sha256").toString("hex");
    return safeEqual(derived, expectedHex);
  }

  return safeEqual(passwordText, hashText);
}

async function lookupUserPrincipal(username, password) {
  if (!pool) {
    return null;
  }

  const result = await pool.query(
    `
      select
        u.id as user_id,
        u.username,
        u.password_hash,
        u.role::text as role,
        u.vessel_id,
        u.tenant_id,
        t.code as tenant_code,
        v.code as vessel_code
      from users u
      join tenants t on t.id = u.tenant_id
      left join vessels v on v.id = u.vessel_id
      where lower(u.username) = lower($1)
        and u.is_active = true
      order by u.created_at asc
      limit 25
    `,
    [String(username ?? "").trim()]
  );

  for (const row of result.rows) {
    if (verifyPasswordHash(password, row.password_hash)) {
      return {
        user_id: row.user_id,
        username: row.username,
        role: row.role,
        tenant_id: row.tenant_id,
        tenant_code: row.tenant_code,
        vessel_id: row.vessel_id,
        vessel_code: row.vessel_code,
        auth_source: "database"
      };
    }
  }

  return null;
}

function buildEnvPrincipal() {
  return {
    user_id: null,
    username: basicAuthUsername,
    role: basicAuthRole,
    tenant_id: null,
    tenant_code: null,
    vessel_id: null,
    vessel_code: null,
    auth_source: "env"
  };
}

function extractBearerToken(req) {
  const authorization = getHeaderValue(req.headers, "authorization");
  if (authorization && authorization.startsWith("Bearer ")) {
    return authorization.slice("Bearer ".length).trim();
  }
  return "";
}

async function resolveRequestPrincipal(req) {
  const bearerToken = extractBearerToken(req);
  if (bearerToken) {
    const payload = verifyAuthToken(bearerToken);
    if (payload) {
      return {
        user_id: payload.user_id ?? null,
        username: payload.username ?? null,
        role: payload.role ?? null,
        tenant_id: payload.tenant_id ?? null,
        tenant_code: payload.tenant_code ?? null,
        vessel_id: payload.vessel_id ?? null,
        vessel_code: payload.vessel_code ?? null,
        auth_source: "bearer"
      };
    }
    return null;
  }

  const authorization = getHeaderValue(req.headers, "authorization");
  if (!authorization || !authorization.startsWith("Basic ")) {
    return null;
  }

  let decoded = "";
  try {
    decoded = Buffer.from(authorization.slice("Basic ".length), "base64").toString("utf8");
  } catch {
    return null;
  }

  const separatorIndex = decoded.indexOf(":");
  if (separatorIndex < 0) {
    return null;
  }

  const username = decoded.slice(0, separatorIndex);
  const password = decoded.slice(separatorIndex + 1);

  if (basicAuthEnabled && safeEqual(username, basicAuthUsername) && safeEqual(password, basicAuthPassword)) {
    return buildEnvPrincipal();
  }

  return lookupUserPrincipal(username, password);
}

async function authenticateRequest(req, res, { allowRoles = null, allowUnauthenticated = false } = {}) {
  const principal = await resolveRequestPrincipal(req);
  if (!principal) {
    if (allowUnauthenticated) {
      return null;
    }
    sendBasicAuthChallenge(res);
    return null;
  }

  if (allowRoles && allowRoles.length > 0 && !isRoleAllowed(principal.role, allowRoles)) {
    sendJson(res, 403, { error: "forbidden", required_roles: allowRoles });
    return null;
  }

  return principal;
}

function scopeQueryByPrincipal(query, principal) {
  if (!principal || !isScopedRole(principal.role)) {
    return query;
  }

  return {
    ...query,
    tenantCode: principal.tenant_code ?? query.tenantCode ?? null,
    vesselCode: principal.vessel_code ?? query.vesselCode ?? null
  };
}

function assertScopedAccess(principal, { tenantCode = null, vesselCode = null } = {}) {
  if (!principal || !isScopedRole(principal.role)) {
    return true;
  }

  if (principal.tenant_code && tenantCode && principal.tenant_code !== tenantCode) {
    return false;
  }

  if (principal.vessel_code && vesselCode && principal.vessel_code !== vesselCode) {
    return false;
  }

  if (principal.tenant_code && !tenantCode) {
    return false;
  }

  if (principal.vessel_code && !vesselCode) {
    return false;
  }

  return true;
}

function issueAuthResponse(principal) {
  const token = signAuthToken(principal);
  return {
    access_token: token,
    token_type: "Bearer",
    expires_in: authTokenTtlSeconds,
    user: {
      user_id: principal.user_id,
      username: principal.username,
      role: principal.role,
      tenant_code: principal.tenant_code,
      vessel_code: principal.vessel_code
    }
  };
}

const getHeaderValue = (headers, name) => {
  const value = headers[name];
  if (Array.isArray(value)) {
    return value[0] ?? null;
  }
  return value ?? null;
};

const normalizeIpCandidate = (value) => {
  if (!value) {
    return null;
  }

  const trimmed = String(value).trim();
  if (!trimmed) {
    return null;
  }

  const normalized = trimmed.startsWith("::ffff:") ? trimmed.slice(7) : trimmed;
  return isIP(normalized) ? normalized : null;
};

const isPublicIpCandidate = (value) => {
  const normalized = normalizeIpCandidate(value);
  if (!normalized) {
    return false;
  }

  if (normalized.includes(":")) {
    const lowered = normalized.toLowerCase();
    return !(
      lowered === "::1" ||
      lowered === "::" ||
      lowered.startsWith("fe80:") ||
      lowered.startsWith("fc") ||
      lowered.startsWith("fd")
    );
  }

  if (
    normalized.startsWith("10.") ||
    normalized.startsWith("127.") ||
    normalized.startsWith("169.254.") ||
    normalized.startsWith("192.168.")
  ) {
    return false;
  }

  const octets = normalized.split(".").map((part) => Number(part));
  if (octets.length !== 4 || octets.some((part) => !Number.isInteger(part))) {
    return false;
  }

  if (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) {
    return false;
  }

  return true;
};

const getRequestIp = (req) => {
  if (trustProxyHeaders) {
    const forwardedFor = getHeaderValue(req.headers, "x-forwarded-for");
    if (forwardedFor) {
      const [first] = String(forwardedFor).split(",");
      const candidate = normalizeIpCandidate(first);
      if (isPublicIpCandidate(candidate)) {
        return candidate;
      }
    }

    const realIp = getHeaderValue(req.headers, "x-real-ip");
    const realCandidate = normalizeIpCandidate(realIp);
    if (isPublicIpCandidate(realCandidate)) {
      return realCandidate;
    }
  }

  const remoteCandidate = normalizeIpCandidate(req.socket?.remoteAddress ?? null);
  return isPublicIpCandidate(remoteCandidate) ? remoteCandidate : null;
};

const rateLimitWindows = new Map();
const metrics = {
  requestsTotal: new Map(),
  requestDurationBuckets: [0.05, 0.1, 0.2, 0.5, 1, 2, 5],
  requestDurationCounts: new Map(),
  inFlight: 0
};

function metricKey(labels) {
  return `${labels.method}|${labels.route}|${labels.status}`;
}

function recordRequestMetric({ method, route, status, durationSeconds }) {
  const key = metricKey({ method, route, status });
  metrics.requestsTotal.set(key, (metrics.requestsTotal.get(key) ?? 0) + 1);

  const durationKey = `${method}|${route}`;
  const existing = metrics.requestDurationCounts.get(durationKey) ?? {
    count: 0,
    sum: 0,
    buckets: new Map(metrics.requestDurationBuckets.map((bucket) => [bucket, 0]))
  };

  existing.count += 1;
  existing.sum += durationSeconds;
  for (const bucket of metrics.requestDurationBuckets) {
    if (durationSeconds <= bucket) {
      existing.buckets.set(bucket, (existing.buckets.get(bucket) ?? 0) + 1);
    }
  }
  metrics.requestDurationCounts.set(durationKey, existing);
}

function renderMetrics() {
  const lines = [
    "# HELP http_requests_total Total number of HTTP requests",
    "# TYPE http_requests_total counter"
  ];

  for (const [key, count] of metrics.requestsTotal) {
    const [method, route, status] = key.split("|");
    lines.push(`http_requests_total{method="${method}",route="${route}",status="${status}"} ${count}`);
  }

  lines.push("# HELP http_request_duration_seconds HTTP request duration in seconds");
  lines.push("# TYPE http_request_duration_seconds histogram");
  for (const [key, stats] of metrics.requestDurationCounts) {
    const [method, route] = key.split("|");
    let cumulative = 0;
    for (const bucket of metrics.requestDurationBuckets) {
      cumulative = stats.buckets.get(bucket) ?? cumulative;
      lines.push(`http_request_duration_seconds_bucket{method="${method}",route="${route}",le="${bucket}"} ${cumulative}`);
    }
    lines.push(`http_request_duration_seconds_bucket{method="${method}",route="${route}",le="+Inf"} ${stats.count}`);
    lines.push(`http_request_duration_seconds_sum{method="${method}",route="${route}"} ${stats.sum.toFixed(6)}`);
    lines.push(`http_request_duration_seconds_count{method="${method}",route="${route}"} ${stats.count}`);
  }

  lines.push("# HELP http_requests_in_flight Active HTTP requests");
  lines.push("# TYPE http_requests_in_flight gauge");
  lines.push(`http_requests_in_flight ${metrics.inFlight}`);
  return `${lines.join("\n")}\n`;
}

function getRateLimitConfig(pathname) {
  if (pathname === "/api/auth/login") {
    return { limit: 10, windowMs: 60_000 };
  }
  if (pathname === "/api/commands" || pathname.startsWith("/api/commands/")) {
    return { limit: 30, windowMs: 60_000 };
  }
  if (pathname === "/api/mcu/register") {
    return { limit: 20, windowMs: 60_000 };
  }
  return { limit: 120, windowMs: 60_000 };
}

function checkRateLimit(req, pathname) {
  const requestIp = getRequestIp(req);
  if (!requestIp) {
    return { allowed: true, key: null };
  }

  const { limit, windowMs } = getRateLimitConfig(pathname);
  const windowKey = Math.floor(Date.now() / windowMs);
  const key = `${requestIp}:${pathname}:${windowKey}`;
  const entry = rateLimitWindows.get(key) ?? { count: 0, expiresAt: (windowKey + 2) * windowMs };
  entry.count += 1;
  rateLimitWindows.set(key, entry);

  if (rateLimitWindows.size > 5000) {
    const now = Date.now();
    for (const [entryKey, value] of rateLimitWindows) {
      if (value.expiresAt <= now) {
        rateLimitWindows.delete(entryKey);
      }
    }
  }

  return {
    allowed: entry.count <= limit,
    limit,
    remaining: Math.max(0, limit - entry.count),
    resetAt: entry.expiresAt,
    key
  };
}

function parseDateInput(value, { endOfDay = false } = {}) {
  if (value === undefined || value === null || value === "") {
    return null;
  }

  const parsed = new Date(String(value));
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }

  if (endOfDay) {
    parsed.setUTCHours(23, 59, 59, 999);
  } else {
    parsed.setUTCHours(0, 0, 0, 0);
  }

  return parsed.toISOString();
}

function parseTimestampInput(value) {
  if (value === undefined || value === null || value === "") {
    return null;
  }

  const parsed = new Date(String(value));
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }

  return parsed.toISOString();
}

function normalizePolicyAddress(value) {
  if (value === undefined || value === null) {
    return null;
  }

  const text = String(value).trim();
  if (!text) {
    return null;
  }

  const parts = text.split("/");
  if (parts.length === 2) {
    const [ipPartRaw, prefixRaw] = parts;
    const ipPart = String(ipPartRaw ?? "").trim();
    const prefixText = String(prefixRaw ?? "").trim();
    const version = isIP(ipPart);
    if (!version) {
      return null;
    }

    const prefix = Number.parseInt(prefixText, 10);
    if (!Number.isInteger(prefix)) {
      return null;
    }

    if ((version === 4 && (prefix < 0 || prefix > 32)) || (version === 6 && (prefix < 0 || prefix > 128))) {
      return null;
    }

    return `${ipPart}/${prefix}`;
  }

  return normalizeIpCandidate(text);
}

function envCsvList(name) {
  const raw = String(process.env[name] ?? "").trim();
  if (!raw) {
    return [];
  }

  return raw
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function getPolicyGroupDefaults(name, preferredUplink) {
  const normalizedName = String(name ?? "").trim().toLowerCase();
  const normalizedPreferred = String(preferredUplink ?? "").trim().toLowerCase();

  const defaultSourceAddresses =
    normalizedName === "work"
      ? envCsvList("WORK_SOURCE_ADDRESSES")
      : normalizedName === "entertainment"
        ? envCsvList("ENTERTAINMENT_SOURCE_ADDRESSES")
        : [];

  const defaultGateway =
    normalizedPreferred === "vsat"
      ? normalizeIpCandidate(process.env.VSAT_GATEWAY)
      : normalizedPreferred === "starlink"
        ? normalizeIpCandidate(process.env.STARLINK_GATEWAY)
        : normalizeIpCandidate(process.env.POLICY_GATEWAY);

  return {
    sourceAddresses: defaultSourceAddresses,
    gateway: defaultGateway
  };
}

function normalizePolicyGroups(groups) {
  if (!Array.isArray(groups) || groups.length === 0) {
    const error = new Error("groups must be a non-empty array");
    error.code = "bad_request";
    throw error;
  }

  return groups.map((group, index) => {
    if (!group || typeof group !== "object" || Array.isArray(group)) {
      const error = new Error(`groups[${index}] must be an object`);
      error.code = "bad_request";
      throw error;
    }

    const name = String(group.name ?? "").trim();
    if (!name) {
      const error = new Error(`groups[${index}].name is required`);
      error.code = "bad_request";
      throw error;
    }

    const preferredUplink = String(
      group.preferred_uplink ??
        (name.toLowerCase() === "work"
          ? "vsat"
          : name.toLowerCase() === "entertainment"
            ? "starlink"
            : "")
    )
      .trim()
      .toLowerCase();
    if (!preferredUplink || !["vsat", "starlink", "automatic"].includes(preferredUplink)) {
      const error = new Error(`groups[${index}].preferred_uplink must be vsat, starlink, or automatic`);
      error.code = "bad_request";
      throw error;
    }

    const defaults = getPolicyGroupDefaults(name, preferredUplink);
    const gateway = normalizeIpCandidate(group.gateway) ?? defaults.gateway;
    if (!gateway) {
      const error = new Error(`groups[${index}].gateway must be a valid IP address`);
      error.code = "bad_request";
      throw error;
    }

    const sourceAddressesRaw = Array.isArray(group.source_addresses) && group.source_addresses.length > 0
      ? group.source_addresses
      : defaults.sourceAddresses;
    if (sourceAddressesRaw.length === 0) {
      const error = new Error(`groups[${index}].source_addresses must be a non-empty array`);
      error.code = "bad_request";
      throw error;
    }

    const sourceAddresses = [];
    for (const [addressIndex, address] of sourceAddressesRaw.entries()) {
      const normalized = normalizePolicyAddress(address);
      if (!normalized) {
        const error = new Error(`groups[${index}].source_addresses[${addressIndex}] must be a valid CIDR or IP address`);
        error.code = "bad_request";
        throw error;
      }
      sourceAddresses.push(normalized);
    }

    return {
      name,
      preferred_uplink: preferredUplink,
      source_addresses: [...new Set(sourceAddresses)],
      gateway
    };
  });
}

async function resolvePolicyTarget({ tenantCode = null, vesselCode = null, edgeCode = null, requireEdge = true } = {}) {
  if (!pool) {
    const error = new Error("database_unavailable");
    error.code = "database_unavailable";
    throw error;
  }

  const normalizedVesselCode = String(vesselCode ?? "").trim();
  if (!normalizedVesselCode) {
    const error = new Error("vessel_code is required");
    error.code = "bad_request";
    throw error;
  }

  const normalizedTenantCode = String(tenantCode ?? "").trim() || null;
  const normalizedEdgeCode = String(edgeCode ?? "").trim() || null;
  const params = [normalizedVesselCode];
  const filters = ["v.code = $1"];
  const edgeParamPlaceholder = normalizedEdgeCode ? `$${params.length + (normalizedTenantCode ? 2 : 1)}` : null;

  if (normalizedTenantCode) {
    params.push(normalizedTenantCode);
    filters.push(`t.code = $${params.length}`);
  }

  const query = `
    select
      t.id as tenant_id,
      t.code as tenant_code,
      v.id as vessel_id,
      v.code as vessel_code,
      e.id as edge_box_id,
      e.edge_code
    from vessels v
    join tenants t on t.id = v.tenant_id
    left join lateral (
      select e.id, e.edge_code
      from edge_boxes e
      where e.vessel_id = v.id
        ${normalizedEdgeCode ? `and e.edge_code = ${edgeParamPlaceholder}` : ""}
      order by coalesce(e.last_seen_at, e.created_at) desc
      limit 1
    ) e on true
    where ${filters.join(" and ")}
    order by t.code asc, v.code asc
    limit 2
  `;

  if (normalizedEdgeCode) {
    params.push(normalizedEdgeCode);
  }

  const result = await pool.query(query, params);
  if (result.rowCount === 0) {
    return null;
  }

  if (result.rowCount > 1 && !normalizedTenantCode) {
    const error = new Error("tenant_code is required for ambiguous vessel_code");
    error.code = "bad_request";
    throw error;
  }

  const target = result.rows[0];
  if (requireEdge && !target.edge_box_id) {
    const error = new Error("edge_not_found");
    error.code = "not_found";
    throw error;
  }

  return target;
}

function escapeCsvValue(value) {
  const text = value === null || value === undefined ? "" : String(value);
  if (/[,"\n\r]/.test(text)) {
    return `"${text.replaceAll('"', '""')}"`;
  }
  return text;
}

async function insertPackageAuditEvent({
  tenantCode = null,
  packageId = null,
  packageCode = null,
  vesselCode = null,
  username = null,
  actionType,
  actor = null,
  beforePayload = null,
  afterPayload = null
}) {
  if (!actionType) {
    return;
  }

  await pool.query(
    `
      insert into package_audit_events (
        tenant_code,
        package_id,
        package_code,
        vessel_code,
        username,
        action_type,
        actor_user_id,
        actor_username,
        actor_role,
        before_payload,
        after_payload
      )
      values ($1, $2::uuid, $3, $4, $5, $6, $7::uuid, $8, $9, $10::jsonb, $11::jsonb)
    `,
    [
      tenantCode,
      packageId,
      packageCode,
      vesselCode,
      username,
      actionType,
      actor?.user_id ?? null,
      actor?.username ?? null,
      actor?.role ?? null,
      beforePayload ? JSON.stringify(beforePayload) : null,
      afterPayload ? JSON.stringify(afterPayload) : null
    ]
  );
}

function buildUsageReportFilterState(url) {
  const tenantCode = url.searchParams.get("tenant_code") ?? url.searchParams.get("tenant") ?? null;
  const vesselCode = url.searchParams.get("vessel_code") ?? url.searchParams.get("vessel") ?? null;
  const username = url.searchParams.get("username") ?? null;
  const packageCode = url.searchParams.get("package_code") ?? null;
  const dateFrom = parseDateInput(url.searchParams.get("date_from"));
  const dateTo = parseDateInput(url.searchParams.get("date_to"), { endOfDay: true });
  const windowMinutesRaw = Number(url.searchParams.get("window_minutes") ?? "1440");
  const windowMinutes = Number.isFinite(windowMinutesRaw) && windowMinutesRaw > 0 ? Math.min(windowMinutesRaw, 10080) : 1440;
  const bucketRaw = String(url.searchParams.get("bucket") ?? "day").toLowerCase();
  const bucket = ["hour", "day", "week"].includes(bucketRaw) ? bucketRaw : "day";

  const conditions = [];
  const params = [];
  const addCondition = (sql, value) => {
    params.push(value);
    conditions.push(sql.replace("$", `$${params.length}`));
  };

  if (dateFrom || dateTo) {
    addCondition("uu.observed_at >= $::timestamptz", dateFrom ?? "1970-01-01T00:00:00.000Z");
    addCondition("uu.observed_at <= $::timestamptz", dateTo ?? new Date().toISOString());
  } else {
    addCondition("uu.observed_at >= now() - ($::int || ' minutes')::interval", windowMinutes);
  }

  if (tenantCode) {
    addCondition("uu.tenant_code = $", tenantCode);
  }
  if (vesselCode) {
    addCondition("uu.vessel_code = $", vesselCode);
  }
  if (username) {
    addCondition("lower(uu.username) = lower($)", username);
  }
  if (packageCode) {
    addCondition("p.code = $", packageCode);
  }

  return {
    tenantCode,
    vesselCode,
    username,
    packageCode,
    dateFrom,
    dateTo,
    windowMinutes,
    bucket,
    conditions,
    params,
    whereClause: conditions.length ? `where ${conditions.join(" and ")}` : ""
  };
}

const readJsonBody = async (req, maxBytes = 1_000_000) => {
  let total = 0;
  const chunks = [];
  for await (const chunk of req) {
    total += chunk.length;
    if (total > maxBytes) {
      const err = new Error("payload_too_large");
      err.code = "payload_too_large";
      throw err;
    }
    chunks.push(chunk);
  }

  if (chunks.length === 0) {
    return {};
  }

  const raw = Buffer.concat(chunks).toString("utf8");
  try {
    return JSON.parse(raw);
  } catch {
    const err = new Error("invalid_json");
    err.code = "invalid_json";
    throw err;
  }
};

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const publishMqttOnce = (topic, payload, options = {}, timeoutMs = 5_000) =>
  new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error("mqtt_publish_timeout"));
    }, timeoutMs);

    mqttClient.publish(topic, payload, options, (error) => {
      clearTimeout(timeout);
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });

async function publishMqtt(topic, payload, options = {}, { attempts = 3, timeoutMs = 5_000 } = {}) {
  let lastError = null;
  const safeAttempts = Math.max(1, Number(attempts) || 1);

  for (let attempt = 1; attempt <= safeAttempts; attempt += 1) {
    try {
      await publishMqttOnce(topic, payload, options, timeoutMs);
      return;
    } catch (error) {
      lastError = error;
      if (attempt < safeAttempts) {
        await delay(Math.min(500 * attempt, 2_000));
      }
    }
  }

  throw lastError ?? new Error("mqtt_publish_failed");
}

const buildCommandEnvelope = (job) => ({
  msg_id: job.id,
  timestamp: new Date().toISOString(),
  tenant_id: job.tenant_code,
  vessel_id: job.vessel_code,
  edge_id: job.edge_code,
  schema_version: "v1",
  payload: {
    command_job_id: job.id,
    command_type: job.command_type,
    command_payload: job.command_payload ?? {}
  }
});

function requiresBasicAuth(pathname) {
  if (!basicAuthEnabled) {
    return false;
  }

  return !(
    pathname === "/api/health" ||
    pathname === "/api/ready" ||
    pathname === "/metrics" ||
    pathname === "/api/auth/login" ||
    pathname === "/api/auth/refresh" ||
    pathname === "/api/auth/logout" ||
    pathname === "/api/mcu/register" ||
    pathname === "/" ||
    pathname === "/dashboard" ||
    pathname === "/dashboard/" ||
    pathname === "/dashboard/index.html" ||
    pathname === "/login" ||
    pathname === "/login/" ||
    pathname === "/login/index.html" ||
    pathname === "/package-catalog" ||
    pathname === "/package-catalog/" ||
    pathname === "/package-catalog/index.html" ||
    pathname === "/marine-portal" ||
    pathname === "/marine-portal/" ||
    pathname === "/marine-portal/index.html" ||
    pathname.startsWith("/dashboard/") ||
    pathname.startsWith("/login/") ||
    pathname.startsWith("/package-catalog/") ||
    pathname.startsWith("/marine-portal/")
  );
}

function sendBasicAuthChallenge(res) {
  sendJson(
    res,
    401,
    { error: "auth_required" },
    {
      "www-authenticate": 'Basic realm="MCU Dashboard", charset="UTF-8"'
    }
  );
}

function isBasicAuthAuthorized(req) {
  const authorization = getHeaderValue(req.headers, "authorization");
  if (!authorization || !authorization.startsWith("Basic ")) {
    return false;
  }

  let decoded = "";
  try {
    decoded = Buffer.from(authorization.slice("Basic ".length), "base64").toString("utf8");
  } catch {
    return false;
  }

  const separatorIndex = decoded.indexOf(":");
  if (separatorIndex < 0) {
    return false;
  }

  const username = decoded.slice(0, separatorIndex);
  const password = decoded.slice(separatorIndex + 1);
  return safeEqual(username, basicAuthUsername) && safeEqual(password, basicAuthPassword);
}

function getRegisterTokenCandidate(req, body, url) {
  const headerToken =
    getHeaderValue(req.headers, "x-mcu-register-token") ??
    getHeaderValue(req.headers, "x-register-token");
  if (headerToken) {
    return String(headerToken).trim();
  }

  const authorization = getHeaderValue(req.headers, "authorization");
  if (authorization && authorization.startsWith("Bearer ")) {
    return authorization.slice("Bearer ".length).trim();
  }

  if (body?.register_token) {
    return String(body.register_token).trim();
  }

  const queryToken = url.searchParams.get("register_token");
  if (queryToken) {
    return String(queryToken).trim();
  }

  return "";
}

function getRegisterDeviceTokenCandidate(req, body, url) {
  const headerToken =
    getHeaderValue(req.headers, "x-mcu-device-token") ??
    getHeaderValue(req.headers, "x-device-token");
  if (headerToken) {
    return String(headerToken).trim();
  }

  if (body?.device_token) {
    return String(body.device_token).trim();
  }

  const queryToken = url.searchParams.get("device_token");
  if (queryToken) {
    return String(queryToken).trim();
  }

  return "";
}

function validateRegisterAccess(req, res, body, url) {
  if (!mcuRegisterEnabled) {
    sendJson(res, 403, { error: "mcu_register_disabled" });
    return false;
  }

  const providedToken = getRegisterTokenCandidate(req, body, url);
  const providedDeviceToken = getRegisterDeviceTokenCandidate(req, body, url);
  if (!providedToken) {
    if (!providedDeviceToken) {
      sendJson(res, 401, { error: "register_token_required" });
      return false;
    }
  }

  if (!safeEqual(providedToken, mcuRegisterToken)) {
    if (!providedDeviceToken) {
      sendJson(res, 403, { error: "register_token_invalid" });
      return false;
    }
  }

  return true;
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  const startedAt = process.hrtime.bigint();
  let metricsRecorded = false;
  const shouldTimeoutRequest = !url.pathname.endsWith("/stream");
  let requestTimeout = null;
  metrics.inFlight += 1;
  const recordMetricOnce = () => {
    if (metricsRecorded) return;
    metricsRecorded = true;
    metrics.inFlight = Math.max(0, metrics.inFlight - 1);
    const elapsedSeconds = Number(process.hrtime.bigint() - startedAt) / 1_000_000_000;
    recordRequestMetric({
      method: String(req.method || "GET").toUpperCase(),
      route: url.pathname,
      status: String(res.statusCode || 0),
      durationSeconds: elapsedSeconds
    });
  };
  res.on("finish", recordMetricOnce);
  res.on("close", recordMetricOnce);

  if (shouldTimeoutRequest) {
    requestTimeout = setTimeout(() => {
      if (res.writableEnded) {
        return;
      }

      if (!res.headersSent) {
        sendJson(res, 408, { error: "request_timeout" });
        return;
      }

      res.destroy(new Error("request_timeout"));
    }, apiConfig.requestTimeoutMs);
  }

  const clearRequestTimeout = () => {
    if (requestTimeout) {
      clearTimeout(requestTimeout);
      requestTimeout = null;
    }
  };
  res.once("finish", clearRequestTimeout);
  res.once("close", clearRequestTimeout);

  const rateLimitCheck = checkRateLimit(req, url.pathname);
  if (!rateLimitCheck.allowed) {
    sendJson(
      res,
      429,
      { error: "rate_limited" },
      {
        "retry-after": "60",
        "x-ratelimit-limit": String(rateLimitCheck.limit ?? 120),
        "x-ratelimit-remaining": String(rateLimitCheck.remaining ?? 0)
      }
    );
    return;
  }

  if (requiresBasicAuth(url.pathname) && !getHeaderValue(req.headers, "authorization")) {
    sendBasicAuthChallenge(res);
    return;
  }

  if (await maybeServeStatic(req, res, url)) {
    return;
  }

  if (url.pathname === "/api/health" && req.method === "GET") {
    try {
      const database = await pingDb().catch(() => null);
      sendJson(res, 200, getHealth({
        database,
        memory: getMemoryHealth()
      }));
    } catch (error) {
      console.error("[api/health] failed:", error);
      sendJson(res, 200, getHealth({
        database: { status: "error", message: "database_unavailable" },
        memory: getMemoryHealth()
      }));
    }
    return;
  }

  if (url.pathname === "/api/ready" && req.method === "GET") {
    try {
      const database = await pingDb();
      const ready = getReady({ database });
      sendJson(res, database?.ok ? 200 : 503, ready);
    } catch {
      sendJson(res, 503, getReady({ database: { status: "error", message: "database_unavailable" } }));
    }
    return;
  }

  if (url.pathname === "/metrics" && req.method === "GET") {
    res.writeHead(200, {
      "content-type": "text/plain; version=0.0.4; charset=utf-8",
      "cache-control": "no-store"
    });
    res.end(renderMetrics());
    return;
  }

  if (url.pathname === "/api/auth/login" && req.method === "POST") {
    try {
      const body = await readJsonBody(req);
      const username = String(body.username ?? body.user ?? "").trim();
      const password = String(body.password ?? body.pass ?? "");
      if (!username || !password) {
        sendJson(res, 400, { error: "username_and_password_required" });
        return;
      }

      const principal = basicAuthEnabled && safeEqual(username, basicAuthUsername) && safeEqual(password, basicAuthPassword)
        ? buildEnvPrincipal()
        : await lookupUserPrincipal(username, password);

      if (!principal) {
        sendJson(res, 401, { error: "invalid_credentials" });
        return;
      }

      sendJson(res, 200, issueAuthResponse(principal));
    } catch (error) {
      if (error?.code === "invalid_json") {
        sendJson(res, 400, { error: "invalid_json" });
        return;
      }
      if (error?.code === "payload_too_large") {
        sendJson(res, 413, { error: "payload_too_large" });
        return;
      }
      console.error("[api/auth/login] failed:", error);
      sendJson(res, 500, { error: "auth_login_failed" });
    }
    return;
  }

  if (url.pathname === "/api/auth/refresh" && req.method === "POST") {
    const principal = await authenticateRequest(req, res, { allowRoles: [...roleOrder.keys()] });
    if (!principal) {
      return;
    }
    sendJson(res, 200, issueAuthResponse(principal));
    return;
  }

  if (url.pathname === "/api/auth/logout" && req.method === "POST") {
    sendJson(res, 200, { ok: true });
    return;
  }

  if (url.pathname === "/api/commands" && req.method === "GET") {
    const principal = await authenticateRequest(req, res, { allowRoles: ["admin", "noc", "captain", "customer"] });
    if (!principal) {
      return;
    }
    try {
      const query = scopeQueryByPrincipal({
        tenantCode: url.searchParams.get("tenant") ?? url.searchParams.get("tenant_code"),
        vesselCode: url.searchParams.get("vessel") ?? url.searchParams.get("vessel_code"),
        edgeCode: url.searchParams.get("edge") ?? url.searchParams.get("edge_code"),
        status: url.searchParams.get("status"),
        limit: url.searchParams.get("limit"),
        offset: url.searchParams.get("offset"),
        after: url.searchParams.get("after")
      }, principal);

      const data = await listCommandJobs(query);
      sendJson(res, 200, data);
    } catch (error) {
      if (error?.code === "bad_request") {
        sendJson(res, 400, { error: error.message });
        return;
      }
      console.error("[api/commands] failed:", error);
      sendJson(res, 500, { error: "command_jobs_query_failed" });
    }
    return;
  }

  if (url.pathname === "/api/commands" && req.method === "POST") {
    const principal = await authenticateRequest(req, res, { allowRoles: ["admin", "noc"] });
    if (!principal) {
      return;
    }
    try {
      const body = await readJsonBody(req);
      const tenantCode = String(body.tenant_code ?? body.tenant ?? url.searchParams.get("tenant") ?? "").trim();
      const vesselCode = String(body.vessel_code ?? body.vessel ?? url.searchParams.get("vessel") ?? "").trim();
      const edgeCode = String(body.edge_code ?? body.edge ?? url.searchParams.get("edge") ?? "").trim();

      if (!assertScopedAccess(principal, { tenantCode, vesselCode })) {
        sendJson(res, 403, { error: "forbidden" });
        return;
      }

      const job = await createCommandJob({
        tenantCode,
        vesselCode,
        edgeCode,
        commandType: body.command_type ?? body.type,
        commandPayload: body.command_payload ?? body.payload ?? {},
        createdBy: principal.user_id ?? null
      });

      if (!job) {
        sendJson(res, 404, { error: "edge_not_found" });
        return;
      }

      const mqttTopic = `mcu/${job.tenant_code}/${job.vessel_code}/${job.edge_code}/command`;
      const envelope = buildCommandEnvelope(job);

      try {
        await publishMqtt(mqttTopic, JSON.stringify(envelope), { qos: 1, retain: false }, { attempts: 3, timeoutMs: 7_000 });
        const sentJob = await markCommandJobStatus(job.id, { status: "sent" });
        sendJson(res, 201, {
          ok: true,
          mqtt_topic: mqttTopic,
          command: sentJob ?? job,
          envelope
        });
      } catch (publishError) {
        await markCommandJobStatus(job.id, {
          status: "failed",
          resultAt: new Date().toISOString(),
          resultPayload: {
            error: publishError?.message || String(publishError),
            stage: "publish"
          }
        }).catch(() => {});
        console.error("[api/commands] publish failed:", publishError);
        sendJson(res, 503, { error: "command_publish_failed", command_id: job.id });
      }
    } catch (error) {
      if (error?.code === "invalid_json") {
        sendJson(res, 400, { error: "invalid_json" });
        return;
      }
      if (error?.code === "payload_too_large") {
        sendJson(res, 413, { error: "payload_too_large" });
        return;
      }
      if (error?.code === "bad_request") {
        sendJson(res, 400, { error: error.message });
        return;
      }
      console.error("[api/commands] create failed:", error);
      sendJson(res, 500, { error: "command_create_failed" });
    }
    return;
  }

  if (url.pathname === "/api/policies" && req.method === "GET") {
    const principal = await authenticateRequest(req, res, { allowRoles: ["admin", "noc", "captain", "customer"] });
    if (!principal) {
      return;
    }

    try {
      const vesselCode = String(url.searchParams.get("vessel_code") ?? url.searchParams.get("vessel") ?? principal.vessel_code ?? "").trim();
      const tenantCode = String(url.searchParams.get("tenant_code") ?? url.searchParams.get("tenant") ?? principal.tenant_code ?? "").trim() || null;
      if (!vesselCode) {
        sendJson(res, 400, { error: "vessel_code is required" });
        return;
      }

      if (!assertScopedAccess(principal, { tenantCode, vesselCode })) {
        sendJson(res, 403, { error: "forbidden" });
        return;
      }

      const scope = await resolvePolicyTarget({
        tenantCode,
        vesselCode,
        requireEdge: false
      });

      if (!scope) {
        sendJson(res, 404, { error: "vessel_not_found" });
        return;
      }

      const limit = Math.max(1, Math.min(200, toInt(url.searchParams.get("limit"), 50)));
      const offset = Math.max(0, toInt(url.searchParams.get("offset"), 0));
      const result = await pool.query(
        `
          select
            p.id,
            t.code as tenant_code,
            t.name as tenant_name,
            v.code as vessel_code,
            v.name as vessel_name,
            p.groups,
            p.command_job_id,
            p.created_at,
            p.applied_at,
            case when p.applied_at is not null then true else false end as applied,
            case
              when p.applied_at is not null then 'applied'
              when p.command_job_id is null then 'pending'
              when cj.status = 'failed' then 'failed'
              when cj.status in ('queued', 'sent', 'ack', 'success') then 'pending'
              else coalesce(cj.status, 'pending')
            end as applied_state,
            cj.status as command_status,
            cj.ack_at as command_ack_at,
            cj.result_at as command_result_at,
            cj.result_payload as command_result_payload,
            e.edge_code
          from policies p
          join tenants t on t.id = p.tenant_id
          join vessels v on v.id = p.vessel_id
          left join command_jobs cj on cj.id = p.command_job_id
          left join lateral (
            select e.edge_code
            from edge_boxes e
            where e.vessel_id = v.id
            order by coalesce(e.last_seen_at, e.created_at) desc
            limit 1
          ) e on true
          where p.vessel_id = $1::uuid
          order by p.created_at desc
          offset $2
          limit $3
        `,
        [scope.vessel_id, offset, limit]
      );

      sendJson(res, 200, {
        total: result.rowCount,
        limit,
        offset,
        next_after: result.rows.at(-1)?.created_at ?? null,
        items: result.rows
      });
    } catch (error) {
      if (error?.code === "bad_request") {
        sendJson(res, 400, { error: error.message });
        return;
      }
      console.error("[api/policies GET] failed:", error);
      sendJson(res, 500, { error: "policies_query_failed" });
    }
    return;
  }

  if (url.pathname === "/api/policies" && req.method === "POST") {
    const principal = await authenticateRequest(req, res, { allowRoles: ["admin", "noc"] });
    if (!principal) {
      return;
    }

    try {
      const body = await readJsonBody(req);
      const tenantCode = String(body.tenant_code ?? body.tenant ?? "").trim() || null;
      const vesselCode = String(body.vessel_code ?? body.vessel ?? "").trim();
      const edgeCode = String(body.edge_code ?? body.edge ?? "").trim() || null;

      if (!vesselCode) {
        sendJson(res, 400, { error: "vessel_code is required" });
        return;
      }

      if (!assertScopedAccess(principal, { tenantCode, vesselCode })) {
        sendJson(res, 403, { error: "forbidden" });
        return;
      }

      const groups = normalizePolicyGroups(body.groups);
      const scope = await resolvePolicyTarget({
        tenantCode,
        vesselCode,
        edgeCode,
        requireEdge: true
      });

      if (!assertScopedAccess(principal, { tenantCode: scope.tenant_code, vesselCode: scope.vessel_code })) {
        sendJson(res, 403, { error: "forbidden" });
        return;
      }

      const policyInsert = await pool.query(
        `
          insert into policies (tenant_id, vessel_id, groups)
          values ($1::uuid, $2::uuid, $3::jsonb)
          returning id, tenant_id, vessel_id, groups, command_job_id, created_at, applied_at
        `,
        [scope.tenant_id, scope.vessel_id, JSON.stringify(groups)]
      );
      const policy = policyInsert.rows[0];

      const job = await createCommandJob({
        tenantCode: scope.tenant_code,
        vesselCode: scope.vessel_code,
        edgeCode: scope.edge_code,
        commandType: "policy_sync",
        commandPayload: { groups },
        createdBy: principal.user_id ?? null
      });

      if (!job) {
        await pool.query("delete from policies where id = $1::uuid", [policy.id]).catch(() => {});
        sendJson(res, 404, { error: "edge_not_found" });
        return;
      }

      await pool.query(
        `
          update policies
          set command_job_id = $2::uuid
          where id = $1::uuid
        `,
        [policy.id, job.id]
      );

      const mqttTopic = `mcu/${job.tenant_code}/${job.vessel_code}/${job.edge_code}/command`;
      const envelope = buildCommandEnvelope(job);

      try {
        await publishMqtt(mqttTopic, JSON.stringify(envelope), { qos: 1, retain: false }, { attempts: 3, timeoutMs: 7_000 });
        const sentJob = await markCommandJobStatus(job.id, { status: "sent" });
        await pool.query(
          `
            update policies
            set applied_at = now()
            where id = $1::uuid
          `,
          [policy.id]
        );

        sendJson(res, 201, {
          ok: true,
          mqtt_topic: mqttTopic,
          policy: {
            ...policy,
            command_job_id: job.id,
            applied_at: new Date().toISOString()
          },
          command: sentJob ?? job,
          envelope
        });
      } catch (publishError) {
        await markCommandJobStatus(job.id, {
          status: "failed",
          resultAt: new Date().toISOString(),
          resultPayload: {
            error: publishError?.message || String(publishError),
            stage: "publish"
          }
        }).catch(() => {});
        console.error("[api/policies] publish failed:", publishError);
        sendJson(res, 503, {
          error: "policy_publish_failed",
          policy_id: policy.id,
          command_id: job.id
        });
      }
    } catch (error) {
      if (error?.code === "invalid_json") {
        sendJson(res, 400, { error: "invalid_json" });
        return;
      }
      if (error?.code === "payload_too_large") {
        sendJson(res, 413, { error: "payload_too_large" });
        return;
      }
      if (error?.code === "bad_request") {
        sendJson(res, 400, { error: error.message });
        return;
      }
      if (error?.code === "not_found") {
        sendJson(res, 404, { error: error.message });
        return;
      }
      console.error("[api/policies POST] failed:", error);
      sendJson(res, 500, { error: "policy_create_failed" });
    }
    return;
  }

  if (url.pathname.startsWith("/api/commands/") && req.method === "GET") {
    const principal = await authenticateRequest(req, res, { allowRoles: ["admin", "noc", "captain", "customer"] });
    if (!principal) {
      return;
    }
    const parts = url.pathname.split("/").filter(Boolean);
    if (parts.length !== 3) {
      sendJson(res, 400, { error: "invalid_path" });
      return;
    }

    try {
      const job = await getCommandJob(parts[2]);
      if (!job) {
        sendJson(res, 404, { error: "command_not_found" });
        return;
      }
      if (!assertScopedAccess(principal, { tenantCode: job.tenant_code, vesselCode: job.vessel_code })) {
        sendJson(res, 403, { error: "forbidden" });
        return;
      }
      sendJson(res, 200, job);
    } catch (error) {
      console.error("[api/commands/:id] failed:", error);
      sendJson(res, 500, { error: "command_job_failed" });
    }
    return;
  }

  if (url.pathname === "/api/mcu/edges" && req.method === "GET") {
    const principal = await authenticateRequest(req, res, { allowRoles: ["admin", "noc", "captain", "customer"] });
    if (!principal) {
      return;
    }
    const query = {
      tenantCode: url.searchParams.get("tenant") ?? url.searchParams.get("tenant_code"),
      vesselCode: url.searchParams.get("vessel") ?? url.searchParams.get("vessel_code"),
      wanIp:
        url.searchParams.get("wan_ip") ??
        url.searchParams.get("public_wan_ip") ??
        url.searchParams.get("public_ip") ??
        url.searchParams.get("ip"),
      limit: url.searchParams.get("limit"),
      offset: url.searchParams.get("offset"),
      after: url.searchParams.get("after"),
      onlineSeconds: url.searchParams.get("online_seconds")
    };

    try {
      const scopedQuery = scopeQueryByPrincipal(query, principal);
      const data = await listMcuEdges(scopedQuery);
      sendJson(res, 200, data);
    } catch (error) {
      if (error?.code === "bad_request") {
        sendJson(res, 400, { error: error.message });
        return;
      }
      console.error("[api/mcu/edges] failed:", error);
      sendJson(res, 500, { error: "mcu_edges_query_failed" });
    }
    return;
  }

  if (url.pathname === "/api/mcu/edges/by-wan" && req.method === "GET") {
    const principal = await authenticateRequest(req, res, { allowRoles: ["admin", "noc", "captain", "customer"] });
    if (!principal) {
      return;
    }
    try {
      const detail = await getMcuEdgeDetailByWanIp({
        publicWanIp:
          url.searchParams.get("wan_ip") ??
          url.searchParams.get("public_wan_ip") ??
          url.searchParams.get("public_ip") ??
          url.searchParams.get("ip"),
        onlineSeconds: url.searchParams.get("online_seconds")
      });

      if (!detail) {
        sendJson(res, 404, { error: "edge_not_found" });
        return;
      }

      if (!assertScopedAccess(principal, {
        tenantCode: detail.summary?.tenant_code ?? null,
        vesselCode: detail.summary?.vessel_code ?? null
      })) {
        sendJson(res, 403, { error: "forbidden" });
        return;
      }

      sendJson(res, 200, detail);
    } catch (error) {
      if (error?.code === "bad_request") {
        sendJson(res, 400, { error: error.message });
        return;
      }
      console.error("[api/mcu/edges/by-wan] failed:", error);
      sendJson(res, 500, { error: "mcu_edge_detail_failed" });
    }
    return;
  }

  if (url.pathname === "/api/mcu/traffic/by-wan" && req.method === "GET") {
    const principal = await authenticateRequest(req, res, { allowRoles: ["admin", "noc", "captain", "customer"] });
    if (!principal) {
      return;
    }
    try {
      const traffic = await getMcuEdgeTrafficByWanIp({
        publicWanIp:
          url.searchParams.get("wan_ip") ??
          url.searchParams.get("public_wan_ip") ??
          url.searchParams.get("public_ip") ??
          url.searchParams.get("ip"),
        interfaceName: url.searchParams.get("interface"),
        windowMinutes: url.searchParams.get("window_minutes"),
        limit: url.searchParams.get("limit")
      });

      if (!traffic) {
        sendJson(res, 404, { error: "edge_not_found" });
        return;
      }

      if (!assertScopedAccess(principal, {
        tenantCode: traffic.edge?.tenant_code ?? null,
        vesselCode: traffic.edge?.vessel_code ?? null
      })) {
        sendJson(res, 403, { error: "forbidden" });
        return;
      }

      sendJson(res, 200, traffic);
    } catch (error) {
      if (error?.code === "bad_request") {
        sendJson(res, 400, { error: error.message });
        return;
      }
      console.error("[api/mcu/traffic/by-wan] failed:", error);
      sendJson(res, 500, { error: "mcu_edge_traffic_failed" });
    }
    return;
  }

  if (url.pathname === "/api/telemetry" && req.method === "GET") {
    const principal = await authenticateRequest(req, res, { allowRoles: ["admin", "noc", "captain", "customer"] });
    if (!principal) {
      return;
    }

    try {
      const vesselCode = url.searchParams.get("vessel_code") ?? url.searchParams.get("vessel") ?? principal.vessel_code ?? "";
      const edgeCode = url.searchParams.get("edge_code") ?? url.searchParams.get("edge");
      const limit = url.searchParams.get("limit");
      const from = parseTimestampInput(url.searchParams.get("from"));
      const to = parseTimestampInput(url.searchParams.get("to"));

      if (!assertScopedAccess(principal, {
        tenantCode: principal.tenant_code ?? null,
        vesselCode
      })) {
        sendJson(res, 403, { error: "forbidden" });
        return;
      }

      const data = await listTelemetry({ vesselCode, edgeCode, limit, from, to });

      sendJson(res, 200, data);
    } catch (error) {
      if (error?.code === "bad_request") {
        sendJson(res, 400, { error: error.message });
        return;
      }
      console.error("[api/telemetry] failed:", error);
      sendJson(res, 500, { error: "telemetry_query_failed" });
    }
    return;
  }

  if (url.pathname === "/api/heartbeat/latest" && req.method === "GET") {
    const principal = await authenticateRequest(req, res, { allowRoles: ["admin", "noc", "captain", "customer"] });
    if (!principal) {
      return;
    }

    try {
      const edgeCode = url.searchParams.get("edge_code") ?? url.searchParams.get("edge");
      const vesselCode = url.searchParams.get("vessel_code") ?? url.searchParams.get("vessel");
      const tenantCode = url.searchParams.get("tenant_code") ?? url.searchParams.get("tenant");

      const heartbeat = await getLatestHeartbeat({ edgeCode, vesselCode, tenantCode });
      if (!heartbeat) {
        sendJson(res, 404, { error: "heartbeat_not_found" });
        return;
      }

      if (!assertScopedAccess(principal, { tenantCode: heartbeat.tenant_code, vesselCode: heartbeat.vessel_code })) {
        sendJson(res, 403, { error: "forbidden" });
        return;
      }

      sendJson(res, 200, heartbeat);
    } catch (error) {
      if (error?.code === "bad_request") {
        sendJson(res, 400, { error: error.message });
        return;
      }
      console.error("[api/heartbeat/latest] failed:", error);
      sendJson(res, 500, { error: "heartbeat_query_failed" });
    }
    return;
  }

  if (url.pathname === "/api/alerts" && req.method === "GET") {
    const principal = await authenticateRequest(req, res, { allowRoles: ["admin", "noc", "captain", "customer"] });
    if (!principal) {
      return;
    }

    try {
      const tenantCode = String(url.searchParams.get("tenant_code") ?? url.searchParams.get("tenant") ?? principal.tenant_code ?? "").trim() || null;
      const vesselCode = String(url.searchParams.get("vessel_code") ?? url.searchParams.get("vessel") ?? principal.vessel_code ?? "").trim() || null;
      const unreadOnly = parseBoolean(url.searchParams.get("unread"), false);
      const limit = Math.max(1, Math.min(500, toInt(url.searchParams.get("limit"), 100)));
      const offset = Math.max(0, toInt(url.searchParams.get("offset"), 0));

      if (!assertScopedAccess(principal, { tenantCode, vesselCode })) {
        sendJson(res, 403, { error: "forbidden" });
        return;
      }

      const alerts = await listAlerts({ tenantCode, vesselCode, unreadOnly, limit, offset });
      sendJson(res, 200, alerts);
    } catch (error) {
      console.error("[api/alerts GET] failed:", error);
      sendJson(res, 500, { error: "alerts_query_failed" });
    }
    return;
  }

  if (url.pathname.startsWith("/api/alerts/") && url.pathname.endsWith("/read") && req.method === "POST") {
    const principal = await authenticateRequest(req, res, { allowRoles: ["admin", "noc", "captain", "customer"] });
    if (!principal) {
      return;
    }

    try {
      const match = url.pathname.match(/^\/api\/alerts\/([^/]+)\/read$/);
      const alertId = match?.[1] ? decodeURIComponent(match[1]) : "";
      if (!alertId) {
        sendJson(res, 400, { error: "alert_id is required" });
        return;
      }

      const rowResult = await pool.query(
        `
          select
            e.id,
            t.code as tenant_code,
            v.code as vessel_code
          from events e
          join tenants t on t.id = e.tenant_id
          join vessels v on v.id = e.vessel_id
          where e.id = $1::uuid
          limit 1
        `,
        [alertId]
      );

      const target = rowResult.rows[0] ?? null;
      if (!target) {
        sendJson(res, 404, { error: "alert_not_found" });
        return;
      }

      if (!assertScopedAccess(principal, { tenantCode: target.tenant_code, vesselCode: target.vessel_code })) {
        sendJson(res, 403, { error: "forbidden" });
        return;
      }

      const updated = await markAlertRead({ alertId });
      if (!updated) {
        sendJson(res, 404, { error: "alert_not_found" });
        return;
      }

      sendJson(res, 200, { id: alertId, read: true });
    } catch (error) {
      console.error("[api/alerts/:id/read POST] failed:", error);
      sendJson(res, 500, { error: "alert_mark_read_failed" });
    }
    return;
  }

  if (url.pathname === "/api/traffic/summary" && req.method === "GET") {
    const principal = await authenticateRequest(req, res, { allowRoles: ["admin", "noc", "captain", "customer"] });
    if (!principal) {
      return;
    }

    try {
      const tenantCode = String(url.searchParams.get("tenant_code") ?? url.searchParams.get("tenant") ?? principal.tenant_code ?? "").trim() || null;
      const vesselCode = String(url.searchParams.get("vessel_code") ?? url.searchParams.get("vessel") ?? principal.vessel_code ?? "").trim();
      const month = String(url.searchParams.get("month") ?? "").trim() || null;

      if (!vesselCode) {
        sendJson(res, 400, { error: "vessel_code is required" });
        return;
      }

      if (!assertScopedAccess(principal, { tenantCode, vesselCode })) {
        sendJson(res, 403, { error: "forbidden" });
        return;
      }

      const summary = await getTrafficSummary({ tenantCode, vesselCode, month });
      if (!summary) {
        sendJson(res, 404, { error: "traffic_summary_not_found" });
        return;
      }

      sendJson(res, 200, summary);
    } catch (error) {
      if (error?.code === "bad_request") {
        sendJson(res, 400, { error: error.message });
        return;
      }
      console.error("[api/traffic/summary] failed:", error);
      sendJson(res, 500, { error: "traffic_summary_failed" });
    }
    return;
  }

  if (url.pathname === "/api/quota/remaining" && req.method === "GET") {
    const principal = await authenticateRequest(req, res, { allowRoles: ["admin", "noc", "captain", "customer"] });
    if (!principal) {
      return;
    }

    try {
      const tenantCode = String(url.searchParams.get("tenant_code") ?? url.searchParams.get("tenant") ?? principal.tenant_code ?? "").trim() || null;
      const vesselCode = String(url.searchParams.get("vessel_code") ?? url.searchParams.get("vessel") ?? principal.vessel_code ?? "").trim();

      if (!vesselCode) {
        sendJson(res, 400, { error: "vessel_code is required" });
        return;
      }

      if (!assertScopedAccess(principal, { tenantCode, vesselCode })) {
        sendJson(res, 403, { error: "forbidden" });
        return;
      }

      const quota = await getQuotaRemaining({ tenantCode, vesselCode });
      if (!quota) {
        sendJson(res, 404, { error: "quota_not_found" });
        return;
      }

      sendJson(res, 200, quota);
    } catch (error) {
      if (error?.code === "bad_request") {
        sendJson(res, 400, { error: error.message });
        return;
      }
      console.error("[api/quota/remaining] failed:", error);
      sendJson(res, 500, { error: "quota_remaining_failed" });
    }
    return;
  }

  if (url.pathname.startsWith("/api/mcu/edges/") && req.method === "GET") {
    const principal = await authenticateRequest(req, res, { allowRoles: ["admin", "noc", "captain", "customer"] });
    if (!principal) {
      return;
    }
    const parts = url.pathname.split("/").filter(Boolean);
    if (parts.length === 7 && parts[6] === "stream") {
      const tenantCode = parts[3];
      const vesselCode = parts[4];
      const edgeCode = parts[5];

      if (!assertScopedAccess(principal, { tenantCode, vesselCode })) {
        sendJson(res, 403, { error: "forbidden" });
        return;
      }

      try {
        await streamMcuTelemetry(req, res, { tenantCode, vesselCode, edgeCode });
      } catch (error) {
        console.error("[api/mcu/edges/stream] failed:", error);
        res.end();
      }
      return;
    }

    if (parts.length === 7 && parts[6] === "traffic") {
      const tenantCode = parts[3];
      const vesselCode = parts[4];
      const edgeCode = parts[5];

      if (!assertScopedAccess(principal, { tenantCode, vesselCode })) {
        sendJson(res, 403, { error: "forbidden" });
        return;
      }

      try {
        const traffic = await getMcuEdgeTraffic({
          tenantCode,
          vesselCode,
          edgeCode,
          interfaceName: url.searchParams.get("interface"),
          windowMinutes: url.searchParams.get("window_minutes"),
          limit: url.searchParams.get("limit")
        });

        if (!traffic) {
          sendJson(res, 404, { error: "edge_not_found" });
          return;
        }

        sendJson(res, 200, traffic);
      } catch (error) {
        console.error("[api/mcu/edges/:tenant/:vessel/:edge/traffic] failed:", error);
        sendJson(res, 500, { error: "mcu_edge_traffic_failed" });
      }
      return;
    }

    if (parts.length !== 6) {
      sendJson(res, 400, { error: "invalid_path" });
      return;
    }

    const tenantCode = parts[3];
    const vesselCode = parts[4];
    const edgeCode = parts[5];
    const onlineSeconds = url.searchParams.get("online_seconds");

    if (!assertScopedAccess(principal, { tenantCode, vesselCode })) {
      sendJson(res, 403, { error: "forbidden" });
      return;
    }

    try {
      const detail = await getMcuEdgeDetail({
        tenantCode,
        vesselCode,
        edgeCode,
        onlineSeconds
      });

      if (!detail) {
        sendJson(res, 404, { error: "edge_not_found" });
        return;
      }

      sendJson(res, 200, detail);
    } catch (error) {
      console.error("[api/mcu/edges/:tenant/:vessel/:edge] failed:", error);
      sendJson(res, 500, { error: "mcu_edge_detail_failed" });
    }
    return;
  }

  if (url.pathname === "/api/mcu/register" && req.method === "POST") {
    try {
      const body = await readJsonBody(req);
      if (!validateRegisterAccess(req, res, body, url)) {
        return;
      }

      const requestIp = getRequestIp(req);
      const result = await registerMcuEdge({
        ...body,
        detected_public_wan_ip: requestIp,
        request_ip: requestIp
      });
      sendJson(res, 201, {
        ok: true,
        ...result
      });
    } catch (error) {
      if (error?.code === "invalid_json") {
        sendJson(res, 400, { error: "invalid_json" });
        return;
      }
      if (error?.code === "payload_too_large") {
        sendJson(res, 413, { error: "payload_too_large" });
        return;
      }
      if (error?.code === "bad_request") {
        sendJson(res, 400, { error: error.message });
        return;
      }
      console.error("[api/mcu/register] failed:", error);
      sendJson(res, 500, { error: "mcu_register_failed" });
    }
    return;
  }


  // =============================================
  // PHASE 3 - PACKAGES ROUTES
  // =============================================
  if (url.pathname === "/api/packages" && req.method === "GET") {
    const principal = await authenticateRequest(req, res, { allowRoles: ["admin", "noc"] });
    if (!principal) return;
    try {
      const tenantCode = url.searchParams.get("tenant_code") ?? url.searchParams.get("tenant") ?? null;
      const includeInactive = parseBoolean(url.searchParams.get("include_inactive"), false);
      const result = await pool.query(
        `
          select
            p.id,
            coalesce(p.tenant_code, t.code) as tenant_code,
            t.name as tenant_name,
            p.code,
            p.name,
            p.description,
            p.quota_mb,
            coalesce(p.validity_days, p.duration_days) as validity_days,
            p.price_usd,
            p.is_active,
            p.speed_limit_kbps,
            p.duration_days,
            p.updated_at,
            p.created_at
          from packages p
          join tenants t on t.id = p.tenant_id
          where ($1::text is null or t.code = $1)
            and ($2::boolean = true or p.is_active = true)
          order by p.is_active desc, p.created_at desc, p.name asc
        `,
        [tenantCode, includeInactive]
      );
      sendJson(res, 200, result.rows);
    } catch (err) {
      console.error("[api/packages GET] failed:", err);
      sendJson(res, 500, { error: "packages_query_failed" });
    }
    return;
  }

  if (url.pathname === "/api/packages" && req.method === "POST") {
    const principal = await authenticateRequest(req, res, { allowRoles: ["admin", "noc"] });
    if (!principal) return;
    try {
      const body = await readJsonBody(req);
      const tenantCode = String(body.tenant_code ?? body.tenant ?? "").trim();
      const code = String(body.code ?? body.package_code ?? "").trim();
      const name = String(body.name ?? "").trim();
      const description = String(body.description ?? "").trim();
      const quotaMb = Number(body.quota_mb ?? body.quota ?? 0);
      const speedLimitKbps = body.speed_limit_kbps !== undefined && body.speed_limit_kbps !== null && body.speed_limit_kbps !== ""
        ? Number(body.speed_limit_kbps)
        : null;
      const validityDays = Number(body.validity_days ?? body.duration_days ?? 0);
      const priceUsd = body.price_usd !== undefined && body.price_usd !== null && body.price_usd !== ""
        ? Number(body.price_usd)
        : 0;
      const isActive = body.is_active === undefined || body.is_active === null || body.is_active === ""
        ? true
        : parseBoolean(body.is_active, true);

      if (!tenantCode || !name || !Number.isFinite(quotaMb) || quotaMb <= 0 || !Number.isFinite(validityDays) || validityDays <= 0) {
        sendJson(res, 400, { error: "tenant_code, name, quota_mb, validity_days are required" });
        return;
      }

      const tenantResult = await pool.query(
        "select id, code, name from tenants where code = $1 limit 1",
        [tenantCode]
      );
      const tenant = tenantResult.rows[0];
      if (!tenant) {
        sendJson(res, 404, { error: "tenant_not_found" });
        return;
      }

      const result = await pool.query(
        `
          insert into packages (
            tenant_id,
            tenant_code,
            code,
            name,
            description,
            quota_mb,
            validity_days,
            price_usd,
            is_active,
            speed_limit_kbps,
            duration_days
          )
          values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
          on conflict (tenant_id, code)
          do update set
            tenant_code = excluded.tenant_code,
            name = excluded.name,
            description = excluded.description,
            quota_mb = excluded.quota_mb,
            validity_days = excluded.validity_days,
            price_usd = excluded.price_usd,
            is_active = excluded.is_active,
            speed_limit_kbps = excluded.speed_limit_kbps,
            duration_days = excluded.duration_days,
            updated_at = now()
          returning id, tenant_code, code, name, description, quota_mb, validity_days, price_usd, is_active, speed_limit_kbps, duration_days, updated_at, created_at
        `,
        [
          tenant.id,
          tenant.code,
          code || name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "package",
          name,
          description || null,
          quotaMb,
          validityDays,
          priceUsd,
          isActive,
          speedLimitKbps,
          validityDays
        ]
      );
      await insertPackageAuditEvent({
        tenantCode: tenant.code,
        packageId: result.rows[0]?.id ?? null,
        packageCode: result.rows[0]?.code ?? code,
        actionType: "package_create",
        actor: principal,
        afterPayload: result.rows[0] ?? null
      });
      sendJson(res, 201, result.rows[0]);
    } catch (err) {
      console.error("[api/packages POST] failed:", err);
      sendJson(res, 500, { error: "package_create_failed" });
    }
    return;
  }

  if (url.pathname.startsWith("/api/packages/") && url.pathname.endsWith("/assign") && req.method === "POST") {
    const principal = await authenticateRequest(req, res, { allowRoles: ["admin", "noc"] });
    if (!principal) return;
    const id = url.pathname.split("/")[3];
    try {
      const body = await readJsonBody(req);
      const { user_id } = body;
      const username = String(body.username ?? body.user_name ?? "").trim();
      const vesselCode = String(body.vessel_code ?? body.vessel ?? "").trim();
      if (!vesselCode) {
        sendJson(res, 400, { error: "vessel_code is required" });
        return;
      }

      const packageResult = await pool.query(
        `
          select p.id, p.tenant_id, t.code as tenant_code, p.quota_mb, coalesce(p.validity_days, p.duration_days) as validity_days
          from packages p
          join tenants t on t.id = p.tenant_id
          where p.id = $1
            and p.is_active = true
          limit 1
        `,
        [id]
      );
      const packageRow = packageResult.rows[0];
      if (!packageRow) {
        sendJson(res, 404, { error: "package_not_found" });
        return;
      }

      let resolvedUserId = user_id ? String(user_id).trim() : "";
      if (!resolvedUserId) {
        if (!username) {
          sendJson(res, 400, { error: "user_id or username is required" });
          return;
        }
        const userResult = await pool.query(
          `
            select id
            from users
            where tenant_id = $1
              and lower(username) = lower($2)
            order by created_at asc
            limit 1
          `,
          [packageRow.tenant_id, username]
        );
        resolvedUserId = userResult.rows[0]?.id ?? "";
      }

      if (!resolvedUserId) {
        sendJson(res, 404, { error: "user_not_found" });
        return;
      }

      const result = await pool.query(
        `
          insert into package_assignments (user_id, package_id, vessel_code, remaining_mb, expires_at, status)
          values ($1::uuid, $2::uuid, $3::text, $4::bigint, now() + ($5::text || ' days')::interval, 'active')
          on conflict (user_id, vessel_code)
          do update set
            package_id = excluded.package_id,
            remaining_mb = excluded.remaining_mb,
            expires_at = excluded.expires_at,
            status = 'active',
            is_active = true
          returning *
        `,
        [resolvedUserId, packageRow.id, vesselCode, packageRow.quota_mb, String(packageRow.validity_days || 30)]
      );

      await syncPackageQuotaForAssignment({
        tenantCode: packageRow.tenant_code ?? null,
        vesselCode,
        packageId: packageRow.id,
        quotaGb: Number(packageRow.quota_mb ?? 0) / 1024,
        resetDayOfMonth: 1
      });

      await insertPackageAuditEvent({
        tenantCode: packageResult.rows[0]?.tenant_code ?? null,
        packageId: packageRow.id,
        packageCode: packageResult.rows[0]?.code ?? null,
        vesselCode,
        username: username || null,
        actionType: "package_assign",
        actor: principal,
        afterPayload: result.rows[0] ?? null
      });
      sendJson(res, 201, result.rows[0]);
    } catch (err) {
      console.error("[api/packages/assign POST] failed:", err);
      sendJson(res, 500, { error: "package_assign_failed" });
    }
    return;
  }

  if (url.pathname.startsWith("/api/packages/") && !url.pathname.endsWith("/assign") && req.method === "PATCH") {
    const principal = await authenticateRequest(req, res, { allowRoles: ["admin", "noc"] });
    if (!principal) return;
    const id = url.pathname.split("/")[3];
    try {
      const body = await readJsonBody(req);
      const existingResult = await pool.query(
        `
          select
            p.id,
            p.tenant_id,
            t.code as tenant_code,
            p.code,
            p.name,
            p.description,
            p.quota_mb,
            coalesce(p.validity_days, p.duration_days) as validity_days,
            p.price_usd,
            p.is_active,
            p.speed_limit_kbps,
            p.duration_days
          from packages p
          join tenants t on t.id = p.tenant_id
          where p.id = $1
          limit 1
        `,
        [id]
      );
      const existing = existingResult.rows[0];
      if (!existing) {
        sendJson(res, 404, { error: "package_not_found" });
        return;
      }

      const requestedTenantCode = String(body.tenant_code ?? body.tenant ?? "").trim();
      if (requestedTenantCode && requestedTenantCode !== existing.tenant_code) {
        sendJson(res, 400, { error: "package_tenant_immutable" });
        return;
      }

      const nextCode = String(body.code ?? body.package_code ?? existing.code ?? "").trim() || existing.code;
      const nextName = String(body.name ?? existing.name ?? "").trim() || existing.name;
      const nextDescription = body.description === undefined
        ? existing.description
        : String(body.description ?? "").trim() || null;

      const quotaInput = body.quota_mb ?? body.quota;
      const validityInput = body.validity_days ?? body.duration_days;
      const priceInput = body.price_usd;
      const speedInput = body.speed_limit_kbps;
      const isActiveInput = body.is_active;

      const nextQuotaMb = quotaInput === undefined || quotaInput === null || quotaInput === ""
        ? Number(existing.quota_mb ?? 0)
        : Number(quotaInput);
      const nextValidityDays = validityInput === undefined || validityInput === null || validityInput === ""
        ? Number(existing.validity_days ?? existing.duration_days ?? 0)
        : Number(validityInput);
      const nextPriceUsd = priceInput === undefined || priceInput === null || priceInput === ""
        ? Number(existing.price_usd ?? 0)
        : Number(priceInput);
      const nextSpeedLimit = speedInput === undefined || speedInput === null || speedInput === ""
        ? (existing.speed_limit_kbps === null || existing.speed_limit_kbps === undefined ? null : Number(existing.speed_limit_kbps))
        : Number(speedInput);
      const nextIsActive = isActiveInput === undefined || isActiveInput === null || isActiveInput === ""
        ? Boolean(existing.is_active)
        : parseBoolean(isActiveInput, Boolean(existing.is_active));

      if (!nextCode || !nextName || !Number.isFinite(nextQuotaMb) || nextQuotaMb < 0 || !Number.isFinite(nextValidityDays) || nextValidityDays <= 0 || !Number.isFinite(nextPriceUsd) || (nextSpeedLimit !== null && !Number.isFinite(nextSpeedLimit))) {
        sendJson(res, 400, { error: "invalid_package_payload" });
        return;
      }

      const result = await pool.query(
        `
          update packages
          set
            code = $2,
            name = $3,
            description = $4,
            quota_mb = $5::bigint,
            validity_days = $6::int,
            price_usd = $7::numeric(10,2),
            is_active = $8::boolean,
            speed_limit_kbps = $9::int,
            duration_days = $6::int,
            updated_at = now()
          where id = $1::uuid
          returning id, tenant_code, code, name, description, quota_mb, validity_days, price_usd, is_active, speed_limit_kbps, duration_days, updated_at, created_at
        `,
        [
          id,
          nextCode,
          nextName,
          nextDescription,
          nextQuotaMb,
          nextValidityDays,
          nextPriceUsd,
          nextIsActive,
          nextSpeedLimit
        ]
      );

      await insertPackageAuditEvent({
        tenantCode: existing.tenant_code,
        packageId: id,
        packageCode: result.rows[0]?.code ?? nextCode,
        actionType: nextIsActive ? "package_update" : "package_archive_toggle",
        actor: principal,
        beforePayload: existing,
        afterPayload: result.rows[0] ?? null
      });

      if (!nextIsActive) {
        await pool.query(
          `
            update package_assignments
            set
              status = 'cancelled',
              is_active = false
            where package_id = $1::uuid
              and is_active = true
          `,
          [id]
        );
      }

      sendJson(res, 200, result.rows[0]);
    } catch (err) {
      if (err?.code === "23505") {
        sendJson(res, 409, { error: "package_conflict" });
        return;
      }
      console.error("[api/packages PATCH] failed:", err);
      sendJson(res, 500, { error: "package_update_failed" });
    }
    return;
  }

  if (url.pathname === "/api/package-assignments" && req.method === "GET") {
    const principal = await authenticateRequest(req, res, { allowRoles: ["admin", "noc"] });
    if (!principal) return;
    try {
      const tenantCode = url.searchParams.get("tenant_code") ?? url.searchParams.get("tenant") ?? null;
      const vesselCode = url.searchParams.get("vessel_code") ?? url.searchParams.get("vessel") ?? null;
      const username = url.searchParams.get("username") ?? null;
      const status = url.searchParams.get("status") ?? null;
      const packageCode = url.searchParams.get("package_code") ?? null;
      const activeOnly = parseBoolean(url.searchParams.get("active_only"), true);
      const limit = Math.max(1, Math.min(200, toInt(url.searchParams.get("limit"), 50)));
      const offset = Math.max(0, toInt(url.searchParams.get("offset"), 0));
      const after = url.searchParams.get("after") ?? null;

      const result = await pool.query(
        `
          select
            pa.id,
            pa.user_id,
            u.username,
            t.code as tenant_code,
            v.code as vessel_code,
            p.id as package_id,
            p.code as package_code,
            p.name as package_name,
            pa.assigned_at,
            pa.expires_at,
            pa.remaining_mb,
            pa.status,
            pa.is_active
          from package_assignments pa
          join users u on u.id = pa.user_id
          join packages p on p.id = pa.package_id
          join tenants t on t.id = p.tenant_id
          left join vessels v on v.tenant_id = t.id and v.code = pa.vessel_code
          where ($1::text is null or t.code = $1)
            and ($2::text is null or pa.vessel_code = $2)
            and ($3::text is null or lower(u.username) = lower($3))
            and ($4::text is null or pa.status = $4)
            and ($5::text is null or p.code = $5)
            and ($6::boolean = false or pa.is_active = true)
            and ($7::timestamptz is null or pa.assigned_at < $7::timestamptz)
          order by pa.assigned_at desc
          offset $8
          limit $9
        `,
        [tenantCode, vesselCode, username, status, packageCode, activeOnly, after, offset, limit]
      );

      sendJson(res, 200, {
        items: result.rows,
        total: result.rowCount,
        limit,
        offset,
        next_after: result.rows.at(-1)?.assigned_at ?? null
      });
    } catch (err) {
      console.error("[api/package-assignments GET] failed:", err);
      sendJson(res, 500, { error: "package_assignments_query_failed" });
    }
    return;
  }

  if (url.pathname.startsWith("/api/package-assignments/") && req.method === "DELETE") {
    const principal = await authenticateRequest(req, res, { allowRoles: ["admin", "noc"] });
    if (!principal) return;
    const assignmentId = url.pathname.split("/")[3];
    try {
      const result = await pool.query(
        `
          with updated as (
            update package_assignments
            set
              status = 'cancelled',
              is_active = false
            where id = $1::uuid
            returning id, user_id, package_id, vessel_code, remaining_mb, status, is_active, assigned_at, expires_at
          )
          select
            upd.id,
            upd.user_id,
            upd.package_id,
            upd.vessel_code,
            upd.remaining_mb,
            upd.status,
            upd.is_active,
            upd.assigned_at,
            upd.expires_at,
            p.code as package_code,
            t.code as tenant_code,
            u.username
          from updated upd
          join packages p on p.id = upd.package_id
          join tenants t on t.id = p.tenant_id
          join users u on u.id = upd.user_id
        `,
        [assignmentId]
      );

      if (!result.rowCount) {
        sendJson(res, 404, { error: "assignment_not_found" });
        return;
      }

      await insertPackageAuditEvent({
        tenantCode: result.rows[0]?.tenant_code ?? null,
        packageId: result.rows[0]?.package_id ?? null,
        packageCode: result.rows[0]?.package_code ?? null,
        vesselCode: result.rows[0]?.vessel_code ?? null,
        username: result.rows[0]?.username ?? null,
        actionType: "package_unassign",
        actor: principal,
        beforePayload: result.rows[0],
        afterPayload: {
          ...result.rows[0],
          status: "cancelled",
          is_active: false
        }
      });

      sendJson(res, 200, result.rows[0]);
    } catch (err) {
      console.error("[api/package-assignments DELETE] failed:", err);
      sendJson(res, 500, { error: "package_unassign_failed" });
    }
    return;
  }

  if (url.pathname.startsWith("/api/package-assignments/") && req.method === "GET") {
    const principal = await authenticateRequest(req, res, { allowRoles: ["admin", "noc"] });
    if (!principal) return;
    const assignmentId = url.pathname.split("/")[3];
    try {
      const assignmentResult = await pool.query(
        `
          select
            pa.id,
            pa.user_id,
            u.username,
            t.code as tenant_code,
            t.name as tenant_name,
            pa.vessel_code,
            p.id as package_id,
            p.code as package_code,
            p.name as package_name,
            p.description,
            p.quota_mb,
            p.price_usd,
            p.is_active as package_active,
            pa.assigned_at,
            pa.expires_at,
            pa.remaining_mb,
            pa.status,
            pa.is_active
          from package_assignments pa
          join users u on u.id = pa.user_id
          join packages p on p.id = pa.package_id
          join tenants t on t.id = p.tenant_id
          where pa.id = $1::uuid
          limit 1
        `,
        [assignmentId]
      );

      const assignment = assignmentResult.rows[0];
      if (!assignment) {
        sendJson(res, 404, { error: "assignment_not_found" });
        return;
      }

      const [usageSummary, recentUsage, auditHistory, alerts] = await Promise.all([
        pool.query(
          `
            select
              coalesce(sum(upload_mb), 0)::numeric(14,3) as upload_mb,
              coalesce(sum(download_mb), 0)::numeric(14,3) as download_mb,
              coalesce(sum(total_mb), 0)::numeric(14,3) as total_mb,
              count(*)::int as samples,
              max(observed_at) as latest_usage_at
            from user_usage
            where package_assignment_id = $1::uuid
          `,
          [assignmentId]
        ),
        pool.query(
          `
            select
              observed_at,
              username,
              vessel_code,
              upload_mb,
              download_mb,
              total_mb,
              session_id
            from user_usage
            where package_assignment_id = $1::uuid
            order by observed_at desc
            limit 20
          `,
          [assignmentId]
        ),
        pool.query(
          `
            select
              created_at,
              action_type,
              actor_username,
              actor_role,
              before_payload,
              after_payload
            from package_audit_events
            where package_id = $1::uuid
              and ($2::text is null or username is null or lower(username) = lower($2))
              and ($3::text is null or vessel_code is null or vessel_code = $3)
            order by created_at desc
            limit 20
          `,
          [assignment.package_id, assignment.username, assignment.vessel_code]
        ),
        pool.query(
          `
            select created_at, alert_type, message, remaining_mb
            from alerts
            where username = $1::text
              and vessel_code = $2::text
            order by created_at desc
            limit 20
          `,
          [assignment.username, assignment.vessel_code]
        )
      ]);

      sendJson(res, 200, {
        assignment,
        usage_summary: usageSummary.rows[0] ?? {},
        recent_usage: recentUsage.rows,
        audit_history: auditHistory.rows,
        alerts: alerts.rows
      });
    } catch (err) {
      console.error("[api/package-assignments/:id GET] failed:", err);
      sendJson(res, 500, { error: "package_assignment_detail_failed" });
    }
    return;
  }

  if (url.pathname === "/api/package-audit" && req.method === "GET") {
    const principal = await authenticateRequest(req, res, { allowRoles: ["admin", "noc"] });
    if (!principal) return;
    try {
      const tenantCode = url.searchParams.get("tenant_code") ?? url.searchParams.get("tenant") ?? null;
      const packageCode = url.searchParams.get("package_code") ?? url.searchParams.get("package") ?? null;
      const vesselCode = url.searchParams.get("vessel_code") ?? url.searchParams.get("vessel") ?? null;
      const username = url.searchParams.get("username") ?? null;
      const actionType = url.searchParams.get("action_type") ?? url.searchParams.get("action") ?? null;
      const dateFrom = parseDateInput(url.searchParams.get("date_from"));
      const dateTo = parseDateInput(url.searchParams.get("date_to"), { endOfDay: true });
      const limit = Math.max(1, Math.min(200, toInt(url.searchParams.get("limit"), 50)));
      const offset = Math.max(0, toInt(url.searchParams.get("offset"), 0));
      const after = parseDateInput(url.searchParams.get("after"));

      const conditions = [];
      const params = [];
      const addCondition = (sql, value) => {
        params.push(value);
        conditions.push(sql.replace("$", `$${params.length}`));
      };

      if (dateFrom || dateTo) {
        addCondition("created_at >= $::timestamptz", dateFrom ?? "1970-01-01T00:00:00.000Z");
        addCondition("created_at <= $::timestamptz", dateTo ?? new Date().toISOString());
      }
      if (tenantCode) addCondition("tenant_code = $", tenantCode);
      if (packageCode) addCondition("package_code = $", packageCode);
      if (vesselCode) addCondition("vessel_code = $", vesselCode);
      if (username) addCondition("lower(username) = lower($)", username);
      if (actionType) addCondition("action_type = $", actionType);
      if (after) addCondition("created_at < $::timestamptz", after);

      params.push(offset);
      params.push(limit);
      const query = `
        select
          id,
          tenant_code,
          package_id,
          package_code,
          vessel_code,
          username,
          action_type,
          actor_user_id,
          actor_username,
          actor_role,
          before_payload,
          after_payload,
          created_at
        from package_audit_events
        ${conditions.length ? `where ${conditions.join(" and ")}` : ""}
        order by created_at desc
        offset $${params.length - 1}
        limit $${params.length}
      `;
      const result = await pool.query(query, params);
      sendJson(res, 200, {
        total: result.rowCount,
        items: result.rows,
        limit,
        offset,
        next_after: result.rows.at(-1)?.created_at ?? null
      });
    } catch (err) {
      console.error("[api/package-audit GET] failed:", err);
      sendJson(res, 500, { error: "package_audit_query_failed" });
    }
    return;
  }

  if (url.pathname === "/api/reports/usage/export" && req.method === "GET") {
    const principal = await authenticateRequest(req, res, { allowRoles: ["admin", "noc"] });
    if (!principal) return;
    try {
      const scope = buildUsageReportFilterState(url);
      const result = await pool.query(
        `
          select
            uu.observed_at,
            uu.tenant_code,
            uu.vessel_code,
            uu.username,
            coalesce(p.code, 'unassigned') as package_code,
            coalesce(p.name, 'Unassigned') as package_name,
            uu.session_id,
            uu.upload_mb,
            uu.download_mb,
            uu.total_mb,
            pa.remaining_mb,
            pa.status,
            pa.id as package_assignment_id
          from user_usage uu
          left join package_assignments pa on pa.id = uu.package_assignment_id
          left join packages p on p.id = pa.package_id
          ${scope.whereClause}
          order by uu.observed_at desc
          limit 5000
        `,
        scope.params
      );

      const header = [
        "observed_at",
        "tenant_code",
        "vessel_code",
        "username",
        "package_code",
        "package_name",
        "session_id",
        "upload_mb",
        "download_mb",
        "total_mb",
        "remaining_mb",
        "status",
        "package_assignment_id"
      ];
      const csv = [
        header.map(escapeCsvValue).join(","),
        ...result.rows.map((row) => header.map((key) => escapeCsvValue(row[key])).join(","))
      ].join("\n");

      res.writeHead(200, {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": 'attachment; filename="usage-report.csv"',
        "cache-control": "no-store"
      });
      res.end(csv);
    } catch (err) {
      console.error("[api/reports/usage/export GET] failed:", err);
      sendJson(res, 500, { error: "usage_export_failed" });
    }
    return;
  }

  if (url.pathname === "/api/reports/usage" && req.method === "GET") {
    const principal = await authenticateRequest(req, res, { allowRoles: ["admin", "noc"] });
    if (!principal) return;
    try {
      const scope = buildUsageReportFilterState(url);
      const packageJoin = "left join package_assignments pa on pa.id = uu.package_assignment_id left join packages p on p.id = pa.package_id";

      const summaryResult = await pool.query(
        `
          select
            coalesce(sum(uu.upload_mb), 0)::numeric(14,3) as upload_mb,
            coalesce(sum(uu.download_mb), 0)::numeric(14,3) as download_mb,
            coalesce(sum(uu.total_mb), 0)::numeric(14,3) as total_mb,
            count(*)::int as samples,
            count(distinct uu.username)::int as users,
            count(distinct uu.vessel_code)::int as vessels,
            count(distinct uu.package_assignment_id)::int as assignments,
            count(distinct p.code)::int as packages
          from user_usage uu
          ${packageJoin}
          ${scope.whereClause}
        `,
        scope.params
      );

      const topUsersResult = await pool.query(
        `
          select
            uu.username,
            uu.vessel_code,
            coalesce(p.code, 'unassigned') as package_code,
            coalesce(p.name, 'Unassigned') as package_name,
            sum(uu.upload_mb)::numeric(14,3) as upload_mb,
            sum(uu.download_mb)::numeric(14,3) as download_mb,
            sum(uu.total_mb)::numeric(14,3) as total_mb,
            max(uu.observed_at) as last_seen
          from user_usage uu
          left join package_assignments pa on pa.id = uu.package_assignment_id
          left join packages p on p.id = pa.package_id
          ${scope.whereClause}
          group by uu.username, uu.vessel_code, p.code, p.name
          order by sum(uu.total_mb) desc, uu.username asc
          limit 20
        `,
        scope.params
      );

      const topPackagesResult = await pool.query(
        `
          select
            coalesce(p.code, 'unassigned') as package_code,
            coalesce(p.name, 'Unassigned') as package_name,
            sum(uu.total_mb)::numeric(14,3) as total_mb,
            count(distinct uu.username)::int as user_count
          from user_usage uu
          left join package_assignments pa on pa.id = uu.package_assignment_id
          left join packages p on p.id = pa.package_id
          ${scope.whereClause}
          group by p.code, p.name
          order by sum(uu.total_mb) desc, package_name asc
          limit 20
        `,
        scope.params
      );

      const activeAssignmentsResult = await pool.query(
        `
          select
            pa.id,
            pa.user_id,
            u.username,
            t.code as tenant_code,
            pa.vessel_code,
            p.code as package_code,
            p.name as package_name,
            pa.remaining_mb,
            pa.status,
            pa.expires_at,
            pa.assigned_at
          from package_assignments pa
          join users u on u.id = pa.user_id
          join packages p on p.id = pa.package_id
          join tenants t on t.id = p.tenant_id
          where pa.is_active = true
            and ($1::text is null or t.code = $1)
            and ($2::text is null or pa.vessel_code = $2)
            and ($3::text is null or lower(u.username) = lower($3))
            and ($4::text is null or p.code = $4)
          order by pa.assigned_at desc
          limit 50
        `,
        [scope.tenantCode, scope.vesselCode, scope.username, scope.packageCode]
      );

      const recentAlertsResult = await pool.query(
        `
          select
            created_at,
            tenant_code,
            vessel_code,
            username,
            alert_type,
            message,
            remaining_mb
          from alerts
          where created_at >= now() - ($1::int || ' minutes')::interval
            and ($2::text is null or tenant_code = $2)
            and ($3::text is null or vessel_code = $3)
            and ($4::text is null or lower(username) = lower($4))
          order by created_at desc
          limit 20
        `,
        [scope.windowMinutes, scope.tenantCode, scope.vesselCode, scope.username]
      );

      const timelineResult = await pool.query(
        `
          select
            date_trunc('${scope.bucket}', uu.observed_at) as bucket_at,
            coalesce(sum(uu.upload_mb), 0)::numeric(14,3) as upload_mb,
            coalesce(sum(uu.download_mb), 0)::numeric(14,3) as download_mb,
            coalesce(sum(uu.total_mb), 0)::numeric(14,3) as total_mb,
            count(*)::int as samples
          from user_usage uu
          left join package_assignments pa on pa.id = uu.package_assignment_id
          left join packages p on p.id = pa.package_id
          ${scope.whereClause}
          group by 1
          order by 1 asc
          limit 500
        `,
        scope.params
      );

      sendJson(res, 200, {
        window_minutes: scope.windowMinutes,
        date_from: scope.dateFrom,
        date_to: scope.dateTo,
        bucket: scope.bucket,
        summary: summaryResult.rows[0] ?? {},
        top_users: topUsersResult.rows,
        top_packages: topPackagesResult.rows,
        active_assignments: activeAssignmentsResult.rows,
        recent_alerts: recentAlertsResult.rows,
        timeline: timelineResult.rows
      });
    } catch (err) {
      console.error("[api/reports/usage GET] failed:", err);
      sendJson(res, 500, { error: "usage_report_failed" });
    }
    return;
  }

  sendJson(res, 404, { error: "not_found" });
});

server.requestTimeout = apiConfig.serverRequestTimeoutMs;
server.keepAliveTimeout = apiConfig.serverKeepAliveTimeoutMs;
server.headersTimeout = apiConfig.serverHeadersTimeoutMs;

const port = Number(process.env.PORT || 3000);
const host = process.env.HOST || "0.0.0.0";
attachRealtimeServer(server);
ensureTrafficHourlyCron().catch((error) => {
  console.error("[api] failed to start traffic hourly cron:", error);
});
server.listen(port, host, () => {
  console.log(`[api] listening on http://${host}:${port}`);
});
