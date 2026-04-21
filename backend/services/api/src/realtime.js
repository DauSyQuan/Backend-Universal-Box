import { WebSocket, WebSocketServer } from "ws";
import { pool } from "./db.js";
import { realtimeBus } from "../../../shared/realtime-bus.js";
import { createLogger } from "../../../shared/logger.js";

const console = createLogger("api:realtime");
const clients = new Map();
let attached = false;
let bridgeClient = null;

function normalizeSubscription(value) {
  const text = String(value ?? "").trim();
  return text || null;
}

function sendJson(ws, payload) {
  if (ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify(payload));
}

function broadcastTelemetry(payload) {
  const vesselCode = normalizeSubscription(payload?.vessel_code);
  if (!vesselCode) return;

  for (const [ws, state] of clients.entries()) {
    if (state?.vesselCode !== vesselCode) continue;
    sendJson(ws, {
      type: "telemetry",
      vessel_code: vesselCode,
      edge_code: payload.edge_code ?? null,
      observed_at: payload.observed_at ?? null,
      active_uplink: payload.active_uplink ?? payload.active_interface ?? null,
      latency_ms: payload.latency_ms ?? null,
      loss_pct: payload.loss_pct ?? null,
      rx_kbps: payload.rx_kbps ?? null,
      tx_kbps: payload.tx_kbps ?? null,
      throughput_kbps: payload.throughput_kbps ?? null,
      interfaces: Array.isArray(payload.interfaces) ? payload.interfaces : []
    });
  }
}

function handleRealtimeTelemetry(payload) {
  broadcastTelemetry(payload);
}

async function ensureTelemetryBridge() {
  if (bridgeClient || !pool) return;

  bridgeClient = await pool.connect();
  await bridgeClient.query("LISTEN mcu_telemetry_stream");

  bridgeClient.on("notification", async (msg) => {
    if (msg.channel !== "mcu_telemetry_stream") return;
    try {
      const payload = JSON.parse(msg.payload || "{}");
      if (!payload?.telemetry_id) return;

      const result = await pool.query(
        `
          select
            t.id,
            t.observed_at,
            t.active_uplink,
            t.latency_ms,
            t.loss_pct,
            t.rx_kbps,
            t.tx_kbps,
            t.throughput_kbps,
            t.interfaces,
            te.code as tenant_code,
            v.code as vessel_code,
            e.edge_code
          from telemetry t
          join vessels v on v.id = t.vessel_id
          join tenants te on te.id = t.tenant_id
          left join edge_boxes e on e.id = t.edge_box_id
          where t.id = $1
          limit 1
        `,
        [payload.telemetry_id]
      );

      if (!result.rowCount) return;
      const row = result.rows[0];
      realtimeBus.emit("telemetry", {
        id: row.id,
        observed_at: row.observed_at,
        active_uplink: row.active_uplink ?? null,
        latency_ms: row.latency_ms ?? null,
        loss_pct: row.loss_pct ?? null,
        rx_kbps: row.rx_kbps ?? null,
        tx_kbps: row.tx_kbps ?? null,
        throughput_kbps: row.throughput_kbps ?? null,
        interfaces: Array.isArray(row.interfaces) ? row.interfaces : [],
        tenant_code: row.tenant_code ?? null,
        vessel_code: row.vessel_code ?? null,
        edge_code: row.edge_code ?? null
      });
    } catch (error) {
      console.error("[ws] telemetry bridge failed:", error?.message || error);
    }
  });

  bridgeClient.on("error", (error) => {
    console.error("[ws] telemetry bridge error:", error?.message || error);
    try {
      bridgeClient.release(true);
    } catch {}
    bridgeClient = null;
    setTimeout(() => {
      ensureTelemetryBridge().catch((err) => {
        console.error("[ws] telemetry bridge reconnect failed:", err?.message || err);
      });
    }, 2_000);
  });

  bridgeClient.on("end", () => {
    bridgeClient = null;
  });

  console.log("[ws] telemetry bridge listening on mcu_telemetry_stream");
}

export function attachRealtimeServer(server) {
  if (attached) return;
  attached = true;
  ensureTelemetryBridge().catch((error) => {
    console.error("[ws] failed to start telemetry bridge:", error);
  });

  const wss = new WebSocketServer({ noServer: true, path: "/ws" });

  server.on("upgrade", (request, socket, head) => {
    const url = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`);
    if (url.pathname !== "/ws") {
      return;
    }

    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit("connection", ws, request);
    });
  });

  wss.on("connection", (ws, request) => {
    clients.set(ws, { vesselCode: null, subscribedAt: null });
    sendJson(ws, { type: "connected", message: "send {\"subscribe\":\"vsl-001\"} to start" });
    console.log(`[ws] client connected from ${request.socket.remoteAddress || "unknown"}`);

    const heartbeat = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.ping();
      }
    }, 30_000);

    ws.on("message", (raw) => {
      let message;
      try {
        message = JSON.parse(raw.toString("utf8"));
      } catch {
        sendJson(ws, { type: "error", error: "invalid_json" });
        return;
      }

      const vesselCode = normalizeSubscription(message?.subscribe);
      if (!vesselCode) {
        sendJson(ws, { type: "error", error: "subscribe_required" });
        return;
      }

      clients.set(ws, {
        vesselCode,
        subscribedAt: new Date().toISOString()
      });

      sendJson(ws, {
        type: "subscribed",
        vessel_code: vesselCode
      });
      console.log(`[ws] client subscribed vessel=${vesselCode}`);
    });

    ws.on("close", () => {
      clearInterval(heartbeat);
      clients.delete(ws);
      console.log("[ws] client disconnected");
    });

    ws.on("error", (error) => {
      clearInterval(heartbeat);
      clients.delete(ws);
      console.error("[ws] client error:", error?.message || error);
    });
  });

  realtimeBus.on("telemetry", handleRealtimeTelemetry);
}
