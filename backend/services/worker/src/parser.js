const VALID_CHANNELS = new Set(["heartbeat", "telemetry", "usage", "event", "vms", "ack", "result"]);

export function parseTopic(topic) {
  const parts = topic.split("/");
  if (parts.length !== 5 || parts[0] !== "mcu") {
    return null;
  }

  const [, tenantCode, vesselCode, edgeCode, channel] = parts;
  if (!VALID_CHANNELS.has(channel)) {
    return null;
  }

  return { tenantCode, vesselCode, edgeCode, channel };
}

export function parseEnvelope(rawBuffer) {
  const content = rawBuffer.toString("utf8");
  const parsed = JSON.parse(content);
  const payload = parsed.payload && typeof parsed.payload === "object" ? parsed.payload : {};

  return {
    raw: parsed,
    msgId: parsed.msg_id ?? null,
    timestamp: parsed.timestamp ?? null,
    schemaVersion: parsed.schema_version ?? "v1",
    payload
  };
}

export function toObservedAt(value) {
  if (!value) {
    return new Date().toISOString();
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return new Date().toISOString();
  }

  return date.toISOString();
}

