import { describe, it } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import process from "node:process";
import dotenv from "dotenv";
import { Client } from "pg";

dotenv.config({ path: path.resolve(process.cwd(), "ops/.env") });
dotenv.config({ path: path.resolve(process.cwd(), "ops/env.example"), override: false });

const baseUrl = process.env.API_BASE_URL || "http://127.0.0.1:3000";
const basicUser = process.env.API_TEST_BASIC_USER || process.env.BASIC_AUTH_USERNAME || "admin";
const basicPass = process.env.API_TEST_BASIC_PASS || process.env.BASIC_AUTH_PASSWORD || "123";
const databaseUrl = process.env.DATABASE_URL;

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

function makeClient() {
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required for integration tests");
  }
  return new Client({ connectionString: databaseUrl });
}

describe("API operations integration", { timeout: 45_000 }, () => {
  it("authenticates the demo admin and enforces rate limits on login", async () => {
    const success = await fetchJson("/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: basicUser, password: basicPass })
    });

    assert.equal(success.res.status, 200);
    assert.ok(success.payload.access_token);
    assert.equal(success.payload.user?.role, "admin");

    let rateLimited = null;
    for (let attempt = 0; attempt < 11; attempt += 1) {
      rateLimited = await fetchJson("/api/auth/login", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-forwarded-for": "203.0.113.10"
        },
        body: JSON.stringify({ username: `bad-${attempt}`, password: "wrong-password" })
      });
    }

    assert.equal(rateLimited.res.status, 429);
    assert.equal(rateLimited.payload.error, "rate_limited");
  });

  it("creates and reads back a command job", async () => {
    const auth = basicAuthHeader(basicUser, basicPass);
    const created = await fetchJson("/api/commands", {
      method: "POST",
      headers: {
        authorization: auth,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        tenant_code: "tnr13",
        vessel_code: "vsl-001",
        edge_code: "edge-001",
        command_type: "policy_sync",
        command_payload: {
          preferred_uplink: "automatic",
          scope: "automatic",
          mode: "manual"
        }
      })
    });

    assert.equal(created.res.status, 201);
    assert.equal(created.payload.ok, true);
    assert.ok(created.payload.command?.id);

    const jobId = created.payload.command.id;
    const fetched = await fetchJson(`/api/commands/${jobId}`, {
      headers: { authorization: auth }
    });

    assert.equal(fetched.res.status, 200);
    assert.equal(fetched.payload.id, jobId);
    assert.equal(fetched.payload.command_type, "policy_sync");
  });

  it("rejects duplicate ingest message ids at the database layer", async () => {
    const client = makeClient();
    const msgId = `integration-${Date.now()}`;
    const topic = "mcu/tnr13/vsl-001/edge-001/telemetry";

    await client.connect();
    try {
      await client.query("delete from ingest_messages where msg_id = $1", [msgId]);

      await client.query(
        `
          insert into ingest_messages (topic, channel, msg_id, tenant_code, vessel_code, edge_code, payload, raw)
          values ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb)
        `,
        [
          topic,
          "telemetry",
          msgId,
          "tnr13",
          "vsl-001",
          "edge-001",
          JSON.stringify({ source: "integration-test" }),
          JSON.stringify({ source: "integration-test" })
        ]
      );

      await assert.rejects(
        client.query(
          `
            insert into ingest_messages (topic, channel, msg_id, tenant_code, vessel_code, edge_code, payload, raw)
            values ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb)
          `,
          [
            topic,
            "telemetry",
            msgId,
            "tnr13",
            "vsl-001",
            "edge-001",
            JSON.stringify({ source: "integration-test-duplicate" }),
            JSON.stringify({ source: "integration-test-duplicate" })
          ]
        ),
        (error) => error?.code === "23505"
      );
    } finally {
      await client.query("delete from ingest_messages where msg_id = $1", [msgId]).catch(() => {});
      await client.end();
    }
  });
});
