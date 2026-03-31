import dotenv from "dotenv";
import path from "node:path";
import process from "node:process";
import mqtt from "mqtt";
import {
  insertHeartbeat,
  insertIngestMessage,
  insertTelemetry,
  resolveEdgeContext
} from "./db.js";
import { parseEnvelope, parseTopic, toObservedAt } from "./parser.js";

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
    return;
  }

  try {
    const envelope = parseEnvelope(payloadBuffer);
    const observedAt = toObservedAt(envelope.timestamp);

    await insertIngestMessage({
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

    if (parsedTopic.channel === "heartbeat") {
      await insertHeartbeat({
        tenantCode: parsedTopic.tenantCode,
        vesselCode: parsedTopic.vesselCode,
        edgeCode: parsedTopic.edgeCode,
        firmwareVersion: envelope.payload.firmware_version,
        cpuUsagePct: envelope.payload.cpu_usage_pct,
        ramUsagePct: envelope.payload.ram_usage_pct,
        status: envelope.payload.status ?? "online",
        observedAt
      });
      console.log(`[worker] heartbeat stored topic=${topic} msg_id=${envelope.msgId ?? "n/a"}`);
      return;
    }

    if (parsedTopic.channel === "telemetry") {
      const context = await resolveEdgeContext({
        tenantCode: parsedTopic.tenantCode,
        vesselCode: parsedTopic.vesselCode,
        edgeCode: parsedTopic.edgeCode
      });

      if (!context) {
        console.warn(
          `[worker] telemetry context missing tenant=${parsedTopic.tenantCode} vessel=${parsedTopic.vesselCode} edge=${parsedTopic.edgeCode}`
        );
        return;
      }

      await insertTelemetry({
        context,
        payload: envelope.payload,
        observedAt
      });
      console.log(`[worker] telemetry stored topic=${topic} msg_id=${envelope.msgId ?? "n/a"}`);
      return;
    }

    console.log(`[worker] ${parsedTopic.channel} raw stored topic=${topic} msg_id=${envelope.msgId ?? "n/a"}`);
  } catch (error) {
    const message = error?.message || String(error);
    console.error(`[worker] failed processing topic=${topic}:`, message);
  }
});

process.on("SIGINT", () => {
  console.log("[worker] shutting down");
  client.end(true, () => process.exit(0));
});

console.log(`[worker] bootstrap started at ${new Date().toISOString()}`);
