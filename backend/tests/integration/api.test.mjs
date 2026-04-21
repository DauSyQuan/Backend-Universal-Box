import { describe, it } from "node:test";
import assert from "node:assert/strict";

const baseUrl = process.env.API_BASE_URL || "http://127.0.0.1:3000";
const basicUser = process.env.API_TEST_BASIC_USER || process.env.BASIC_AUTH_USERNAME || "admin";
const basicPass = process.env.API_TEST_BASIC_PASS || process.env.BASIC_AUTH_PASSWORD || "123";

function basicAuthHeader(username, password) {
  return `Basic ${Buffer.from(`${username}:${password}`, "utf8").toString("base64")}`;
}

async function fetchJson(path, options = {}) {
  const res = await fetch(new URL(path, baseUrl), {
    ...options,
    headers: {
      accept: "application/json",
      ...(options.headers || {})
    }
  });
  const text = await res.text();
  let payload;
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    payload = { raw: text };
  }
  return { res, payload };
}

describe("API integration", { timeout: 30_000 }, () => {
  it("serves health and ready endpoints", async () => {
    const health = await fetchJson("/api/health");
    assert.equal(health.res.status, 200);
    assert.equal(health.payload.status, "ok");

    const ready = await fetchJson("/api/ready");
    assert.equal(ready.res.status, 200);
    assert.equal(ready.payload.status, "ready");
  });

  it("serves metrics without auth", async () => {
    const metrics = await fetch(new URL("/metrics", baseUrl));
    assert.equal(metrics.status, 200);
    const text = await metrics.text();
    assert.match(text, /http_requests_total/);
  });

  it("supports paginated edges and commands", async () => {
    const auth = basicAuthHeader(basicUser, basicPass);

    const edges = await fetchJson("/api/mcu/edges?limit=1&offset=0", {
      headers: { authorization: auth }
    });
    assert.equal(edges.res.status, 200);
    assert.ok(Array.isArray(edges.payload.items));
    assert.equal(edges.payload.limit, 1);

    const commands = await fetchJson("/api/commands?limit=1&offset=0", {
      headers: { authorization: auth }
    });
    assert.equal(commands.res.status, 200);
    assert.ok(Array.isArray(commands.payload.items));
    assert.equal(commands.payload.limit, 1);
  });
});
