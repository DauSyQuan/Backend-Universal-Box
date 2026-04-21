function toInt(value, fallback) {
  const parsed = Number.parseInt(String(value), 10);
  return Number.isNaN(parsed) ? fallback : parsed;
}

export function createPoolConfig(databaseUrl, {
  applicationName = "mcu-backend",
  max = 20,
  idleTimeoutMillis = 30_000,
  connectionTimeoutMillis = 2_000,
  statementTimeoutMillis = 10_000,
  queryTimeoutMillis = 10_000
} = {}) {
  if (!databaseUrl) {
    return null;
  }

  return {
    connectionString: databaseUrl,
    application_name: applicationName,
    max: toInt(max, 20),
    idleTimeoutMillis: toInt(idleTimeoutMillis, 30_000),
    connectionTimeoutMillis: toInt(connectionTimeoutMillis, 2_000),
    statement_timeout: toInt(statementTimeoutMillis, 10_000),
    query_timeout: toInt(queryTimeoutMillis, 10_000)
  };
}
