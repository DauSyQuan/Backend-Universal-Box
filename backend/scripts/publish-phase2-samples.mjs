import { randomUUID } from "node:crypto";
import dotenv from "dotenv";
import path from "node:path";
import process from "node:process";
import mqtt from "mqtt";

dotenv.config({ path: path.resolve(process.cwd(), "ops/.env") });
dotenv.config({ path: path.resolve(process.cwd(), "ops/env.example"), override: false });

const mqttUrl = process.env.MQTT_URL || "mqtt://localhost:1883";
const qos = Number(process.env.MQTT_QOS ?? "1");
const tenantCode = process.env.PHASE2_TENANT_CODE || "tnr13";
const vesselCode = process.env.PHASE2_VESSEL_CODE || "vsl-001";
const edgeCode = process.env.PHASE2_EDGE_CODE || "edge-001";
const publicWanIp = process.env.PHASE2_PUBLIC_WAN_IP || "65.181.17.76";

function envelope(payload, msgId = randomUUID()) {
  return {
    msg_id: msgId,
    timestamp: new Date().toISOString(),
    tenant_id: tenantCode,
    vessel_id: vesselCode,
    edge_id: edgeCode,
    schema_version: "v1",
    payload
  };
}

function publishAsync(client, topic, message) {
  return new Promise((resolve, reject) => {
    client.publish(topic, JSON.stringify(message), { qos }, (error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

async function run() {
  const client = mqtt.connect(mqttUrl, {
    username: process.env.MQTT_USERNAME || undefined,
    password: process.env.MQTT_PASSWORD || undefined
  });

  await new Promise((resolve, reject) => {
    client.once("connect", resolve);
    client.once("error", reject);
  });

  const baseTopic = `mcu/${tenantCode}/${vesselCode}/${edgeCode}`;
  const duplicateMsgId = randomUUID();

  const messages = [
    {
      topic: `${baseTopic}/heartbeat`,
      body: envelope({
        firmware_version: "1.0.0",
        cpu_usage_pct: 23.5,
        ram_usage_pct: 54.2,
        status: "online",
        public_wan_ip: publicWanIp
      })
    },
    {
      topic: `${baseTopic}/telemetry`,
      body: envelope(
        {
          active_uplink: "starlink",
          latency_ms: 41.5,
          loss_pct: 0.05,
          jitter_ms: 5.2,
          throughput_kbps: 9820,
          rx_kbps: 6020,
          tx_kbps: 3800,
          public_wan_ip: publicWanIp,
          interfaces: [
            {
              name: "starlink",
              rx_kbps: 6000,
              tx_kbps: 3800
            },
            {
              name: "ether1",
              rx_kbps: 20,
              tx_kbps: 0
            }
          ]
        },
        duplicateMsgId
      )
    },
    {
      topic: `${baseTopic}/telemetry`,
      body: envelope(
        {
          active_uplink: "starlink",
          latency_ms: 41.5,
          loss_pct: 0.05,
          jitter_ms: 5.2,
          throughput_kbps: 9820
        },
        duplicateMsgId
      )
    },
    {
      topic: `${baseTopic}/usage`,
      body: envelope({
        username: "crew01",
        session_id: randomUUID(),
        upload_mb: 125.4,
        download_mb: 512.7
      })
    },
    {
      topic: `${baseTopic}/event`,
      body: envelope({
        event_type: "link_down",
        severity: "warning",
        details: {
          link: "starlink",
          reason: "packet_loss_high"
        }
      })
    },
    {
      topic: `${baseTopic}/vms`,
      body: envelope({
        latitude: 10.8231,
        longitude: 106.6297,
        speed_knots: 9.8,
        heading_deg: 135.5
      })
    }
  ];

  for (const message of messages) {
    await publishAsync(client, message.topic, message.body);
    console.log(`[phase2 publish] ${message.topic} msg_id=${message.body.msg_id}`);
  }

  client.end(true);
  console.log("[phase2 publish] completed");
}

run().catch((error) => {
  console.error("[phase2 publish] failed:", error.message);
  process.exit(1);
});
