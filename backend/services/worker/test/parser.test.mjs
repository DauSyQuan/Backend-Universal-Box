import test from "node:test";
import assert from "node:assert/strict";
import {
  parseEnvelope,
  parseTopic,
  validateAndNormalizePayload,
  validateEnvelope,
  detectLinkDownEvent
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

test("parseEnvelope preserves missing msg_id without generating a random one", () => {
  const raw = Buffer.from(
    JSON.stringify({
      timestamp: "2026-04-01T03:00:00Z",
      schema_version: "v1",
      payload: { latency_ms: 10 }
    }),
    "utf8"
  );

  const envelope = parseEnvelope(raw);
  assert.equal(envelope.msgId, null);
  assert.equal(envelope.timestamp, "2026-04-01T03:00:00Z");
  assert.equal(envelope.schemaVersion, "v1");
  assert.equal(envelope.payload.latency_ms, 10);
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

test("validateEnvelope rejects blank msg_id", () => {
  const result = validateEnvelope({
    msgId: "",
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

test("detectLinkDownEvent returns a warning for a starlink interface down", () => {
  const result = detectLinkDownEvent({
    active_uplink: "starlink",
    interfaces: [
      { name: "starlink", status: "DOWN", rx_kbps: 0, tx_kbps: 0 }
    ]
  });

  assert.deepEqual(result, {
    link: "starlink",
    reason: "interface_down"
  });
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

test("validateAndNormalizePayload keeps public WAN IP aliases", () => {
  const result = validateAndNormalizePayload("telemetry", {
    public_ip: "::ffff:65.181.17.76",
    rx_kbps: 1200,
    tx_kbps: 300
  });

  assert.equal(result.valid, true);
  assert.equal(result.payload.public_wan_ip, "65.181.17.76");
});

test("validateAndNormalizePayload parses MCU telemetry data array and computes totals", () => {
  const result = validateAndNormalizePayload("telemetry", {
    data: [
      { p: "P1-STARLINK", s: "UP", in: 1000, out: 200, t: 1200 },
      { p: "P2-VSAT", s: "DOWN", in: 0, out: 0, t: 0 }
    ],
    latency: 15,
    packet_loss_pct: 0.01,
    ping_jitter_ms: 2.5
  });

  assert.equal(result.valid, true);
  assert.equal(result.payload.active_uplink, "P1-STARLINK");
  assert.equal(result.payload.latency_ms, 15);
  assert.equal(result.payload.loss_pct, 0.01);
  assert.equal(result.payload.jitter_ms, 2.5);
  assert.equal(result.payload.rx_kbps, 1000);
  assert.equal(result.payload.tx_kbps, 200);
  assert.equal(result.payload.throughput_kbps, 1200);
  assert.equal(result.payload.total_gb, 1200 / 1024);
  assert.equal(result.payload.interfaces.length, 2);
});

test("validateAndNormalizePayload rejects invalid public WAN IP", () => {
  const result = validateAndNormalizePayload("heartbeat", {
    wan_ip: "not-an-ip"
  });

  assert.equal(result.valid, false);
  assert.match(result.errors.join(" "), /public_wan_ip/i);
});

test("validateAndNormalizePayload validates ack payload", () => {
  const result = validateAndNormalizePayload("ack", {
    msg_id: "cmd-001",
    status: "ack",
    message: "accepted"
  });

  assert.equal(result.valid, true);
  assert.equal(result.payload.command_job_id, "cmd-001");
  assert.equal(result.payload.status, "ack");
  assert.equal(result.payload.message, "accepted");
});

test("validateAndNormalizePayload validates result payload", () => {
  const result = validateAndNormalizePayload("result", {
    command_job_id: "cmd-001",
    status: "success",
    result_payload: { applied: true }
  });

  assert.equal(result.valid, true);
  assert.equal(result.payload.command_job_id, "cmd-001");
  assert.equal(result.payload.status, "success");
  assert.deepEqual(result.payload.result_payload, { applied: true });
});
