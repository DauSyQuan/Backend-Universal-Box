import dotenv from "dotenv";
import path from "node:path";
import process from "node:process";
import mqtt from "mqtt";
import {
  insertEvent,
  insertHeartbeat,
  insertIngestError,
  insertIngestMessage,
  insertTelemetry,
  insertUsage,
  insertVms,
  markEdgeLastSeen,
  pool,
  resolveEdgeContext,
  resolveTenantVesselContext,
  resolveUserId,
  updateEdgePublicWanIp,
  ensureEdgeExists
} from "./db.js";
import {
  parseEnvelope,
  parseTopic,
  toObservedAt,
  validateAndNormalizePayload,
  validateEnvelope
} from "./parser.js";

dotenv.config({ path: path.resolve(process.cwd(), "../../ops/.env") });
dotenv.config({ path: path.resolve(process.cwd(), "../../ops/env.example"), override: false });

const mqttUrl = process.env.MQTT_URL || "mqtt://localhost:1883";
const mqttUsername = process.env.MQTT_USERNAME || undefined;
const mqttPassword = process.env.MQTT_PASSWORD || undefined;
const qos = Number(process.env.MQTT_QOS ?? "1");
const topicFilter = "mcu/+/+/+/+";

const client = mqtt.connect(mqttUrl, {
  username: mqttUsername,
  password: mqttPassword,
  reconnectPeriod: 2_000
});

async function saveIngestError(errorData) {
  try {
    await insertIngestError(errorData);
  } catch (error) {
    const message = error?.message || String(error);
    console.error("[worker] failed to persist ingest error:", message);
  }
}

client.on("connect", () => {
  console.log(`[worker] connected to broker ${mqttUrl}`);
  client.subscribe(topicFilter, { qos }, (error) => {
    if (error) {
      console.error("[worker] subscribe failed:", error.message);
      return;
    }
    console.log(`[worker] subscribed ${topicFilter} qos=${qos}`);
  });
});

client.on("reconnect", () => {
  console.log("[worker] reconnecting to broker...");
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

  const observedAt = toObservedAt(envelope.timestamp);
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
      const context = await ensureEdgeExists({
        tenantCode: parsedTopic.tenantCode,
        vesselCode: parsedTopic.vesselCode,
        edgeCode: parsedTopic.edgeCode
      });

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

      if (context?.edge_box_id) {
        await markEdgeLastSeen({
          vesselId: context.vessel_id,
          edgeCode: parsedTopic.edgeCode,
          observedAt
        });
        await updateEdgePublicWanIp({
          edgeBoxId: context.edge_box_id,
          publicWanIp: payload.public_wan_ip
        });
      }
      console.log(`[worker] heartbeat stored topic=${topic} msg_id=${envelope.msgId}`);
      return;
    }

    if (parsedTopic.channel === "telemetry") {
      const context = await ensureEdgeExists({
        tenantCode: parsedTopic.tenantCode,
        vesselCode: parsedTopic.vesselCode,
        edgeCode: parsedTopic.edgeCode
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

      await insertTelemetry({ context, payload, observedAt });
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

      await insertUsage({ context, userId, payload, observedAt });
      console.log(`[worker] usage stored topic=${topic} msg_id=${envelope.msgId}`);
      return;
    }

    if (parsedTopic.channel === "event") {
      const context = await resolveEdgeContext({
        tenantCode: parsedTopic.tenantCode,
        vesselCode: parsedTopic.vesselCode,
        edgeCode: parsedTopic.edgeCode
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
