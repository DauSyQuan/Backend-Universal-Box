# Phase 1 Completion Checklist

## Goal

Establish a stable backend foundation with reproducible local runtime and first data ingest path.

## Completed items

- [x] Local infra compose for PostgreSQL and MQTT broker
- [x] Environment template (`ops/env.example`)
- [x] DB migration script (`npm run db:migrate`)
- [x] DB reset script (`npm run db:reset-local`)
- [x] API service baseline:
  - [x] `GET /api/health`
  - [x] `GET /api/ready` with DB check
- [x] Worker service baseline:
  - [x] MQTT subscribe `mcu/+/+/+/+`
  - [x] Parse envelope and topic
  - [x] Persist raw ingest to `ingest_messages`
  - [x] Persist heartbeat to `edge_heartbeats`
  - [x] Persist telemetry when context is resolved
- [x] Smoke test script (`npm run test:smoke`)

## Exit criteria status

- [x] API process starts cleanly
- [x] Worker process connects and subscribes MQTT
- [x] DB schema can be migrated from clean state
- [x] Readiness endpoint reflects DB reachability
- [x] Baseline repository is ready for Git push and server deployment

