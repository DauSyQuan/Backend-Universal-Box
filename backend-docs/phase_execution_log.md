# Phase Execution Log

## 2026-03-31

- Initialized backend repository.
- Completed Phase 0 artifacts:
  - MVP scope v1
  - role matrix v1
  - API surface v1
  - MQTT contract v1
  - PostgreSQL schema v1
- Completed Phase 1 baseline:
  - workspace scripts and env templates
  - local compose for PostgreSQL + Mosquitto
  - API health/readiness endpoints
  - worker MQTT ingest pipeline to PostgreSQL
  - db migration/reset scripts
  - smoke test script

## 2026-04-01

- Completed Phase 2 ingest expansion:
  - worker channel ingest for usage/event/vms
  - validation layer for envelope + per-channel payload
  - idempotency for duplicate `msg_id`
  - ingest error persistence table + worker logging
  - phase2 scripts: seed, sample publish, ingest report
  - phase2 docs and checklists

## 2026-04-02

- Added MCU visibility backend for Raspberry Pi 4 onboarding:
  - API endpoint to register edge (`POST /api/mcu/register`)
  - API endpoint to list MCU status (`GET /api/mcu/edges`)
  - API endpoint for edge detail (`GET /api/mcu/edges/{tenant}/{vessel}/{edge}`)
  - Pi4 agent script + systemd unit and onboarding runbook

## Next checkpoint

- Start Phase 3:
  - command orchestration (`command`, `ack`, `result`) state machine
  - alert engine and policy sync jobs
  - captain-facing usage summary endpoints

## 2026-04-10

- Implemented command orchestration MVP:
  - `POST /api/commands` creates a command job and publishes MQTT command envelope
  - `GET /api/commands` and `GET /api/commands/{id}` expose command history
  - worker updates command jobs on MQTT `ack` and `result`
  - MQTT contract updated with command / ack / result payload examples
