import { WebSocket, WebSocketServer } from "ws";
import { pool, pingDb } from "./db.js";
import { getHealth, getReady, getMemoryHealth } from "./health.js";
import { getCommandJob, listMcuEdges } from "./mcu.js";
import { realtimeBus } from "../../../shared/realtime-bus.js";
import { createLogger } from "../../../shared/logger.js";

const console = createLogger("api:realtime");
const clients = new Map();
let attached = false;
let bridgeClient = null;
let healthBroadcastTimer = null;
let healthBroadcastInFlight = false;

function normalizeSubscription(value) {
  const text = String(value ?? "").trim();
  if (!text) {
    return null;
  }

  const parts = text.split("/").map((part) => part.trim()).filter(Boolean);
  if (parts.length === 3) {
    return {
      tenantCode: parts[0] || null,
      vesselCode: parts[1] || null,
      edgeCode: parts[2] || null
    };
  }

  return {
    tenantCode: null,
    vesselCode: text,
    edgeCode: null
  };
}

function normalizeSubscriptionObject(value) {
  if (!value || typeof value !== "object") {
    return null;
  }

  const tenantCode = String(value.tenantCode ?? value.tenant_code ?? "").trim() || null;
  const vesselCode = String(value.vesselCode ?? value.vessel_code ?? value.vessel ?? value.subscribe ?? "").trim() || null;
  const edgeCode = String(value.edgeCode ?? value.edge_code ?? value.edge ?? "").trim() || null;

  if (!tenantCode && !vesselCode && !edgeCode) {
    return null;
  }

  return { tenantCode, vesselCode, edgeCode };
}

function normalizeSubscriptionValue(value) {
  return typeof value === "string" ? normalizeSubscription(value) : normalizeSubscriptionObject(value);
}

function matchesSubscription(subscription, payload) {
  if (!subscription || !payload) {
    return false;
  }

  const tenantMatch = subscription.tenantCode && payload.tenant_code && subscription.tenantCode === payload.tenant_code;
  const vesselMatch = subscription.vesselCode && payload.vessel_code && subscription.vesselCode === payload.vessel_code;
  const edgeMatch = subscription.edgeCode && payload.edge_code && subscription.edgeCode === payload.edge_code;

  return Boolean(edgeMatch || vesselMatch || tenantMatch);
}

function sendJson(ws, payload) {
  if (ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify(payload));
}

function broadcastToClients(payload, matcher = null) {
  for (const [ws, state] of clients.entries()) {
    if (matcher && !matcher(state, payload)) continue;
    sendJson(ws, payload);
  }
}

function sendCommandEvent(payload) {
  const command = payload?.command && typeof payload.command === "object" ? payload.command : payload;
  if (!command) {
    return;
  }

  broadcastToClients(
    {
      type: "command",
      action: payload?.action ?? null,
      tenant_code: command.tenant_code ?? payload?.tenant_code ?? null,
      vessel_code: command.vessel_code ?? payload?.vessel_code ?? null,
      edge_code: command.edge_code ?? payload?.edge_code ?? null,
      command
    },
    (state, event) => matchesSubscription(state, event)
  );
}

function sendPackageEvent(payload) {
  const pkg = payload?.package && typeof payload.package === "object" ? payload.package : payload;
  if (!pkg) {
    return;
  }

  broadcastToClients(
    {
      type: "package",
      action: payload?.action ?? null,
      tenant_code: pkg.tenant_code ?? payload?.tenant_code ?? null,
      vessel_code: pkg.vessel_code ?? payload?.vessel_code ?? null,
      package: pkg
    },
    (state, event) => {
      const statePayload = {
        tenant_code: event.tenant_code ?? null,
        vessel_code: event.vessel_code ?? null,
        edge_code: null
      };
      return matchesSubscription(state, statePayload);
    }
  );
}

function sendHotspotAccountEvent(payload) {
  const account = payload?.account && typeof payload.account === "object" ? payload.account : null;
  if (!account) {
    return;
  }

  broadcastToClients(
    {
      type: "hotspot_account",
      action: payload?.action ?? null,
      tenant_code: account.tenant_code ?? payload?.tenant_code ?? null,
      vessel_code: account.vessel_code ?? payload?.vessel_code ?? null,
      edge_code: account.edge_code ?? payload?.edge_code ?? null,
      status: payload?.status ?? account.status ?? null,
      observed_at: payload?.observed_at ?? account.updated_at ?? account.created_at ?? null,
      account
    },
    (state, event) => matchesSubscription(state, event)
  );
}

function sendHotspotDirectoryEvent(payload) {
  broadcastToClients(
    {
      type: "hotspot_user_directory",
      action: payload?.action ?? null,
      tenant_code: payload?.tenant_code ?? null,
      vessel_code: payload?.vessel_code ?? null,
      edge_code: payload?.edge_code ?? null,
      observed_at: payload?.observed_at ?? null,
      count: payload?.count ?? null
    },
    (state, event) => matchesSubscription(state, event)
  );
}

function sendHotspotActiveEvent(payload) {
  broadcastToClients(
    {
      type: "hotspot_active_users",
      action: payload?.action ?? null,
      tenant_code: payload?.tenant_code ?? null,
      vessel_code: payload?.vessel_code ?? null,
      edge_code: payload?.edge_code ?? null,
      observed_at: payload?.observed_at ?? null,
      count: payload?.count ?? null
    },
    (state, event) => matchesSubscription(state, event)
  );
}

async function broadcastHealthSnapshot() {
  if (healthBroadcastInFlight || !clients.size) {
    return;
  }

  healthBroadcastInFlight = true;
  try {
    const [database, edges] = await Promise.all([
      pingDb().catch(() => null),
      listMcuEdges({ limit: 20, onlineSeconds: 120 }).catch(() => null)
    ]);
    const health = getHealth({
      database,
      memory: getMemoryHealth()
    });
    const ready = getReady({
      database: database?.ok ? database : { status: "error", message: "database_unavailable" }
    });
    const payload = {
      type: "health",
      health,
      ready,
      edges: edges ?? { total: 0, limit: 20, offset: 0, online_seconds: 120, items: [] }
    };
    broadcastToClients(payload);
  } catch (error) {
    console.error("[ws] health broadcast failed:", error?.message || error);
  } finally {
    healthBroadcastInFlight = false;
  }
}

function broadcastTelemetry(payload) {
  for (const [ws, state] of clients.entries()) {
    if (!matchesSubscription(state, payload)) continue;
    sendJson(ws, {
      type: "telemetry",
      tenant_code: payload.tenant_code ?? null,
      vessel_code: payload.vessel_code ?? null,
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

async function sendLatestTelemetrySnapshot(ws, subscription) {
  if (ws.readyState !== WebSocket.OPEN || !pool || !subscription) {
    return;
  }

  const params = [];
  const filters = [];

  if (subscription.tenantCode) {
    params.push(subscription.tenantCode);
    filters.push(`t.code = $${params.length}`);
  }

  if (subscription.vesselCode) {
    params.push(subscription.vesselCode);
    filters.push(`v.code = $${params.length}`);
  }

  if (subscription.edgeCode) {
    params.push(subscription.edgeCode);
    filters.push(`e.edge_code = $${params.length}`);
  }

  if (filters.length === 0) {
    return;
  }

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
      where ${filters.join(" and ")}
      order by t.observed_at desc
      limit 1
    `,
    params
  );

  if (result.rowCount === 0) {
    return;
  }

  const row = result.rows[0];
  sendJson(ws, {
    type: "telemetry",
    tenant_code: row.tenant_code ?? null,
    vessel_code: row.vessel_code ?? null,
    edge_code: row.edge_code ?? null,
    observed_at: row.observed_at ?? null,
    active_uplink: row.active_uplink ?? null,
    latency_ms: row.latency_ms ?? null,
    loss_pct: row.loss_pct ?? null,
    rx_kbps: row.rx_kbps ?? null,
    tx_kbps: row.tx_kbps ?? null,
    throughput_kbps: row.throughput_kbps ?? null,
    interfaces: Array.isArray(row.interfaces) ? row.interfaces : []
  });
}

async function ensureTelemetryBridge() {
  if (bridgeClient || !pool) return;

  bridgeClient = await pool.connect();
  await bridgeClient.query("LISTEN mcu_telemetry_stream");
  await bridgeClient.query("LISTEN command_job_updates");
  await bridgeClient.query("LISTEN hotspot_account_updates");
  await bridgeClient.query("LISTEN hotspot_user_directory_updates");
  await bridgeClient.query("LISTEN hotspot_active_user_updates");

  bridgeClient.on("notification", async (msg) => {
    try {
      if (msg.channel === "mcu_telemetry_stream") {
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
        return;
      }

      if (msg.channel === "command_job_updates") {
        const payload = JSON.parse(msg.payload || "{}");
        const jobId = String(payload.job_id ?? payload.command_job_id ?? payload.msg_id ?? "").trim();
        if (!jobId) {
          return;
        }

        const job = await getCommandJob(jobId);
        if (!job) {
          return;
        }

        realtimeBus.emit("command", {
          action: String(payload.action ?? "status").trim() || "status",
          command: job,
          tenant_code: job.tenant_code ?? null,
          vessel_code: job.vessel_code ?? null,
          edge_code: job.edge_code ?? null
        });
        return;
      }

      if (msg.channel === "hotspot_account_updates") {
        const payload = JSON.parse(msg.payload || "{}");
        const jobId = String(payload.job_id ?? payload.command_job_id ?? "").trim();
        if (!jobId) {
          return;
        }

        const result = await pool.query(
          `
            select
              ha.id,
              ha.command_job_id,
              ha.tenant_code,
              ha.vessel_code,
              ha.edge_code,
              ha.username,
              ha.profile,
              ha.qos,
              ha.status,
              ha.ack_at,
              ha.result_at,
              coalesce(
                nullif(ha.result_payload->>'message', ''),
                nullif(ha.result_payload->>'detail', ''),
                nullif(ha.result_payload->>'status', '')
              ) as result_message,
              ha.result_payload,
              ha.created_at,
              ha.updated_at
            from hotspot_accounts ha
            where ha.command_job_id = $1
            limit 1
          `,
          [jobId]
        );

        if (!result.rowCount) {
          return;
        }

        const account = result.rows[0];
        realtimeBus.emit("hotspot_account", {
          action: String(payload.action ?? "upsert").trim() || "upsert",
          tenant_code: account.tenant_code ?? payload.tenant_code ?? null,
          vessel_code: account.vessel_code ?? payload.vessel_code ?? null,
          edge_code: account.edge_code ?? payload.edge_code ?? null,
          status: account.status ?? payload.status ?? null,
          observed_at: payload.observed_at ?? account.updated_at ?? account.created_at ?? null,
          account
        });
        return;
      }

      if (msg.channel === "hotspot_user_directory_updates") {
        const payload = JSON.parse(msg.payload || "{}");
        realtimeBus.emit("hotspot_user_directory", payload);
        return;
      }

      if (msg.channel === "hotspot_active_user_updates") {
        const payload = JSON.parse(msg.payload || "{}");
        realtimeBus.emit("hotspot_active_users", payload);
      }
    } catch (error) {
      console.error("[ws] realtime bridge failed:", error?.message || error);
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

  console.log("[ws] realtime bridge listening on mcu_telemetry_stream, command_job_updates, hotspot_account_updates, hotspot_user_directory_updates, hotspot_active_user_updates");
}

export function attachRealtimeServer(server) {
  if (attached) return;
  attached = true;
  ensureTelemetryBridge().catch((error) => {
    console.error("[ws] failed to start telemetry bridge:", error);
  });
  if (!healthBroadcastTimer) {
    healthBroadcastTimer = setInterval(() => {
      broadcastHealthSnapshot().catch((error) => {
        console.error("[ws] health broadcast timer failed:", error?.message || error);
      });
    }, 5000);
    broadcastHealthSnapshot().catch((error) => {
      console.error("[ws] initial health broadcast failed:", error?.message || error);
    });
  }

  realtimeBus.on("command", sendCommandEvent);
  realtimeBus.on("package", sendPackageEvent);
  realtimeBus.on("hotspot_account", sendHotspotAccountEvent);
  realtimeBus.on("hotspot_user_directory", sendHotspotDirectoryEvent);
  realtimeBus.on("hotspot_active_users", sendHotspotActiveEvent);

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
    clients.set(ws, { tenantCode: null, vesselCode: null, edgeCode: null, subscribedAt: null });
    sendJson(ws, { type: "connected", message: "send {\"subscribe\":\"vsl-001\"} or {\"subscribe\":\"tnr/vsl/edge\"} to start" });
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

      const subscription = normalizeSubscriptionValue(message?.subscribe);
      if (!subscription) {
        sendJson(ws, { type: "error", error: "subscribe_required" });
        return;
      }

      clients.set(ws, {
        ...subscription,
        subscribedAt: new Date().toISOString()
      });

      sendJson(ws, {
        type: "subscribed",
        tenant_code: subscription.tenantCode ?? null,
        vessel_code: subscription.vesselCode ?? null,
        edge_code: subscription.edgeCode ?? null
      });
      console.log(
        `[ws] client subscribed tenant=${subscription.tenantCode || "*"} vessel=${subscription.vesselCode || "*"} edge=${subscription.edgeCode || "*"}`
      );

      sendLatestTelemetrySnapshot(ws, subscription).catch((error) => {
        console.error("[ws] initial telemetry snapshot failed:", error?.message || error);
      });
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
