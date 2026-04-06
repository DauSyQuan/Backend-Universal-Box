import "dotenv/config";
import { createServer } from "node:http";
import { isIP } from "node:net";
import mqtt from "mqtt";
import { getHealth, getReady } from "./health.js";
import { pingDb } from "./db.js";
import {
  getMcuEdgeDetail,
  getMcuEdgeDetailByWanIp,
  getMcuEdgeTraffic,
  getMcuEdgeTrafficByWanIp,
  listMcuEdges,
  registerMcuEdge,
  streamMcuTelemetry
} from "./mcu.js";
import { maybeServeStatic } from "./static.js";

const mqttUrl = process.env.MQTT_URL || "mqtt://localhost:1883";
const mqttClient = mqtt.connect(mqttUrl, {
  username: process.env.MQTT_USERNAME || undefined,
  password: process.env.MQTT_PASSWORD || undefined
});

const sendJson = (res, statusCode, data) => {
  res.writeHead(statusCode, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data));
};

const getHeaderValue = (headers, name) => {
  const value = headers[name];
  if (Array.isArray(value)) {
    return value[0] ?? null;
  }
  return value ?? null;
};

const normalizeIpCandidate = (value) => {
  if (!value) {
    return null;
  }

  const trimmed = String(value).trim();
  if (!trimmed) {
    return null;
  }

  const normalized = trimmed.startsWith("::ffff:") ? trimmed.slice(7) : trimmed;
  return isIP(normalized) ? normalized : null;
};

const isPublicIpCandidate = (value) => {
  const normalized = normalizeIpCandidate(value);
  if (!normalized) {
    return false;
  }

  if (normalized.includes(":")) {
    const lowered = normalized.toLowerCase();
    return !(
      lowered === "::1" ||
      lowered === "::" ||
      lowered.startsWith("fe80:") ||
      lowered.startsWith("fc") ||
      lowered.startsWith("fd")
    );
  }

  if (
    normalized.startsWith("10.") ||
    normalized.startsWith("127.") ||
    normalized.startsWith("169.254.") ||
    normalized.startsWith("192.168.")
  ) {
    return false;
  }

  const octets = normalized.split(".").map((part) => Number(part));
  if (octets.length !== 4 || octets.some((part) => !Number.isInteger(part))) {
    return false;
  }

  if (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) {
    return false;
  }

  return true;
};

const getRequestIp = (req) => {
  const forwardedFor = getHeaderValue(req.headers, "x-forwarded-for");
  if (forwardedFor) {
    const [first] = String(forwardedFor).split(",");
    const candidate = normalizeIpCandidate(first);
    if (isPublicIpCandidate(candidate)) {
      return candidate;
    }
  }

  const realIp = getHeaderValue(req.headers, "x-real-ip");
  const realCandidate = normalizeIpCandidate(realIp);
  if (isPublicIpCandidate(realCandidate)) {
    return realCandidate;
  }

  const remoteCandidate = normalizeIpCandidate(req.socket?.remoteAddress ?? null);
  return isPublicIpCandidate(remoteCandidate) ? remoteCandidate : null;
};

const readJsonBody = async (req, maxBytes = 1_000_000) => {
  let total = 0;
  const chunks = [];
  for await (const chunk of req) {
    total += chunk.length;
    if (total > maxBytes) {
      const err = new Error("payload_too_large");
      err.code = "payload_too_large";
      throw err;
    }
    chunks.push(chunk);
  }

  if (chunks.length === 0) {
    return {};
  }

  const raw = Buffer.concat(chunks).toString("utf8");
  try {
    return JSON.parse(raw);
  } catch {
    const err = new Error("invalid_json");
    err.code = "invalid_json";
    throw err;
  }
};

const server = createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);

  if (await maybeServeStatic(req, res, url)) {
    return;
  }

  if (url.pathname === "/api/health" && req.method === "GET") {
    sendJson(res, 200, getHealth());
    return;
  }

  if (url.pathname === "/api/ready" && req.method === "GET") {
    try {
      const database = await pingDb();
      const ready = getReady({ database });
      sendJson(res, database ? 200 : 503, ready);
    } catch {
      sendJson(res, 503, getReady({ database: false }));
    }
    return;
  }

  if (url.pathname === "/api/mcu/edges" && req.method === "GET") {
    const query = {
      tenantCode: url.searchParams.get("tenant") ?? url.searchParams.get("tenant_code"),
      vesselCode: url.searchParams.get("vessel") ?? url.searchParams.get("vessel_code"),
      wanIp:
        url.searchParams.get("wan_ip") ??
        url.searchParams.get("public_wan_ip") ??
        url.searchParams.get("public_ip") ??
        url.searchParams.get("ip"),
      limit: url.searchParams.get("limit"),
      onlineSeconds: url.searchParams.get("online_seconds")
    };

    try {
      const data = await listMcuEdges(query);
      sendJson(res, 200, data);
    } catch (error) {
      if (error?.code === "bad_request") {
        sendJson(res, 400, { error: error.message });
        return;
      }
      console.error("[api/mcu/edges] failed:", error);
      sendJson(res, 500, { error: "mcu_edges_query_failed" });
    }
    return;
  }

  if (url.pathname === "/api/mcu/edges/by-wan" && req.method === "GET") {
    try {
      const detail = await getMcuEdgeDetailByWanIp({
        publicWanIp:
          url.searchParams.get("wan_ip") ??
          url.searchParams.get("public_wan_ip") ??
          url.searchParams.get("public_ip") ??
          url.searchParams.get("ip"),
        onlineSeconds: url.searchParams.get("online_seconds")
      });

      if (!detail) {
        sendJson(res, 404, { error: "edge_not_found" });
        return;
      }

      sendJson(res, 200, detail);
    } catch (error) {
      if (error?.code === "bad_request") {
        sendJson(res, 400, { error: error.message });
        return;
      }
      console.error("[api/mcu/edges/by-wan] failed:", error);
      sendJson(res, 500, { error: "mcu_edge_detail_failed" });
    }
    return;
  }

  if (url.pathname === "/api/mcu/traffic/by-wan" && req.method === "GET") {
    try {
      const traffic = await getMcuEdgeTrafficByWanIp({
        publicWanIp:
          url.searchParams.get("wan_ip") ??
          url.searchParams.get("public_wan_ip") ??
          url.searchParams.get("public_ip") ??
          url.searchParams.get("ip"),
        interfaceName: url.searchParams.get("interface"),
        windowMinutes: url.searchParams.get("window_minutes"),
        limit: url.searchParams.get("limit")
      });

      if (!traffic) {
        sendJson(res, 404, { error: "edge_not_found" });
        return;
      }

      sendJson(res, 200, traffic);
    } catch (error) {
      if (error?.code === "bad_request") {
        sendJson(res, 400, { error: error.message });
        return;
      }
      console.error("[api/mcu/traffic/by-wan] failed:", error);
      sendJson(res, 500, { error: "mcu_edge_traffic_failed" });
    }
    return;
  }

  if (url.pathname.startsWith("/api/mcu/edges/") && req.method === "GET") {
    const parts = url.pathname.split("/").filter(Boolean);
    if (parts.length === 7 && parts[6] === "stream") {
      const tenantCode = parts[3];
      const vesselCode = parts[4];
      const edgeCode = parts[5];

      try {
        await streamMcuTelemetry(req, res, { tenantCode, vesselCode, edgeCode });
      } catch (error) {
        console.error("[api/mcu/edges/stream] failed:", error);
        res.end();
      }
      return;
    }

    if (parts.length === 7 && parts[6] === "traffic") {
      const tenantCode = parts[3];
      const vesselCode = parts[4];
      const edgeCode = parts[5];

      try {
        const traffic = await getMcuEdgeTraffic({
          tenantCode,
          vesselCode,
          edgeCode,
          interfaceName: url.searchParams.get("interface"),
          windowMinutes: url.searchParams.get("window_minutes"),
          limit: url.searchParams.get("limit")
        });

        if (!traffic) {
          sendJson(res, 404, { error: "edge_not_found" });
          return;
        }

        sendJson(res, 200, traffic);
      } catch (error) {
        console.error("[api/mcu/edges/:tenant/:vessel/:edge/traffic] failed:", error);
        sendJson(res, 500, { error: "mcu_edge_traffic_failed" });
      }
      return;
    }

    if (parts.length !== 6) {
      sendJson(res, 400, { error: "invalid_path" });
      return;
    }

    const tenantCode = parts[3];
    const vesselCode = parts[4];
    const edgeCode = parts[5];
    const onlineSeconds = url.searchParams.get("online_seconds");

    try {
      const detail = await getMcuEdgeDetail({
        tenantCode,
        vesselCode,
        edgeCode,
        onlineSeconds
      });

      if (!detail) {
        sendJson(res, 404, { error: "edge_not_found" });
        return;
      }

      sendJson(res, 200, detail);
    } catch (error) {
      console.error("[api/mcu/edges/:tenant/:vessel/:edge] failed:", error);
      sendJson(res, 500, { error: "mcu_edge_detail_failed" });
    }
    return;
  }

  if (url.pathname === "/api/mcu/register" && req.method === "POST") {
    try {
      const body = await readJsonBody(req);
      const result = await registerMcuEdge({
        ...body,
        detected_public_wan_ip: getRequestIp(req)
      });
      sendJson(res, 201, {
        ok: true,
        ...result
      });
    } catch (error) {
      if (error?.code === "invalid_json") {
        sendJson(res, 400, { error: "invalid_json" });
        return;
      }
      if (error?.code === "payload_too_large") {
        sendJson(res, 413, { error: "payload_too_large" });
        return;
      }
      if (error?.code === "bad_request") {
        sendJson(res, 400, { error: error.message });
        return;
      }
      console.error("[api/mcu/register] failed:", error);
      sendJson(res, 500, { error: "mcu_register_failed" });
    }
    return;
  }

  sendJson(res, 404, { error: "not_found" });
});

const port = Number(process.env.PORT || 3000);
server.listen(port, () => {
  console.log(`[api] listening on http://localhost:${port}`);
});
