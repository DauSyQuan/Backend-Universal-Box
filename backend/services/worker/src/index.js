import dotenv from "dotenv";
import path from "node:path";
import process from "node:process";
import mqtt from "mqtt";
import { loadWorkerRuntimeConfig } from "../../../shared/config.js";
import { realtimeBus } from "../../../shared/realtime-bus.js";
import { createLogger } from "../../../shared/logger.js";
import {
  insertEvent,
  insertHeartbeat,
  insertIngestError,
  insertIngestMessage,
  insertTelemetry,
  insertUsage,
  insertVms,
  getCommandJob,
  markCommandJobAck,
  markCommandJobResult,
  syncHotspotAccountFromCommandJob,
  syncHotspotActiveUsersSnapshot,
  syncHotspotUserDirectorySnapshot,
  findHotspotCommandJobByReferenceId,
  markEdgeLastSeen,
  maybeCreateQuotaWarning,
  getEdgeLastSeenSnapshot,
  listStaleEdges,
  recordUsageWithQuota,
  pool,
  resolveEdgeContext,
  resolveTenantVesselContext,
  resolveUserId,
  updateEdgePublicWanIp,
  ensureEdgeExists,
  hasRecentEvent
} from "./db.js";
import {
  parseEnvelope,
  parseTopic,
  toObservedAt,
  validateAndNormalizePayload,
  validateEnvelope,
  detectLinkDownEvent
} from "./parser.js";

dotenv.config({ path: path.resolve(process.cwd(), "../../ops/.env") });
dotenv.config({ path: path.resolve(process.cwd(), "../../ops/env.example"), override: false });

const console = createLogger("worker");
const workerConfig = loadWorkerRuntimeConfig(process.env);
const mqttUrl = workerConfig.mqttUrl;
const mqttUsername = workerConfig.mqttUsername;
const mqttPassword = workerConfig.mqttPassword;
const qos = workerConfig.qos;
const observedAtMaxSkewSeconds = workerConfig.observedAtMaxSkewSeconds;
const inboundTopicFilters = [
  "mcu/+/+/+/heartbeat",
  "mcu/+/+/+/telemetry",
  "mcu/+/+/+/usage",
  "mcu/+/+/+/event",
  "mcu/+/+/+/vms",
  "mcu/+/+/+/command",
  "mcu/+/+/+/ack",
  "mcu/+/+/+/result",
  "tram1/reply/hotspot"
];

const HOTSPOT_REPLY_TOPIC = "tram1/reply/hotspot";

const mqttAutoProvision = workerConfig.mqttAutoProvision;
const mqttReconnectBaseMs = workerConfig.mqttReconnectBaseMs;
const mqttReconnectMaxMs = workerConfig.mqttReconnectMaxMs;
let mqttReconnectAttempts = 0;
let edgeSweepRunning = false;

const client = mqtt.connect(mqttUrl, {
  username: mqttUsername,
  password: mqttPassword,
  reconnectPeriod: mqttReconnectBaseMs,
  connectTimeout: 30_000
});

function normalizeTopicCode(value, aliases = {}) {
  const text = String(value ?? "").trim();
  if (!text) {
    return text;
  }
  return aliases[text] || text;
}

function normalizeParsedTopic(parsedTopic) {
  if (!parsedTopic) {
    return null;
  }

  return {
    ...parsedTopic,
    tenantCode: normalizeTopicCode(parsedTopic.tenantCode, workerConfig.topicAliases?.tenant),
    vesselCode: normalizeTopicCode(parsedTopic.vesselCode, workerConfig.topicAliases?.vessel),
    edgeCode: normalizeTopicCode(parsedTopic.edgeCode, workerConfig.topicAliases?.edge)
  };
}

function parseHotspotReplyPayload(rawBuffer) {
  const text = rawBuffer.toString("utf8");
  const parsed = JSON.parse(text);
  const parsedObject = parsed && typeof parsed === "object" ? parsed : {};
  const hasPayloadField = parsedObject.payload && typeof parsedObject.payload === "object";
  const payload = hasPayloadField ? parsedObject.payload : parsedObject;
  const action = String(
    payload.action ??
      parsedObject.action ??
      payload.command_action ??
      parsedObject.command_action ??
      ""
  ).trim().toLowerCase();
  const commandJobId = String(
    payload.command_job_id ??
      payload.commandJobId ??
      payload.job_id ??
      payload.msg_id ??
      payload.command_id ??
      parsedObject.command_job_id ??
      parsedObject.commandJobId ??
      parsedObject.job_id ??
      parsedObject.msg_id ??
      parsedObject.command_id ??
      ""
  ).trim();
  const referenceId = String(
    payload.reference_id ??
      payload.referenceId ??
      payload.params?.reference_id ??
      payload.params?.referenceId ??
      payload.name ??
      payload.params?.name ??
      payload.pool ??
      payload.pool_name ??
      payload.interface ??
      payload.username ??
      parsedObject.reference_id ??
      parsedObject.referenceId ??
      parsedObject.params?.reference_id ??
      parsedObject.params?.referenceId ??
      parsedObject.name ??
      parsedObject.params?.name ??
      parsedObject.pool ??
      parsedObject.pool_name ??
      parsedObject.interface ??
      parsedObject.username ??
      ""
  ).trim();
  const path = String(
    payload.path ??
      parsedObject.path ??
      ""
  ).trim();
  const method = String(
    payload.method ??
      parsedObject.method ??
      ""
  ).trim().toLowerCase();
  const username = String(
    payload.username ??
      payload.user ??
      payload.params?.username ??
      parsedObject.username ??
      parsedObject.user ??
      parsedObject.params?.username ??
      ""
  ).trim();
  const status = String(
    payload.status ??
      payload.result_status ??
      parsedObject.status ??
      parsedObject.result_status ??
      ""
  ).trim().toLowerCase();
  const normalizedStatus =
    status === "error" || status === "failed"
      ? "failed"
      : status === "ack" || status === "sent" || status === "success"
        ? status
        : payload.ok === false || parsedObject.ok === false
          ? "failed"
          : "success";

  return {
    raw: payload,
    action: action || null,
    path: path || null,
    method: method || null,
    commandJobId: commandJobId || null,
    referenceId: referenceId || null,
    username: username || null,
    status: normalizedStatus,
    observedAt: toObservedAt(payload.timestamp ?? payload.observed_at ?? payload.observedAt, {
      maxSkewSeconds: Number.isFinite(observedAtMaxSkewSeconds) ? observedAtMaxSkewSeconds : 300
    })
  };
}

async function saveIngestError(errorData) {
  try {
    await insertIngestError(errorData);
  } catch (error) {
    const message = error?.message || String(error);
    console.error("[worker] failed to persist ingest error:", message);
  }
}

function hasResolvedEdgeContext(context) {
  return Boolean(context?.tenant_id && context?.vessel_id && context?.edge_box_id);
}

async function resolveRequiredEdgeContext(parsedTopic) {
  const context = mqttAutoProvision
    ? await ensureEdgeExists({
        tenantCode: parsedTopic.tenantCode,
        vesselCode: parsedTopic.vesselCode,
        edgeCode: parsedTopic.edgeCode
      })
    : await resolveEdgeContext({
        tenantCode: parsedTopic.tenantCode,
        vesselCode: parsedTopic.vesselCode,
        edgeCode: parsedTopic.edgeCode
      });

  return hasResolvedEdgeContext(context) ? context : null;
}

async function sweepOfflineEdges() {
  if (edgeSweepRunning) {
    return;
  }

  edgeSweepRunning = true;
  try {
    const staleEdges = await listStaleEdges({ olderThanMinutes: 2, limit: 500 });
    for (const edge of staleEdges) {
      const hasRecentOffline = await hasRecentEvent({
        vesselId: edge.vessel_id,
        edgeBoxId: edge.edge_box_id,
        eventType: "edge_offline",
        withinSeconds: 600
      });
      if (hasRecentOffline) {
        continue;
      }

      await insertEvent({
        context: {
          tenant_id: edge.tenant_id,
          vessel_id: edge.vessel_id,
          edge_box_id: edge.edge_box_id
        },
        payload: {
          event_type: "edge_offline",
          severity: "warning",
          details: {
            edge_code: edge.edge_code,
            last_seen_at: edge.last_seen_at,
            created_at: edge.created_at,
            reason: "last_seen_timeout"
          }
        },
        observedAt: new Date().toISOString()
      });
      console.log(
        `[worker] edge_offline event created vessel=${edge.vessel_code} edge=${edge.edge_code} last_seen=${edge.last_seen_at ?? edge.created_at}`
      );
    }
  } catch (error) {
    console.error("[worker] edge offline sweep failed:", error);
  } finally {
    edgeSweepRunning = false;
  }
}

const edgeSweepInterval = setInterval(() => {
  sweepOfflineEdges().catch((error) => {
    console.error("[worker] edge offline sweep error:", error);
  });
}, 60_000);
edgeSweepInterval.unref?.();

sweepOfflineEdges().catch((error) => {
  console.error("[worker] initial edge offline sweep failed:", error);
});

client.on("connect", () => {
  console.log(`[worker] connected to broker ${mqttUrl}`);
  mqttReconnectAttempts = 0;
  client.options.reconnectPeriod = mqttReconnectBaseMs;
  client.subscribe(inboundTopicFilters, { qos }, (error) => {
    if (error) {
      console.error("[worker] subscribe failed:", error.message);
      return;
    }
    console.log(`[worker] subscribed ${inboundTopicFilters.join(", ")} qos=${qos}`);
  });
});

client.on("reconnect", () => {
  mqttReconnectAttempts += 1;
  const jitter = Math.floor(Math.random() * 250);
  const backoff = Math.min(mqttReconnectMaxMs, mqttReconnectBaseMs * 2 ** Math.min(mqttReconnectAttempts - 1, 5)) + jitter;
  client.options.reconnectPeriod = backoff;
  console.log(`[worker] reconnecting to broker attempt=${mqttReconnectAttempts} backoff=${backoff}ms`);
});

client.on("error", (error) => {
  const message = error?.message || String(error);
  console.error("[worker] mqtt error:", message);
});

  client.on("message", async (topic, payloadBuffer) => {
    if (topic === HOTSPOT_REPLY_TOPIC) {
      let reply;
      try {
        reply = parseHotspotReplyPayload(payloadBuffer);
    } catch (error) {
      const message = error?.message || String(error);
      console.error(`[worker] failed parsing hotspot reply topic=${topic}: ${message}`);
      await saveIngestError({
        topic,
        channel: "hotspot_reply",
        reason: "invalid_json",
        detail: message,
        raw: { raw_text: payloadBuffer.toString("utf8") }
        });
        return;
      }

      const replyLookupName = reply.referenceId || reply.username || null;

      if (!reply.commandJobId && replyLookupName) {
        try {
          const matchedJob = await findHotspotCommandJobByReferenceId({
            referenceId: replyLookupName,
            lookbackHours: 24
          });
          if (matchedJob?.command_job_id) {
            reply.commandJobId = matchedJob.command_job_id;
            console.log(
              `[worker] hotspot reply matched by reference reference=${replyLookupName} job_id=${reply.commandJobId}`
            );
          }
        } catch (error) {
          console.error("[worker] hotspot reference lookup failed:", error?.message || error);
        }
      }

      const ingest = await insertIngestMessage({
        topic,
        channel: "hotspot_reply",
        msgId: reply.commandJobId,
        tenantCode: null,
        vesselCode: null,
        edgeCode: null,
        schemaVersion: "v1",
        payload: reply.raw,
      raw: reply.raw
    });

    if (!ingest.inserted) {
      console.log(`[worker] duplicate hotspot reply skipped job_id=${reply.commandJobId || "n/a"}`);
      return;
    }

      if (!reply.commandJobId) {
        await saveIngestError({
          topic,
          channel: "hotspot_reply",
          reason: "command_job_not_found",
          detail: replyLookupName
            ? `hotspot reply missing command_job_id/msg_id for reference=${replyLookupName}`
            : "hotspot reply missing command_job_id/msg_id",
          raw: reply.raw
        });
        return;
      }

      const job = await getCommandJob(reply.commandJobId);
      const context = job
        ? {
            tenant_id: job.tenant_id,
            tenant_code: job.tenant_code,
            vessel_id: job.vessel_id,
            vessel_code: job.vessel_code,
            edge_box_id: job.edge_box_id,
            edge_code: job.edge_code
          }
        : null;

      if (reply.action === "get_all_users" && context) {
        const users = Array.isArray(reply.raw?.data) ? reply.raw.data : Array.isArray(reply.raw?.users) ? reply.raw.users : [];
        try {
          await syncHotspotUserDirectorySnapshot({
            context,
            users,
            observedAt: reply.observedAt,
            sourceAction: reply.action,
            sourceJobId: reply.commandJobId,
            sourcePayload: reply.raw
          });
        } catch (error) {
          console.error("[worker] hotspot directory sync failed:", error?.message || error);
        }
      }

      if (reply.action === "get_active_users" && context) {
        const users = Array.isArray(reply.raw?.data) ? reply.raw.data : Array.isArray(reply.raw?.users) ? reply.raw.users : [];
        try {
          await syncHotspotActiveUsersSnapshot({
            context,
            users,
            observedAt: reply.observedAt,
            sourceAction: reply.action,
            sourceJobId: reply.commandJobId
          });
        } catch (error) {
          console.error("[worker] hotspot active sync failed:", error?.message || error);
        }
      }

      const updated = await markCommandJobResult({
        jobId: reply.commandJobId,
        status: reply.status || "success",
        payload: reply.raw,
        observedAt: reply.observedAt
    });

    if (!updated) {
      await saveIngestError({
        topic,
        channel: "hotspot_reply",
        msgId: reply.commandJobId,
        reason: "command_job_not_found",
        detail: "hotspot reply did not match an existing command job",
        raw: reply.raw
      });
      return;
    }

    console.log(`[worker] hotspot reply stored topic=${topic} job_id=${reply.commandJobId} status=${reply.status}`);
    return;
  }

  const parsedTopic = normalizeParsedTopic(parseTopic(topic));
  if (!parsedTopic) {
    console.warn(`[worker] ignore invalid topic: ${topic}`);
    await saveIngestError({
      topic,
      reason: "invalid_topic",
      detail: "Topic format must be mcu/{tenant}/{vessel}/{edge}/{channel}"
    });
    return;
  }

  let envelope;
  try {
    envelope = parseEnvelope(payloadBuffer);
  } catch (error) {
    const message = error?.message || String(error);
    console.error(`[worker] failed parsing payload topic=${topic}: ${message}`);
    await saveIngestError({
      topic,
      channel: parsedTopic.channel,
      reason: "invalid_json",
      detail: message,
      raw: { raw_text: payloadBuffer.toString("utf8") }
    });
    return;
  }

  const observedAt = toObservedAt(envelope.timestamp, {
    maxSkewSeconds: Number.isFinite(observedAtMaxSkewSeconds) ? observedAtMaxSkewSeconds : 300
  });
  const ingest = await insertIngestMessage({
    topic,
    channel: parsedTopic.channel,
    msgId: envelope.msgId,
    tenantCode: parsedTopic.tenantCode,
    vesselCode: parsedTopic.vesselCode,
    edgeCode: parsedTopic.edgeCode,
    schemaVersion: envelope.schemaVersion,
    payload: envelope.payload,
    raw: envelope.raw
  });

  if (!ingest.inserted) {
    console.log(`[worker] duplicate message skipped msg_id=${envelope.msgId ?? "n/a"}`);
    return;
  }

  const envelopeValidation = validateEnvelope(envelope);
  if (!envelopeValidation.valid) {
    await saveIngestError({
      topic,
      channel: parsedTopic.channel,
      msgId: envelope.msgId,
      reason: "invalid_envelope",
      detail: envelopeValidation.errors.join("; "),
      raw: envelope.raw
    });
    return;
  }

  const payloadValidation = validateAndNormalizePayload(parsedTopic.channel, envelope.payload);
  if (!payloadValidation.valid) {
    await saveIngestError({
      topic,
      channel: parsedTopic.channel,
      msgId: envelope.msgId,
      reason: "invalid_payload",
      detail: payloadValidation.errors.join("; "),
      raw: envelope.raw
    });
    return;
  }

  const payload = payloadValidation.payload;

  try {
  if (parsedTopic.channel === "heartbeat") {
      const context = await resolveRequiredEdgeContext(parsedTopic);
      if (!context) {
        await saveIngestError({
          topic,
          channel: parsedTopic.channel,
          msgId: envelope.msgId,
          reason: "context_missing",
          detail: mqttAutoProvision
            ? "Unable to create or resolve the requested edge"
            : "Unknown edge; register or seed the edge before accepting inbound data"
        });
        return;
      }

      const previousSnapshot = await getEdgeLastSeenSnapshot({ edgeBoxId: context.edge_box_id });
      await insertHeartbeat({
        tenantCode: parsedTopic.tenantCode,
        vesselCode: parsedTopic.vesselCode,
        edgeCode: parsedTopic.edgeCode,
        firmwareVersion: payload.firmware_version,
        cpuUsagePct: payload.cpu_usage_pct,
        ramUsagePct: payload.ram_usage_pct,
        status: payload.status ?? "online",
        observedAt
      });

      await markEdgeLastSeen({
        vesselId: context.vessel_id,
        edgeCode: parsedTopic.edgeCode,
        observedAt
      });

      const previousSeenAt = previousSnapshot?.last_seen_at ?? null;
      const offlineObservedAt = previousSeenAt ? new Date(previousSeenAt).getTime() : null;
      const wasOffline =
        (offlineObservedAt !== null && Date.now() - offlineObservedAt > 2 * 60 * 1000) ||
        (await hasRecentEvent({
          vesselId: context.vessel_id,
          edgeBoxId: context.edge_box_id,
          eventType: "edge_offline",
          withinSeconds: 600
        }));

      if (wasOffline) {
        const hasRecentOnline = await hasRecentEvent({
          vesselId: context.vessel_id,
          edgeBoxId: context.edge_box_id,
          eventType: "edge_online",
          withinSeconds: 600
        });

        if (!hasRecentOnline) {
          await insertEvent({
            context,
            payload: {
              event_type: "edge_online",
              severity: "info",
              details: {
                edge_code: parsedTopic.edgeCode,
                previous_last_seen_at: previousSeenAt,
                observed_at: observedAt
              }
            },
            observedAt
          });
          console.log(`[worker] edge_online event created topic=${topic} edge=${parsedTopic.edgeCode}`);
        }
      }

      await updateEdgePublicWanIp({
        edgeBoxId: context.edge_box_id,
        publicWanIp: payload.public_wan_ip
      });
      console.log(`[worker] heartbeat stored topic=${topic} msg_id=${envelope.msgId}`);
      return;
    }

  if (parsedTopic.channel === "telemetry") {
      const context = await resolveRequiredEdgeContext(parsedTopic);
      if (!context) {
        await saveIngestError({
          topic,
          channel: parsedTopic.channel,
          msgId: envelope.msgId,
          reason: "context_missing",
          detail: mqttAutoProvision
            ? "Unable to create or resolve the requested edge"
            : "Unknown edge; register or seed the edge before accepting inbound data"
        });
        return;
      }

      await insertTelemetry({ context, payload, observedAt });
      const quotaWarning = await maybeCreateQuotaWarning({ context, observedAt });
      if (quotaWarning?.triggered) {
        console.log(
          `[worker] quota warning created vessel=${parsedTopic.vesselCode} used_gb=${quotaWarning.used_gb} quota_gb=${quotaWarning.quota_gb}`
        );
      }

      realtimeBus.emit("telemetry", {
        tenant_code: parsedTopic.tenantCode,
        vessel_code: parsedTopic.vesselCode,
        edge_code: parsedTopic.edgeCode,
        active_uplink: payload.active_uplink ?? payload.active_interface ?? null,
        latency_ms: payload.latency_ms ?? null,
        loss_pct: payload.loss_pct ?? null,
        rx_kbps: payload.rx_kbps ?? null,
        tx_kbps: payload.tx_kbps ?? null,
        throughput_kbps: payload.throughput_kbps ?? null,
        interfaces: Array.isArray(payload.interfaces) ? payload.interfaces : [],
        observed_at: observedAt
      });

      const linkDown = detectLinkDownEvent(payload);
      if (linkDown) {
        const hasRecent = await hasRecentEvent({
          vesselId: context.vessel_id,
          edgeBoxId: context.edge_box_id,
          eventType: "link_down",
          withinSeconds: 600
        });

        if (!hasRecent) {
          await insertEvent({
            context,
            payload: {
              event_type: "link_down",
              severity: "warning",
              details: {
                link: linkDown.link,
                reason: linkDown.reason
              }
            },
            observedAt
          });
          console.log(`[worker] link_down event created topic=${topic} msg_id=${envelope.msgId}`);
        }
      }

      await markEdgeLastSeen({
        vesselId: context.vessel_id,
        edgeCode: parsedTopic.edgeCode,
        observedAt
      });
      await updateEdgePublicWanIp({
        edgeBoxId: context.edge_box_id,
        publicWanIp: payload.public_wan_ip
      });
      console.log(`[worker] telemetry stored topic=${topic} msg_id=${envelope.msgId}`);
      return;
    }

    if (parsedTopic.channel === "usage") {
      const context = await resolveTenantVesselContext({
        tenantCode: parsedTopic.tenantCode,
        vesselCode: parsedTopic.vesselCode
      });

      if (!context) {
        await saveIngestError({
          topic,
          channel: parsedTopic.channel,
          msgId: envelope.msgId,
          reason: "context_missing",
          detail: "Unable to resolve tenant/vessel by code"
        });
        return;
      }

      const userId = await resolveUserId({
        tenantId: context.tenant_id,
        userId: payload.user_id,
        username: payload.username
      });

      if (!userId) {
        await saveIngestError({
          topic,
          channel: parsedTopic.channel,
          msgId: envelope.msgId,
          reason: "user_not_found",
          detail: "usage payload must map to an existing user"
        });
        return;
      }

      const usageResult = await recordUsageWithQuota({
        context,
        tenantCode: parsedTopic.tenantCode,
        vesselCode: parsedTopic.vesselCode,
        username: payload.username ?? null,
        userId,
        payload,
        observedAt
      });
      console.log(
        `[worker] usage stored topic=${topic} msg_id=${envelope.msgId} assignment=${usageResult.package_assignment_id || "none"} remaining_mb=${usageResult.remaining_mb ?? "n/a"}`
      );
      return;
    }

    if (parsedTopic.channel === "event") {
      const context = await resolveRequiredEdgeContext(parsedTopic);
      if (!context) {
        await saveIngestError({
          topic,
          channel: parsedTopic.channel,
          msgId: envelope.msgId,
          reason: "context_missing",
          detail: mqttAutoProvision
            ? "Unable to create or resolve the requested edge"
            : "Unknown edge; register or seed the edge before accepting inbound data"
        });
        return;
      }

      await insertEvent({ context, payload, observedAt });
      console.log(`[worker] event stored topic=${topic} msg_id=${envelope.msgId}`);
      return;
    }

    if (parsedTopic.channel === "vms") {
      const context = await resolveTenantVesselContext({
        tenantCode: parsedTopic.tenantCode,
        vesselCode: parsedTopic.vesselCode
      });

      if (!context) {
        await saveIngestError({
          topic,
          channel: parsedTopic.channel,
          msgId: envelope.msgId,
          reason: "context_missing",
          detail: "Unable to resolve tenant/vessel by code"
        });
        return;
      }

      await insertVms({ context, payload, observedAt });
      console.log(`[worker] vms stored topic=${topic} msg_id=${envelope.msgId}`);
      return;
    }

    if (parsedTopic.channel === "ack") {
      const jobId = payload.command_job_id ?? envelope.msgId;
      const updated = await markCommandJobAck({
        jobId,
        payload,
        observedAt
      });

      if (!updated) {
        await saveIngestError({
          topic,
          channel: parsedTopic.channel,
          msgId: envelope.msgId,
          reason: "command_job_not_found",
          detail: "ack payload did not match an existing command job",
          raw: envelope.raw
        });
        return;
      }

      console.log(`[worker] command ack stored topic=${topic} msg_id=${envelope.msgId}`);
      return;
    }

    if (parsedTopic.channel === "result") {
      const jobId = payload.command_job_id ?? envelope.msgId;
      const updated = await markCommandJobResult({
        jobId,
        status: payload.status,
        payload,
        observedAt
      });

      if (!updated) {
        await saveIngestError({
          topic,
          channel: parsedTopic.channel,
          msgId: envelope.msgId,
          reason: "command_job_not_found",
          detail: "result payload did not match an existing command job",
          raw: envelope.raw
        });
        return;
      }

      console.log(`[worker] command result stored topic=${topic} msg_id=${envelope.msgId}`);
      return;
    }

    if (parsedTopic.channel === "command") {
      console.log(`[worker] command observed topic=${topic} msg_id=${envelope.msgId}`);
      return;
    }

    console.log(`[worker] ${parsedTopic.channel} raw stored topic=${topic} msg_id=${envelope.msgId}`);
  } catch (error) {
    const message = error?.message || String(error);
    console.error(`[worker] failed processing topic=${topic}:`, message);
    await saveIngestError({
      topic,
      channel: parsedTopic.channel,
      msgId: envelope.msgId,
      reason: "processing_error",
      detail: message,
      raw: envelope.raw
    });
  }
});

async function shutdown() {
  console.log("[worker] shutting down");
  client.end(true);
  await pool.end();
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

console.log(`[worker] bootstrap started at ${new Date().toISOString()}`);
console.log(`[worker] edge auto-provision ${mqttAutoProvision ? "enabled" : "disabled"}`);
