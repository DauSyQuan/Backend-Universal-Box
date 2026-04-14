import { isIP } from "node:net";
import { randomUUID } from "node:crypto";

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

function pushIpError(errors, field) {
  errors.push(`${field} must be a valid IPv4 or IPv6 address`);
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

function normalizeIpAddress(value) {
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

function normalizeMsgId(value) {
  if (value === undefined || value === null) {
    return null;
  }

  const stringValue = String(value).trim();
  return stringValue === "" ? null : stringValue;
}

export function parseEnvelope(rawBuffer) {
  const content = rawBuffer.toString("utf8");
  const parsed = JSON.parse(content);
  const hasPayloadField = parsed.payload && typeof parsed.payload === "object";
  const payload = hasPayloadField ? parsed.payload : { ...parsed };

  if (!hasPayloadField) {
    delete payload.msg_id;
    delete payload.schema_version;
    delete payload.timestamp;
  }

  return {
    raw: parsed,
    msgId: normalizeMsgId(parsed.msg_id),
    timestamp: parsed.timestamp ?? new Date().toISOString(),
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
    const publicWanIpRaw = firstPresentValue(payload, [
      "public_wan_ip",
      "wan_ip",
      "public_ip",
      "wan_ipv4",
      "ip_wan"
    ]);

    normalized.cpu_usage_pct = asNumber(cpuRaw);
    normalized.ram_usage_pct = asNumber(ramRaw);
    normalized.firmware_version = fwRaw ?? payload.firmware_version ?? null;
    normalized.status = statusRaw ?? payload.status ?? "online";
    normalized.public_wan_ip = normalizeIpAddress(publicWanIpRaw);

    if (cpuRaw !== undefined && normalized.cpu_usage_pct === null) {
      pushNumberError(errors, "cpu_usage_pct");
    }
    if (ramRaw !== undefined && normalized.ram_usage_pct === null) {
      pushNumberError(errors, "ram_usage_pct");
    }
    if (publicWanIpRaw !== undefined && normalized.public_wan_ip === null) {
      pushIpError(errors, "public_wan_ip");
    }
  }

  if (channel === "telemetry") {
    const latencyRaw = firstPresentValue(payload, ["latency_ms", "rtt_ms", "ping_latency_ms", "avg_rtt_ms", "latency"]);
    const lossRaw = firstPresentValue(payload, ["loss_pct", "packet_loss_pct", "ping_loss_pct", "packet_loss", "loss"]);
    const jitterRaw = firstPresentValue(payload, ["jitter_ms", "ping_jitter_ms", "jitter"]);
    const throughputRaw = firstPresentValue(payload, ["throughput_kbps", "total_kbps", "bandwidth_kbps", "throughput"]);
    const rxRaw = firstPresentValue(payload, ["rx_kbps", "download_kbps", "rx_rate_kbps", "in"]);
    const txRaw = firstPresentValue(payload, ["tx_kbps", "upload_kbps", "tx_rate_kbps", "out"]);
    const totalGbRaw = firstPresentValue(payload, ["total_gb", "total_traffic_gb", "cum_gb", "total"]);
    const publicWanIpRaw = firstPresentValue(payload, [
      "public_wan_ip",
      "wan_ip",
      "public_ip",
      "wan_ipv4",
      "ip_wan"
    ]);

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
    normalized.rx_kbps = rxKbps;
    normalized.tx_kbps = txKbps;
    normalized.total_gb = asNumber(totalGbRaw);
    normalized.public_wan_ip = normalizeIpAddress(publicWanIpRaw);

    const interfacesRaw = Array.isArray(payload.interfaces) ? payload.interfaces : [];
    const dataRaw = Array.isArray(payload.data) ? payload.data : [];

    const interfacesSource = interfacesRaw.length > 0 ? interfacesRaw : dataRaw;

    normalized.interfaces = interfacesSource
      .map((iface) => {
        const name = String(firstPresentValue(iface ?? {}, ["name", "interface", "if", "p"]) ?? "").trim();
        const status = String(firstPresentValue(iface ?? {}, ["status", "s"]) ?? "").trim();
        const rx = asNumber(firstPresentValue(iface ?? {}, ["rx_kbps", "download_kbps", "rx_rate_kbps", "in"]));
        const tx = asNumber(firstPresentValue(iface ?? {}, ["tx_kbps", "upload_kbps", "tx_rate_kbps", "out"]));
        const throughputAlias = asNumber(firstPresentValue(iface ?? {}, ["throughput_kbps", "total_kbps", "bandwidth_kbps", "throughput"]));
        const tMb = asNumber(firstPresentValue(iface ?? {}, ["t"]));
        const totalGbAlias = asNumber(firstPresentValue(iface ?? {}, ["total_gb", "total_traffic_gb", "cum_gb", "total"]));

        const throughput_kbps =
          throughputAlias ??
          ((rx !== null || tx !== null) ? (rx ?? 0) + (tx ?? 0) : null);
        const total_gb =
          totalGbAlias ??
          (tMb !== null ? tMb / 1024 : null);

        return {
          name,
          status,
          rx_kbps: rx,
          tx_kbps: tx,
          throughput_kbps,
          total_gb
        };
      })
      .filter((iface) => iface.name);

    if (normalized.active_uplink === null && normalized.interfaces.length > 0) {
      const activeIface = normalized.interfaces.find((iface) => iface.status?.toLowerCase() === "up");
      normalized.active_uplink = activeIface?.name ?? normalized.interfaces[0].name;
    }

    if (normalized.rx_kbps === null) {
      const sumRx = normalized.interfaces.reduce((sum, iface) => sum + (iface.rx_kbps ?? 0), 0);
      normalized.rx_kbps = sumRx > 0 ? sumRx : null;
    }

    if (normalized.tx_kbps === null) {
      const sumTx = normalized.interfaces.reduce((sum, iface) => sum + (iface.tx_kbps ?? 0), 0);
      normalized.tx_kbps = sumTx > 0 ? sumTx : null;
    }

    if (normalized.throughput_kbps === null) {
      const sumThroughput = normalized.interfaces.reduce((sum, iface) => sum + (iface.throughput_kbps ?? 0), 0);
      normalized.throughput_kbps = sumThroughput > 0 ? sumThroughput : null;
    }

    if (normalized.total_gb === null) {
      const sumTotalGb = normalized.interfaces.reduce((sum, iface) => sum + (iface.total_gb ?? 0), 0);
      normalized.total_gb = sumTotalGb > 0 ? sumTotalGb : null;
    }

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
    if (publicWanIpRaw !== undefined && normalized.public_wan_ip === null) {
      pushIpError(errors, "public_wan_ip");
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

  if (channel === "ack" || channel === "result") {
    const jobIdRaw = firstPresentString(payload, [
      "command_job_id",
      "job_id",
      "command_id",
      "msg_id",
      "id"
    ]);
    const statusRaw = firstPresentString(payload, ["status", "ack_status", "result_status"]);
    const messageRaw = firstPresentString(payload, ["message", "detail", "reason"]);
    const resultPayloadRaw = firstPresentValue(payload, ["result_payload", "result", "payload_result", "data"]);

    normalized.command_job_id = jobIdRaw ?? null;
    normalized.status = statusRaw ?? (channel === "ack" ? "ack" : null);
    normalized.message = messageRaw ?? null;
    normalized.result_payload = resultPayloadRaw ?? null;

    if (!normalized.command_job_id) {
      errors.push("command_job_id is required");
    }

    if (channel === "result") {
      if (!normalized.status) {
        errors.push("status is required");
      } else if (!["success", "failed"].includes(String(normalized.status))) {
        errors.push("status must be success or failed");
      }

      if (
        resultPayloadRaw !== undefined &&
        resultPayloadRaw !== null &&
        (typeof resultPayloadRaw !== "object" || Array.isArray(resultPayloadRaw))
      ) {
        errors.push("result_payload must be an object when provided");
      }
    }

    if (channel === "ack" && normalized.status && !["ack", "accepted"].includes(String(normalized.status))) {
      errors.push("status must be ack or accepted");
    }

    if (messageRaw !== undefined && messageRaw !== null && typeof messageRaw !== "string") {
      errors.push("message must be a string when provided");
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    payload: normalized
  };
}

function normalizeString(value) {
  return String(value ?? "").trim().toLowerCase();
}

function isUpStatus(value) {
  const status = normalizeString(value);
  return status === "up" || status === "online" || status === "active" || status === "connected";
}

function isStarlinkName(value) {
  const name = normalizeString(value);
  return name === "starlink" || name.includes("starlink");
}

export function detectLinkDownEvent(payload) {
  if (!payload || !Array.isArray(payload.interfaces)) {
    return null;
  }

  const activeUplink = normalizeString(payload.active_uplink);
  const starlinkIface = payload.interfaces.find((iface) => isStarlinkName(iface?.name));
  if (!starlinkIface) {
    return null;
  }

  const ifaceStatus = normalizeString(starlinkIface.status);
  const rx = typeof starlinkIface.rx_kbps === "number" ? starlinkIface.rx_kbps : null;
  const tx = typeof starlinkIface.tx_kbps === "number" ? starlinkIface.tx_kbps : null;
  const throughput = typeof starlinkIface.throughput_kbps === "number" ? starlinkIface.throughput_kbps : null;
  const hasTraffic = (throughput !== null && throughput > 0) || (rx !== null && rx > 0) || (tx !== null && tx > 0);

  if (activeUplink && !isStarlinkName(activeUplink) && !isUpStatus(ifaceStatus)) {
    return { link: "starlink", reason: "active_uplink_changed" };
  }

  if (!isUpStatus(ifaceStatus) || (activeUplink && isStarlinkName(activeUplink) && !hasTraffic)) {
    return { link: "starlink", reason: "interface_down" };
  }

  return null;
}

export function toObservedAt(value, options = {}) {
  const now = new Date();
  const fallback = now.toISOString();
  const maxSkewSeconds = Number.isFinite(options.maxSkewSeconds) ? options.maxSkewSeconds : null;

  if (!value) {
    return fallback;
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return fallback;
  }

  if (maxSkewSeconds !== null) {
    const skewMs = Math.abs(now.getTime() - date.getTime());
    if (skewMs > maxSkewSeconds * 1000) {
      return fallback;
    }
  }

  return date.toISOString();
}
