import test from "node:test";
import assert from "node:assert/strict";
import {
  parseEnvelope,
  parseTopic,
  validateAndNormalizePayload,
  validateEnvelope
} from "../src/parser.js";

test("parseTopic parses valid topic", () => {
  const parsed = parseTopic("mcu/tnr13/vsl-001/edge-001/heartbeat");
  assert.deepEqual(parsed, {
    tenantCode: "tnr13",
    vesselCode: "vsl-001",
    edgeCode: "edge-001",
    channel: "heartbeat"
  });
});

test("validateEnvelope rejects missing msg_id", () => {
  const result = validateEnvelope({
    msgId: null,
    timestamp: "2026-04-01T03:00:00Z",
    schemaVersion: "v1"
  });
  assert.equal(result.valid, false);
  assert.match(result.errors.join(" "), /msg_id/i);
});

test("validateAndNormalizePayload validates usage payload", () => {
  const result = validateAndNormalizePayload("usage", {
    username: "crew01",
    upload_mb: "12.5",
    download_mb: 30
  });

  assert.equal(result.valid, true);
  assert.equal(result.payload.upload_mb, 12.5);
  assert.equal(result.payload.download_mb, 30);
});

test("validateAndNormalizePayload rejects invalid vms payload", () => {
  const result = validateAndNormalizePayload("vms", {
    latitude: 123,
    longitude: 106.5
  });

  assert.equal(result.valid, false);
  assert.match(result.errors.join(" "), /latitude/i);
});

test("parseEnvelope parses payload object", () => {
  const raw = Buffer.from(
    JSON.stringify({
      msg_id: "abc",
      timestamp: "2026-04-01T03:00:00Z",
      schema_version: "v1",
      payload: { latency_ms: 10 }
    }),
    "utf8"
  );

  const envelope = parseEnvelope(raw);
  assert.equal(envelope.msgId, "abc");
  assert.equal(envelope.payload.latency_ms, 10);
});

test("validateAndNormalizePayload maps RouterOS heartbeat aliases", () => {
  const result = validateAndNormalizePayload("heartbeat", {
    routeros_version: "7.17.2",
    cpu_load: 19,
    memory_used_pct: 41,
    state: "online"
  });

  assert.equal(result.valid, true);
  assert.equal(result.payload.firmware_version, "7.17.2");
  assert.equal(result.payload.cpu_usage_pct, 19);
  assert.equal(result.payload.ram_usage_pct, 41);
  assert.equal(result.payload.status, "online");
});

test("validateAndNormalizePayload computes throughput from rx+tx aliases", () => {
  const result = validateAndNormalizePayload("telemetry", {
    active_interface: "ether1",
    rtt_ms: 20,
    packet_loss_pct: 0.2,
    ping_jitter_ms: 1.5,
    rx_kbps: 1200,
    tx_kbps: 300
  });

  assert.equal(result.valid, true);
  assert.equal(result.payload.active_uplink, "ether1");
  assert.equal(result.payload.latency_ms, 20);
  assert.equal(result.payload.loss_pct, 0.2);
  assert.equal(result.payload.jitter_ms, 1.5);
  assert.equal(result.payload.throughput_kbps, 1500);
});
