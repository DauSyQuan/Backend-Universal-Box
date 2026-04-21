function normalizeCheck(input, fallbackStatus = "ok") {
  if (input === undefined || input === null) {
    return null;
  }

  if (typeof input === "boolean") {
    return {
      status: input ? fallbackStatus : "error"
    };
  }

  if (typeof input === "object") {
    return input;
  }

  return {
    status: String(input || fallbackStatus)
  };
}

function resolveOverallStatus(checks) {
  const values = Object.values(checks).filter(Boolean);
  if (values.some((check) => check.status === "error")) {
    return "degraded";
  }
  if (values.some((check) => check.status === "warning")) {
    return "degraded";
  }
  return values.length > 0 ? "ok" : "ok";
}

export function getHealth({ database = null, memory = null, mqtt = null } = {}) {
  const checks = {};
  const normalizedDatabase = normalizeCheck(database);
  const normalizedMemory = normalizeCheck(memory);
  const normalizedMqtt = normalizeCheck(mqtt);

  if (normalizedDatabase) checks.database = normalizedDatabase;
  if (normalizedMemory) checks.memory = normalizedMemory;
  if (normalizedMqtt) checks.mqtt = normalizedMqtt;

  return {
    status: resolveOverallStatus(checks),
    service: "api",
    checks,
    timestamp: new Date().toISOString()
  };
}

export function getReady({ database }) {
  const normalizedDatabase = normalizeCheck(database);
  const ready = Boolean(normalizedDatabase?.status === "ok" || normalizedDatabase?.status === "ready");
  return {
    status: ready ? "ready" : "not_ready",
    service: "api",
    checks: {
      database: normalizedDatabase
    },
    timestamp: new Date().toISOString()
  };
}

export function getMemoryHealth() {
  const usage = process.memoryUsage();
  const heapUsedPct = usage.heapTotal > 0 ? (usage.heapUsed / usage.heapTotal) * 100 : 0;
  return {
    status: heapUsedPct < 95 ? "ok" : "warning",
    heap_used_mb: Math.round(usage.heapUsed / 1024 / 1024),
    heap_total_mb: Math.round(usage.heapTotal / 1024 / 1024),
    heap_used_pct: Number(heapUsedPct.toFixed(2))
  };
}
