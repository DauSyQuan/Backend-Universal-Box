import { ValidationError } from "./errors.js";
import { normalizeSecret, parseBoolean } from "./utils.js";

function parseIntEnv(value, fallback, { min = null, max = null } = {}) {
  const parsed = Number.parseInt(String(value), 10);
  const safe = Number.isNaN(parsed) ? fallback : parsed;
  if (min !== null && safe < min) return min;
  if (max !== null && safe > max) return max;
  return safe;
}

export function loadDatabaseConfig(env = process.env, { applicationName = "app" } = {}) {
  const databaseUrl = normalizeSecret(env.DATABASE_URL);
  if (!databaseUrl) {
    throw new ValidationError("DATABASE_URL is required", "DATABASE_URL");
  }

  return {
    databaseUrl,
    applicationName,
    poolMax: parseIntEnv(env.DB_POOL_MAX ?? 20, 20, { min: 1, max: 100 }),
    idleTimeoutMillis: parseIntEnv(env.DB_POOL_IDLE_TIMEOUT_MS ?? 30_000, 30_000, { min: 1_000, max: 300_000 }),
    connectionTimeoutMillis: parseIntEnv(env.DB_POOL_CONNECTION_TIMEOUT_MS ?? 2_000, 2_000, { min: 500, max: 30_000 }),
    statementTimeoutMillis: parseIntEnv(env.DB_POOL_STATEMENT_TIMEOUT_MS ?? 10_000, 10_000, { min: 1_000, max: 120_000 }),
    queryTimeoutMillis: parseIntEnv(env.DB_POOL_QUERY_TIMEOUT_MS ?? 10_000, 10_000, { min: 1_000, max: 120_000 })
  };
}

export function loadApiRuntimeConfig(env = process.env) {
  return {
    mqttUrl: normalizeSecret(env.MQTT_URL) || "mqtt://localhost:1883",
    mqttUsername: normalizeSecret(env.MQTT_USERNAME) || undefined,
    mqttPassword: normalizeSecret(env.MQTT_PASSWORD) || undefined,
    basicAuthEnabled: parseBoolean(env.BASIC_AUTH_ENABLED, true),
    basicAuthUsername: normalizeSecret(env.BASIC_AUTH_USERNAME) || "demo",
    basicAuthPassword: normalizeSecret(env.BASIC_AUTH_PASSWORD) || "",
    basicAuthRole: normalizeSecret(env.BASIC_AUTH_ROLE) || "admin",
    authTokenSecret: normalizeSecret(env.AUTH_TOKEN_SECRET || env.JWT_SECRET || ""),
    authTokenTtlSeconds: parseIntEnv(env.AUTH_TOKEN_TTL_SECONDS ?? 3600, 3600, { min: 300, max: 86_400 }),
    trustProxyHeaders: parseBoolean(env.TRUST_PROXY_HEADERS, false),
    mcuRegisterEnabled: parseBoolean(env.MCU_REGISTER_ENABLED, false),
    mcuRegisterToken: normalizeSecret(env.MCU_REGISTER_TOKEN),
    serverRequestTimeoutMs: parseIntEnv(env.SERVER_REQUEST_TIMEOUT_MS ?? 30_000, 30_000, { min: 5_000, max: 300_000 }),
    requestTimeoutMs: parseIntEnv(env.REQUEST_TIMEOUT_MS ?? 25_000, 25_000, { min: 5_000, max: 300_000 }),
    serverKeepAliveTimeoutMs: parseIntEnv(env.SERVER_KEEPALIVE_TIMEOUT_MS ?? 65_000, 65_000, { min: 1_000, max: 300_000 }),
    serverHeadersTimeoutMs: parseIntEnv(env.SERVER_HEADERS_TIMEOUT_MS ?? 66_000, 66_000, { min: 2_000, max: 300_000 }),
    rateLimitWindowMs: parseIntEnv(env.RATE_LIMIT_WINDOW_MS ?? 60_000, 60_000, { min: 1_000, max: 10 * 60_000 }),
    metricsEnabled: parseBoolean(env.METRICS_ENABLED, true)
  };
}

export function loadWorkerRuntimeConfig(env = process.env) {
  const parseAliasMap = (value) => {
    const entries = String(value || "")
      .split(/[,;\n]/)
      .map((item) => item.trim())
      .filter(Boolean)
      .map((item) => {
        const [from, to] = item.split("=").map((part) => part.trim());
        return from && to ? [from, to] : null;
      })
      .filter(Boolean);
    return Object.fromEntries(entries);
  };

  return {
    mqttUrl: normalizeSecret(env.MQTT_URL) || "mqtt://localhost:1883",
    mqttUsername: normalizeSecret(env.MQTT_USERNAME) || undefined,
    mqttPassword: normalizeSecret(env.MQTT_PASSWORD) || undefined,
    qos: parseIntEnv(env.MQTT_QOS ?? 1, 1, { min: 0, max: 2 }),
    observedAtMaxSkewSeconds: parseIntEnv(env.OBSERVED_AT_MAX_SKEW_SECONDS ?? 300, 300, { min: 1, max: 3_600 }),
    mqttAutoProvision: parseBoolean(env.MQTT_AUTO_PROVISION, false),
    topicAliases: {
      tenant: parseAliasMap(env.MQTT_TOPIC_TENANT_ALIASES || "tenant-01=tnr13"),
      vessel: parseAliasMap(env.MQTT_TOPIC_VESSEL_ALIASES || "vessel-01=vsl-001"),
      edge: parseAliasMap(env.MQTT_TOPIC_EDGE_ALIASES || "remote_01=edge-001")
    },
    mqttReconnectBaseMs: parseIntEnv(env.MQTT_RECONNECT_BASE_MS ?? 1_000, 1_000, { min: 500, max: 30_000 }),
    mqttReconnectMaxMs: parseIntEnv(env.MQTT_RECONNECT_MAX_MS ?? 30_000, 30_000, { min: 500, max: 120_000 })
  };
}
