# Phase 2 Completion Checklist (MCU Ingest)

## Goal

Complete MCU ingest pipeline for operational channels with validation and error audit.

## Delivered

- [x] Worker channel support:
  - [x] heartbeat
  - [x] telemetry
  - [x] usage
  - [x] event
  - [x] vms
- [x] Message idempotency:
  - [x] duplicate `msg_id` skipped safely
- [x] Validation layer:
  - [x] envelope validation (`msg_id`, `timestamp`, `schema_version`)
  - [x] channel payload validation
- [x] Ingest error audit:
  - [x] `ingest_errors` table
  - [x] parse/validation/processing errors persisted
- [x] Test tooling:
  - [x] seed script (`db:seed:phase2`)
  - [x] MQTT sample publisher (`mqtt:publish:phase2`)
  - [x] ingest report (`phase2:report`)
- [x] MCU visibility APIs:
  - [x] register edge
  - [x] list MCU online status
  - [x] fetch detailed edge diagnostics
- [x] Pi4 onboarding artifacts:
  - [x] MQTT agent script
  - [x] systemd service template
  - [x] onboarding guide

## Exit Criteria

- [x] Worker can store all main operational channels into database tables.
- [x] Duplicate messages do not create duplicate ingest records.
- [x] Invalid payloads are traceable via `ingest_errors`.
- [x] Team can run end-to-end local verification by script sequence.
