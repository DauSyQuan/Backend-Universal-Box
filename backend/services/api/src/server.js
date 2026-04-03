import "dotenv/config";
import { createServer } from "node:http";
import { getHealth, getReady } from "./health.js";
import { pingDb } from "./db.js";
import { getMcuEdgeDetail, listMcuEdges, registerMcuEdge } from "./mcu.js";
import { getLiveCollectorStatus, getLiveMcuEdgeDetail, listLiveMcuEdges } from "./live-mcu.js";

const fallbackToLive = String(process.env.MCU_EDGES_FALLBACK_TO_LIVE ?? "true").toLowerCase() !== "false";

const sendJson = (res, statusCode, data) => {
  res.writeHead(statusCode, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data));
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
      limit: url.searchParams.get("limit"),
      onlineSeconds: url.searchParams.get("online_seconds")
    };

    const source = String(url.searchParams.get("source") || "").toLowerCase();
    if (source === "live") {
      const data = listLiveMcuEdges(query);
      sendJson(res, 200, data);
      return;
    }

    try {
      const data = await listMcuEdges(query);
      sendJson(res, 200, data);
    } catch (error) {
      if (fallbackToLive) {
        console.warn("[api/mcu/edges] db failed, fallback to live:", error?.message || String(error));
        const data = listLiveMcuEdges(query);
        sendJson(res, 200, data);
        return;
      }
      console.error("[api/mcu/edges] failed:", error);
      sendJson(res, 500, { error: "mcu_edges_query_failed" });
    }
    return;
  }

  if (url.pathname.startsWith("/api/mcu/edges/") && req.method === "GET") {
    const parts = url.pathname.split("/").filter(Boolean);
    if (parts.length !== 6) {
      sendJson(res, 400, { error: "invalid_path" });
      return;
    }

    const tenantCode = parts[3];
    const vesselCode = parts[4];
    const edgeCode = parts[5];
    const onlineSeconds = url.searchParams.get("online_seconds");
    const source = String(url.searchParams.get("source") || "").toLowerCase();

    if (source === "live") {
      const detail = getLiveMcuEdgeDetail({
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
      return;
    }

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
      if (fallbackToLive) {
        console.warn("[api/mcu/edge-detail] db failed, fallback to live:", error?.message || String(error));
        const detail = getLiveMcuEdgeDetail({
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
        return;
      }
      console.error("[api/mcu/edges/:tenant/:vessel/:edge] failed:", error);
      sendJson(res, 500, { error: "mcu_edge_detail_failed" });
    }
    return;
  }

  if (url.pathname === "/api/mcu/live/status" && req.method === "GET") {
    sendJson(res, 200, {
      source: "mqtt_live",
      collector: getLiveCollectorStatus()
    });
    return;
  }

  if (url.pathname === "/api/mcu/live/edges" && req.method === "GET") {
    const data = listLiveMcuEdges({
      tenantCode: url.searchParams.get("tenant") ?? url.searchParams.get("tenant_code"),
      vesselCode: url.searchParams.get("vessel") ?? url.searchParams.get("vessel_code"),
      limit: url.searchParams.get("limit"),
      onlineSeconds: url.searchParams.get("online_seconds")
    });
    sendJson(res, 200, data);
    return;
  }

  if (url.pathname.startsWith("/api/mcu/live/edges/") && req.method === "GET") {
    const parts = url.pathname.split("/").filter(Boolean);
    if (parts.length !== 7) {
      sendJson(res, 400, { error: "invalid_path" });
      return;
    }

    const detail = getLiveMcuEdgeDetail({
      tenantCode: parts[4],
      vesselCode: parts[5],
      edgeCode: parts[6],
      onlineSeconds: url.searchParams.get("online_seconds")
    });

    if (!detail) {
      sendJson(res, 404, { error: "edge_not_found" });
      return;
    }

    sendJson(res, 200, detail);
    return;
  }

  if (url.pathname === "/api/mcu/register" && req.method === "POST") {
    try {
      const body = await readJsonBody(req);
      const result = await registerMcuEdge(body);
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
