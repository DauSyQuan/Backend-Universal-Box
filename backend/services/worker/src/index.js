import dotenv from "dotenv";
import path from "node:path";
import process from "node:process";
import mqtt from "mqtt";
import { loadWorkerRuntimeConfig } from "../../../shared/config.js";
import { createLogger } from "../../../shared/logger.js";
import {
  insertEvent,
  insertHeartbeat,
  insertIngestError,
  insertIngestMessage,
  insertTelemetry,
  insertUsage,
  insertVms,
  markCommandJobAck,
  markCommandJobResult,
  markEdgeLastSeen,
  recordUsageWithQuota,
  pool,
  resolveEdgeContext,
  resolveTenantVesselContext,
  resolveUserId,
  updateEdgePublicWanIp,
  ensureEdgeExists,
  hasRecentEvent
} from "./db.js";
import {
  parseEnvelope,
  parseTopic,
  toObservedAt,
  validateAndNormalizePayload,
  validateEnvelope,
  detectLinkDownEvent
} from "./parser.js";

dotenv.config({ path: path.resolve(process.cwd(), "../../ops/.env") });
dotenv.config({ path: path.resolve(process.cwd(), "../../ops/env.example"), override: false });

const console = createLogger("worker");
const workerConfig = loadWorkerRuntimeConfig(process.env);
const mqttUrl = workerConfig.mqttUrl;
const mqttUsername = workerConfig.mqttUsername;
const mqttPassword = workerConfig.mqttPassword;
const qos = workerConfig.qos;
const observedAtMaxSkewSeconds = workerConfig.observedAtMaxSkewSeconds;
const inboundTopicFilters = [
  "mcu/+/+/+/heartbeat",
  "mcu/+/+/+/telemetry",
  "mcu/+/+/+/usage",
  "mcu/+/+/+/event",
  "mcu/+/+/+/vms",
  "mcu/+/+/+/command",
  "mcu/+/+/+/ack",
  "mcu/+/+/+/result"
];

const mqttAutoProvision = workerConfig.mqttAutoProvision;
const mqttReconnectBaseMs = workerConfig.mqttReconnectBaseMs;
const mqttReconnectMaxMs = workerConfig.mqttReconnectMaxMs;
let mqttReconnectAttempts = 0;

const client = mqtt.connect(mqttUrl, {
  username: mqttUsername,
  password: mqttPassword,
  reconnectPeriod: mqttReconnectBaseMs,
  connectTimeout: 30_000
});

async function saveIngestError(errorData) {
  try {
    await insertIngestError(errorData);
  } catch (error) {
    const message = error?.message || String(error);
    console.error("[worker] failed to persist ingest error:", message);
  }
}

function hasResolvedEdgeContext(context) {
  return Boolean(context?.tenant_id && context?.vessel_id && context?.edge_box_id);
}

async function resolveRequiredEdgeContext(parsedTopic) {
  const context = mqttAutoProvision
    ? await ensureEdgeExists({
        tenantCode: parsedTopic.tenantCode,
        vesselCode: parsedTopic.vesselCode,
        edgeCode: parsedTopic.edgeCode
      })
    : await resolveEdgeContext({
        tenantCode: parsedTopic.tenantCode,
        vesselCode: parsedTopic.vesselCode,
        edgeCode: parsedTopic.edgeCode
      });

  return hasResolvedEdgeContext(context) ? context : null;
}

client.on("connect", () => {
  console.log(`[worker] connected to broker ${mqttUrl}`);
  mqttReconnectAttempts = 0;
  client.options.reconnectPeriod = mqttReconnectBaseMs;
  client.subscribe(inboundTopicFilters, { qos }, (error) => {
    if (error) {
      console.error("[worker] subscribe failed:", error.message);
      return;
    }
    console.log(`[worker] subscribed ${inboundTopicFilters.join(", ")} qos=${qos}`);
  });
});

client.on("reconnect", () => {
  mqttReconnectAttempts += 1;
  const jitter = Math.floor(Math.random() * 250);
  const backoff = Math.min(mqttReconnectMaxMs, mqttReconnectBaseMs * 2 ** Math.min(mqttReconnectAttempts - 1, 5)) + jitter;
  client.options.reconnectPeriod = backoff;
  console.log(`[worker] reconnecting to broker attempt=${mqttReconnectAttempts} backoff=${backoff}ms`);
});

client.on("error", (error) => {
  const message = error?.message || String(error);
  console.error("[worker] mqtt error:", message);
});

client.on("message", async (topic, payloadBuffer) => {
  const parsedTopic = parseTopic(topic);
  if (!parsedTopic) {
    console.warn(`[worker] ignore invalid topic: ${topic}`);
    await saveIngestError({
      topic,
      reason: "invalid_topic",
      detail: "Topic format must be mcu/{tenant}/{vessel}/{edge}/{channel}"
    });
    return;
  }

  let envelope;
  try {
    envelope = parseEnvelope(payloadBuffer);
  } catch (error) {
    const message = error?.message || String(error);
    console.error(`[worker] failed parsing payload topic=${topic}: ${message}`);
    await saveIngestError({
      topic,
      channel: parsedTopic.channel,
      reason: "invalid_json",
      detail: message,
      raw: { raw_text: payloadBuffer.toString("utf8") }
    });
    return;
  }

  const observedAt = toObservedAt(envelope.timestamp, {
    maxSkewSeconds: Number.isFinite(observedAtMaxSkewSeconds) ? observedAtMaxSkewSeconds : 300
  });
  const ingest = await insertIngestMessage({
    topic,
    channel: parsedTopic.channel,
    msgId: envelope.msgId,
    tenantCode: parsedTopic.tenantCode,
    vesselCode: parsedTopic.vesselCode,
    edgeCode: parsedTopic.edgeCode,
    schemaVersion: envelope.schemaVersion,
    payload: envelope.payload,
    raw: envelope.raw
  });

  if (!ingest.inserted) {
    console.log(`[worker] duplicate message skipped msg_id=${envelope.msgId ?? "n/a"}`);
    return;
  }

  const envelopeValidation = validateEnvelope(envelope);
  if (!envelopeValidation.valid) {
    await saveIngestError({
      topic,
      channel: parsedTopic.channel,
      msgId: envelope.msgId,
      reason: "invalid_envelope",
      detail: envelopeValidation.errors.join("; "),
      raw: envelope.raw
    });
    return;
  }

  const payloadValidation = validateAndNormalizePayload(parsedTopic.channel, envelope.payload);
  if (!payloadValidation.valid) {
    await saveIngestError({
      topic,
      channel: parsedTopic.channel,
      msgId: envelope.msgId,
      reason: "invalid_payload",
      detail: payloadValidation.errors.join("; "),
      raw: envelope.raw
    });
    return;
  }

  const payload = payloadValidation.payload;

  try {
    if (parsedTopic.channel === "heartbeat") {
      const context = await resolveRequiredEdgeContext(parsedTopic);
      if (!context) {
        await saveIngestError({
          topic,
          channel: parsedTopic.channel,
          msgId: envelope.msgId,
          reason: "context_missing",
          detail: mqttAutoProvision
            ? "Unable to create or resolve the requested edge"
            : "Unknown edge; register or seed the edge before accepting inbound data"
        });
        return;
      }

      await insertHeartbeat({
        tenantCode: parsedTopic.tenantCode,
        vesselCode: parsedTopic.vesselCode,
        edgeCode: parsedTopic.edgeCode,
        firmwareVersion: payload.firmware_version,
        cpuUsagePct: payload.cpu_usage_pct,
        ramUsagePct: payload.ram_usage_pct,
        status: payload.status ?? "online",
        observedAt
      });

      await markEdgeLastSeen({
        vesselId: context.vessel_id,
        edgeCode: parsedTopic.edgeCode,
        observedAt
      });
      await updateEdgePublicWanIp({
        edgeBoxId: context.edge_box_id,
        publicWanIp: payload.public_wan_ip
      });
      console.log(`[worker] heartbeat stored topic=${topic} msg_id=${envelope.msgId}`);
      return;
    }

    if (parsedTopic.channel === "telemetry") {
      const context = await resolveRequiredEdgeContext(parsedTopic);
      if (!context) {
        await saveIngestError({
          topic,
          channel: parsedTopic.channel,
          msgId: envelope.msgId,
          reason: "context_missing",
          detail: mqttAutoProvision
            ? "Unable to create or resolve the requested edge"
            : "Unknown edge; register or seed the edge before accepting inbound data"
        });
        return;
      }

      await insertTelemetry({ context, payload, observedAt });

      const linkDown = detectLinkDownEvent(payload);
      if (linkDown) {
        const hasRecent = await hasRecentEvent({
          vesselId: context.vessel_id,
          edgeBoxId: context.edge_box_id,
          eventType: "link_down",
          withinSeconds: 600
        });

        if (!hasRecent) {
          await insertEvent({
            context,
            payload: {
              event_type: "link_down",
              severity: "warning",
              details: {
                link: linkDown.link,
                reason: linkDown.reason
              }
            },
            observedAt
          });
          console.log(`[worker] link_down event created topic=${topic} msg_id=${envelope.msgId}`);
        }
      }

      await markEdgeLastSeen({
        vesselId: context.vessel_id,
        edgeCode: parsedTopic.edgeCode,
        observedAt
      });
      await updateEdgePublicWanIp({
        edgeBoxId: context.edge_box_id,
        publicWanIp: payload.public_wan_ip
      });
      console.log(`[worker] telemetry stored topic=${topic} msg_id=${envelope.msgId}`);
      return;
    }

    if (parsedTopic.channel === "usage") {
      const context = await resolveTenantVesselContext({
        tenantCode: parsedTopic.tenantCode,
        vesselCode: parsedTopic.vesselCode
      });

      if (!context) {
        await saveIngestError({
          topic,
          channel: parsedTopic.channel,
          msgId: envelope.msgId,
          reason: "context_missing",
          detail: "Unable to resolve tenant/vessel by code"
        });
        return;
      }

      const userId = await resolveUserId({
        tenantId: context.tenant_id,
        userId: payload.user_id,
        username: payload.username
      });

      if (!userId) {
        await saveIngestError({
          topic,
          channel: parsedTopic.channel,
          msgId: envelope.msgId,
          reason: "user_not_found",
          detail: "usage payload must map to an existing user"
        });
        return;
      }

      const usageResult = await recordUsageWithQuota({
        context,
        tenantCode: parsedTopic.tenantCode,
        vesselCode: parsedTopic.vesselCode,
        username: payload.username ?? null,
        userId,
        payload,
        observedAt
      });
      console.log(
        `[worker] usage stored topic=${topic} msg_id=${envelope.msgId} assignment=${usageResult.package_assignment_id || "none"} remaining_mb=${usageResult.remaining_mb ?? "n/a"}`
      );
      return;
    }

    if (parsedTopic.channel === "event") {
      const context = await resolveRequiredEdgeContext(parsedTopic);
      if (!context) {
        await saveIngestError({
          topic,
          channel: parsedTopic.channel,
          msgId: envelope.msgId,
          reason: "context_missing",
          detail: mqttAutoProvision
            ? "Unable to create or resolve the requested edge"
            : "Unknown edge; register or seed the edge before accepting inbound data"
        });
        return;
      }

      await insertEvent({ context, payload, observedAt });
      console.log(`[worker] event stored topic=${topic} msg_id=${envelope.msgId}`);
      return;
    }

    if (parsedTopic.channel === "vms") {
      const context = await resolveTenantVesselContext({
        tenantCode: parsedTopic.tenantCode,
        vesselCode: parsedTopic.vesselCode
      });

      if (!context) {
        await saveIngestError({
          topic,
          channel: parsedTopic.channel,
          msgId: envelope.msgId,
          reason: "context_missing",
          detail: "Unable to resolve tenant/vessel by code"
        });
        return;
      }

      await insertVms({ context, payload, observedAt });
      console.log(`[worker] vms stored topic=${topic} msg_id=${envelope.msgId}`);
      return;
    }

    if (parsedTopic.channel === "ack") {
      const jobId = payload.command_job_id ?? envelope.msgId;
      const updated = await markCommandJobAck({
        jobId,
        payload,
        observedAt
      });

      if (!updated) {
        await saveIngestError({
          topic,
          channel: parsedTopic.channel,
          msgId: envelope.msgId,
          reason: "command_job_not_found",
          detail: "ack payload did not match an existing command job",
          raw: envelope.raw
        });
        return;
      }

      console.log(`[worker] command ack stored topic=${topic} msg_id=${envelope.msgId}`);
      return;
    }

    if (parsedTopic.channel === "result") {
      const jobId = payload.command_job_id ?? envelope.msgId;
      const updated = await markCommandJobResult({
        jobId,
        status: payload.status,
        payload,
        observedAt
      });

      if (!updated) {
        await saveIngestError({
          topic,
          channel: parsedTopic.channel,
          msgId: envelope.msgId,
          reason: "command_job_not_found",
          detail: "result payload did not match an existing command job",
          raw: envelope.raw
        });
        return;
      }

      console.log(`[worker] command result stored topic=${topic} msg_id=${envelope.msgId}`);
      return;
    }

    if (parsedTopic.channel === "command") {
      console.log(`[worker] command observed topic=${topic} msg_id=${envelope.msgId}`);
      return;
    }

    console.log(`[worker] ${parsedTopic.channel} raw stored topic=${topic} msg_id=${envelope.msgId}`);
  } catch (error) {
    const message = error?.message || String(error);
    console.error(`[worker] failed processing topic=${topic}:`, message);
    await saveIngestError({
      topic,
      channel: parsedTopic.channel,
      msgId: envelope.msgId,
      reason: "processing_error",
      detail: message,
      raw: envelope.raw
    });
  }
});

async function shutdown() {
  console.log("[worker] shutting down");
  client.end(true);
  await pool.end();
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

console.log(`[worker] bootstrap started at ${new Date().toISOString()}`);
console.log(`[worker] edge auto-provision ${mqttAutoProvision ? "enabled" : "disabled"}`);
