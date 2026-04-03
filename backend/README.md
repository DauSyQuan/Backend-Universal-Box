# Backend MCU Server (Phase 0 + Phase 2 Complete)

This repository is prepared for immediate Git push and Ubuntu deployment baseline.

## Delivered phases

- Phase 0 complete:
  - MVP scope
  - role and RBAC matrix
  - API surface baseline
  - MQTT contract baseline
  - PostgreSQL schema v1
- Phase 1 complete:
  - local infra compose (PostgreSQL + Mosquitto)
  - API service with health/readiness endpoints
  - worker service with MQTT subscribe and DB ingest
  - migration/reset scripts
  - smoke test script
- Phase 2 complete:
  - channel ingest extended for usage/event/vms
  - envelope + payload validation
  - ingest error audit table and persistence
  - message idempotency by `msg_id`
  - seed/publish/report scripts for end-to-end verification

## Repository layout

- `docs/phase0`: scope, roles, API surface
- `contracts/mqtt`: topic and payload contract
- `db`: SQL schema
- `services/api`: API service
- `services/worker`: ingest worker
- `scripts`: migration/reset/smoke scripts
- `scripts`: migration/reset/smoke/phase2 scripts
- `ops`: local env and broker config

## Prerequisites

- Node.js >= 22
- Docker + Docker Compose (for local infra)

## Quick start

1. Install dependencies:
```bash
npm install
```

2. Prepare env file:
```bash
cp ops/env.example ops/.env
```

3. Start local infrastructure:
```bash
docker compose -f docker-compose.local.yml up -d
```

4. Apply schema:
```bash
npm run db:migrate
```

5. Run API and worker (separate terminals):
```bash
npm run dev:api
npm run dev:worker
```

6. Smoke test:
```bash
npm run test:smoke
```

## Phase 2 verification

1. Seed baseline entities (tenant/vessel/edge/user):
```bash
npm run db:seed:phase2
```

2. Publish sample MQTT traffic:
```bash
npm run mqtt:publish:phase2
```

3. Review ingest report:
```bash
npm run phase2:report
```

4. Check MCU visibility API:
```bash
curl "http://localhost:3000/api/mcu/edges?tenant=tnr13&vessel=vsl-001"
curl "http://localhost:3000/api/mcu/edges/tnr13/vsl-001/edge-001"
```

## Expected smoke output

- `/api/health` returns status `ok`.
- `/api/ready` returns status `ready` when PostgreSQL is reachable.

## Notes

- Worker persists all valid incoming messages to `ingest_messages`.
- `heartbeat` messages are also persisted to `edge_heartbeats`.
- `telemetry` inserts into `telemetry` when tenant/vessel mapping exists.
- `usage`, `event`, `vms` inserts are enabled in Phase 2.
- Validation and processing failures are persisted to `ingest_errors`.
- MCU visibility endpoints are available under `/api/mcu/*`.
- Pi4 onboarding guide: `docs/phase2/pi4_mcu_onboarding.md`.
- RouterOS onboarding guide: `docs/phase2/routeros_mqtt_onboarding.md`.
