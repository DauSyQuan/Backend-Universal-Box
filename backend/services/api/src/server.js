import { createServer } from "node:http";
import { getHealth, getReady } from "./health.js";
import { pingDb } from "./db.js";

const port = Number(process.env.PORT || 3000);

const sendJson = (res, statusCode, data) => {
  res.writeHead(statusCode, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data));
};

const server = createServer(async (req, res) => {
  if (req.url === "/api/health" && req.method === "GET") {
    sendJson(res, 200, getHealth());
    return;
  }

  if (req.url === "/api/ready" && req.method === "GET") {
    try {
      const database = await pingDb();
      const ready = getReady({ database });
      sendJson(res, database ? 200 : 503, ready);
    } catch {
      sendJson(res, 503, getReady({ database: false }));
    }
    return;
  }

  sendJson(res, 404, { error: "not_found" });
});

server.listen(port, () => {
  console.log(`[api] listening on http://localhost:${port}`);
});
