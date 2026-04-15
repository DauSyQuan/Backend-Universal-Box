import "dotenv/config";
import { createHmac, pbkdf2Sync, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { isIP } from "node:net";
import mqtt from "mqtt";
import { getHealth, getReady } from "./health.js";
import { pingDb, pool } from "./db.js";
import {
  createCommandJob,
  getMcuEdgeDetail,
  getMcuEdgeDetailByWanIp,
  getMcuEdgeTraffic,
  getMcuEdgeTrafficByWanIp,
  getCommandJob,
  listMcuEdges,
  listCommandJobs,
  markCommandJobStatus,
  registerMcuEdge,
  streamMcuTelemetry
} from "./mcu.js";
import { maybeServeStatic } from "./static.js";

const mqttUrl = process.env.MQTT_URL || "mqtt://localhost:1883";
const mqttClient = mqtt.connect(mqttUrl, {
  username: process.env.MQTT_USERNAME || undefined,
  password: process.env.MQTT_PASSWORD || undefined
});

const booleanTrueValues = new Set(["1", "true", "yes", "on"]);
const booleanFalseValues = new Set(["0", "false", "no", "off"]);

function parseBoolean(value, fallback = false) {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }

  const normalized = String(value).trim().toLowerCase();
  if (booleanTrueValues.has(normalized)) {
    return true;
  }
  if (booleanFalseValues.has(normalized)) {
    return false;
  }
  return fallback;
}

function normalizeSecret(value) {
  if (value === undefined || value === null) {
    return "";
  }
  return String(value).trim();
}

const basicAuthEnabled = parseBoolean(process.env.BASIC_AUTH_ENABLED, true);
const basicAuthUsername = normalizeSecret(process.env.BASIC_AUTH_USERNAME) || "demo";
const generatedBasicAuthPassword = basicAuthEnabled && !normalizeSecret(process.env.BASIC_AUTH_PASSWORD)
  ? randomBytes(18).toString("base64url")
  : null;
const basicAuthPassword = generatedBasicAuthPassword ?? normalizeSecret(process.env.BASIC_AUTH_PASSWORD);
const basicAuthRole = normalizeSecret(process.env.BASIC_AUTH_ROLE) || "admin";
const authTokenSecret = normalizeSecret(process.env.AUTH_TOKEN_SECRET || process.env.JWT_SECRET || basicAuthPassword || "mcu-dev-auth-secret");
const authTokenTtlSeconds = Math.max(300, Number(process.env.AUTH_TOKEN_TTL_SECONDS || "3600"));
const trustProxyHeaders = parseBoolean(process.env.TRUST_PROXY_HEADERS, false);
const mcuRegisterEnabled = parseBoolean(process.env.MCU_REGISTER_ENABLED, false);
const mcuRegisterToken = normalizeSecret(process.env.MCU_REGISTER_TOKEN);

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

function safeEqual(left, right) {
  const leftBuffer = Buffer.from(String(left ?? ""), "utf8");
  const rightBuffer = Buffer.from(String(right ?? ""), "utf8");
  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }
  return timingSafeEqual(leftBuffer, rightBuffer);
}

function requiresBasicAuth(pathname) {
  if (!basicAuthEnabled) {
    return false;
  }

  return !(
    pathname === "/api/health" ||
    pathname === "/api/ready" ||
    pathname === "/api/auth/login" ||
    pathname === "/api/auth/refresh" ||
    pathname === "/api/auth/logout" ||
    pathname === "/api/mcu/register"
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

  if (requiresBasicAuth(url.pathname) && !getHeaderValue(req.headers, "authorization")) {
    sendBasicAuthChallenge(res);
    return;
  }

  if (await maybeServeStatic(req, res, url)) {
    return;
  }

  if (url.pathname === "/api/health" && req.method === "GET") {
    sendJson(res, 200, getHealth());
    return;
  }

  if (url.pathname === "/api/ready" && req.method === "GET") {
    try {
      const database = await pingDb();
      const ready = getReady({ database });
      sendJson(res, database ? 200 : 503, ready);
    } catch {
      sendJson(res, 503, getReady({ database: false }));
    }
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
        limit: url.searchParams.get("limit")
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

  sendJson(res, 404, { error: "not_found" });
});

const port = Number(process.env.PORT || 3000);
const host = process.env.HOST || "0.0.0.0";

server.listen(port, host, () => {
  console.log(`[api] listening on http://${host}:${port}`);
  if (basicAuthEnabled) {
    if (generatedBasicAuthPassword) {
      console.warn(
        `[api] basic auth enabled. Generated one-time credentials ${basicAuthUsername}:${generatedBasicAuthPassword}`
      );
    } else {
      console.log(`[api] basic auth enabled for user ${basicAuthUsername}`);
    }
  } else {
    console.warn("[api] basic auth disabled");
  }

  if (mcuRegisterEnabled) {
    console.log("[api] /api/mcu/register enabled with token protection");
  } else {
    console.warn("[api] /api/mcu/register disabled until MCU_REGISTER_ENABLED=true");
  }

  if (trustProxyHeaders) {
    console.log("[api] trusting X-Forwarded-For / X-Real-IP headers");
  }
});
