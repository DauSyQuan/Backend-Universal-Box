const VALID_CHANNELS = new Set(["heartbeat", "telemetry", "usage", "event", "vms", "ack", "result"]);

function asNumber(value) {
  if (value === null || value === undefined || value === "") {
    return null;
  }

  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return null;
  }

  return parsed;
}

function pushNumberError(errors, field) {
  errors.push(`${field} must be a number`);
}

function firstPresentValue(payload, aliases) {
  for (const key of aliases) {
    if (Object.prototype.hasOwnProperty.call(payload, key)) {
      const value = payload[key];
      if (value !== null && value !== undefined && value !== "") {
        return value;
      }
    }
  }
  return undefined;
}

function firstPresentString(payload, aliases) {
  const value = firstPresentValue(payload, aliases);
  if (value === undefined) {
    return undefined;
  }
  return String(value);
}

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

export function validateEnvelope(envelope) {
  const errors = [];
  if (!envelope.msgId || typeof envelope.msgId !== "string") {
    errors.push("msg_id is required");
  }

  if (!envelope.timestamp || Number.isNaN(new Date(envelope.timestamp).getTime())) {
    errors.push("timestamp must be valid ISO-8601");
  }

  if (envelope.schemaVersion !== "v1") {
    errors.push(`unsupported schema_version: ${String(envelope.schemaVersion)}`);
  }

  return {
    valid: errors.length === 0,
    errors
  };
}

export function validateAndNormalizePayload(channel, payload) {
  const errors = [];
  const normalized = { ...payload };

  if (channel === "heartbeat") {
    const cpuRaw = firstPresentValue(payload, ["cpu_usage_pct", "cpu_load_pct", "cpu_load", "cpu_pct"]);
    const ramRaw = firstPresentValue(payload, [
      "ram_usage_pct",
      "memory_usage_pct",
      "memory_used_pct",
      "mem_usage_pct",
      "ram_pct"
    ]);
    const fwRaw = firstPresentString(payload, ["firmware_version", "routeros_version", "ros_version", "version"]);
    const statusRaw = firstPresentString(payload, ["status", "router_status", "state"]);

    normalized.cpu_usage_pct = asNumber(cpuRaw);
    normalized.ram_usage_pct = asNumber(ramRaw);
    normalized.firmware_version = fwRaw ?? payload.firmware_version ?? null;
    normalized.status = statusRaw ?? payload.status ?? "online";

    if (cpuRaw !== undefined && normalized.cpu_usage_pct === null) {
      pushNumberError(errors, "cpu_usage_pct");
    }
    if (ramRaw !== undefined && normalized.ram_usage_pct === null) {
      pushNumberError(errors, "ram_usage_pct");
    }
  }

  if (channel === "telemetry") {
    const latencyRaw = firstPresentValue(payload, ["latency_ms", "rtt_ms", "ping_latency_ms", "avg_rtt_ms"]);
    const lossRaw = firstPresentValue(payload, ["loss_pct", "packet_loss_pct", "ping_loss_pct"]);
    const jitterRaw = firstPresentValue(payload, ["jitter_ms", "ping_jitter_ms"]);
    const throughputRaw = firstPresentValue(payload, ["throughput_kbps", "total_kbps", "bandwidth_kbps"]);
    const rxRaw = firstPresentValue(payload, ["rx_kbps", "download_kbps", "rx_rate_kbps"]);
    const txRaw = firstPresentValue(payload, ["tx_kbps", "upload_kbps", "tx_rate_kbps"]);

    const rxKbps = asNumber(rxRaw);
    const txKbps = asNumber(txRaw);

    normalized.active_uplink =
      firstPresentString(payload, ["active_uplink", "active_interface", "wan_interface", "uplink_if", "interface"]) ??
      payload.active_uplink ??
      null;
    normalized.latency_ms = asNumber(latencyRaw);
    normalized.loss_pct = asNumber(lossRaw);
    normalized.jitter_ms = asNumber(jitterRaw);
    normalized.throughput_kbps = asNumber(throughputRaw);

    if (normalized.throughput_kbps === null && (rxKbps !== null || txKbps !== null)) {
      normalized.throughput_kbps = (rxKbps ?? 0) + (txKbps ?? 0);
    }

    if (latencyRaw !== undefined && normalized.latency_ms === null) {
      pushNumberError(errors, "latency_ms");
    }
    if (lossRaw !== undefined && normalized.loss_pct === null) {
      pushNumberError(errors, "loss_pct");
    }
    if (jitterRaw !== undefined && normalized.jitter_ms === null) {
      pushNumberError(errors, "jitter_ms");
    }
    if (throughputRaw !== undefined && normalized.throughput_kbps === null) {
      pushNumberError(errors, "throughput_kbps");
    }
    if (rxRaw !== undefined && rxKbps === null) {
      pushNumberError(errors, "rx_kbps");
    }
    if (txRaw !== undefined && txKbps === null) {
      pushNumberError(errors, "tx_kbps");
    }
  }

  if (channel === "usage") {
    normalized.upload_mb = asNumber(payload.upload_mb);
    normalized.download_mb = asNumber(payload.download_mb);
    if (!payload.user_id && !payload.username) {
      errors.push("usage requires user_id or username");
    }
    if (normalized.upload_mb === null) {
      pushNumberError(errors, "upload_mb");
    }
    if (normalized.download_mb === null) {
      pushNumberError(errors, "download_mb");
    }
  }

  if (channel === "event") {
    if (!payload.event_type || typeof payload.event_type !== "string") {
      errors.push("event_type is required");
    }
    if (!payload.severity || typeof payload.severity !== "string") {
      errors.push("severity is required");
    }
    if (payload.details !== undefined && typeof payload.details !== "object") {
      errors.push("details must be an object when provided");
    }
  }

  if (channel === "vms") {
    normalized.latitude = asNumber(payload.latitude);
    normalized.longitude = asNumber(payload.longitude);
    normalized.speed_knots = asNumber(payload.speed_knots);
    normalized.heading_deg = asNumber(payload.heading_deg);

    if (normalized.latitude === null) {
      pushNumberError(errors, "latitude");
    } else if (normalized.latitude < -90 || normalized.latitude > 90) {
      errors.push("latitude must be between -90 and 90");
    }

    if (normalized.longitude === null) {
      pushNumberError(errors, "longitude");
    } else if (normalized.longitude < -180 || normalized.longitude > 180) {
      errors.push("longitude must be between -180 and 180");
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    payload: normalized
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
