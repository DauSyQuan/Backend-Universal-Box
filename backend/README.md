# Backend MCU Server (Phase 0 + Phase 1 Complete)

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

## Repository layout

- `docs/phase0`: scope, roles, API surface
- `contracts/mqtt`: topic and payload contract
- `db`: SQL schema
- `services/api`: API service
- `services/worker`: ingest worker
- `scripts`: migration/reset/smoke scripts
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

## Expected smoke output

- `/api/health` returns status `ok`.
- `/api/ready` returns status `ready` when PostgreSQL is reachable.

## Notes

- Worker persists all valid incoming messages to `ingest_messages`.
- `heartbeat` messages are also persisted to `edge_heartbeats`.
- `telemetry` inserts into `telemetry` when tenant/vessel/edge mapping exists.
