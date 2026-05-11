# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project overview

MCU Backend Platform — a Node.js (ESM, >=22) backend for monitoring and managing maritime/vessel edge devices (MCU boxes running RouterOS / Pi4). It uses MQTT as the inbound data bus, PostgreSQL for persistence, and exposes a REST + WebSocket API with an embedded HTML dashboard.

## Repository layout

```
backend/
  services/api/       HTTP API server (Fastify-less; raw node:http)
  services/worker/    MQTT ingest worker
  shared/             Config, logger, error types, realtime EventEmitter bus
  db/                 Base schema (schema_v1.sql) + migrations/
  scripts/            DB migration, seed, smoke-test, reporting scripts
  ops/                Env config, nginx, mosquitto, systemd unit files
  mcu-client/         Pi4 / RouterOS edge client (Python)
  tests/
    unit/             Node test runner unit tests
    integration/      Live-DB integration tests
    load/             k6 load test scenarios
```

## Commands

All commands run from `backend/`.

```bash
# Install
npm install

# Start local infra (PostgreSQL on :5433, Mosquitto on :1883)
docker compose -f docker-compose.local.yml up -d

# Apply schema and migrations
npm run db:migrate

# Dev servers (run in separate terminals)
npm run dev:api       # API on :3000
npm run dev:worker    # MQTT worker + health on :3100

# Tests
npm test                          # unit tests (worker parser + shared config)
npm run test:integration          # requires live DB (RUN_INTEGRATION_TESTS=1)
npm run load:test                 # k6 load test (requires k6 installed)

# Run a single test file
node --test services/worker/test/parser.test.mjs
node --test tests/unit/config.test.mjs

# Source + test combined check (used in CI)
npm run verify

# Database helpers
npm run db:status
npm run db:reset-local            # WARNING: drops and recreates local DB
npm run db:seed:phase2            # seeds demo tenant/vessel/edge/user (crew01/crew01)
npm run db:seed:phase3

# Smoke test (requires running API + worker)
npm run test:smoke

# Production containers
docker compose -f docker-compose.prod.yml up -d --build
```

## Environment

Copy `ops/env.example` to `ops/.env`. Key variables:

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | PostgreSQL connection string |
| `MQTT_URL` | Broker URL (default `mqtt://localhost:1883`) |
| `AUTH_TOKEN_SECRET` | HMAC secret for bearer tokens — **required in prod** |
| `BASIC_AUTH_ENABLED` / `BASIC_AUTH_PASSWORD` | Dashboard HTTP Basic Auth |
| `MCU_REGISTER_ENABLED` | Edge self-registration (off by default) |
| `MQTT_AUTO_PROVISION` | Auto-create unknown edges from MQTT (off by default) |
| `MQTT_TOPIC_TENANT_ALIASES` | CSV `from=to` map for normalizing topic codes |

The API refuses to start without `AUTH_TOKEN_SECRET` in production (`NODE_ENV=production`).

## Architecture

### Data flow

```
Edge device (Pi4 / RouterOS)
  → MQTT broker (Mosquitto or bundled aedes)
    → Worker (services/worker) subscribes to mcu/+/+/+/<channel>
      → Validates envelope + payload (parser.js)
      → Persists to PostgreSQL
      → Emits telemetry events on shared realtimeBus (EventEmitter)
        → API WebSocket server broadcasts to subscribed clients
```

### MQTT topic structure

`mcu/{tenantCode}/{vesselCode}/{edgeCode}/{channel}`

Supported channels: `heartbeat`, `telemetry`, `usage`, `event`, `vms`, `command`, `ack`, `result`.

Hotspot replies use a separate topic: `tram1/reply/hotspot`.

### Message envelope

Every inbound message must be JSON:
```json
{
  "msg_id": "unique-string",
  "schema_version": "v1",
  "timestamp": "ISO-8601",
  "payload": { ... }
}
```
`msg_id` provides idempotency — duplicates are silently dropped. Validation/processing failures are persisted to `ingest_errors`.

### Services

**`services/api/src/server.js`** — monolithic HTTP handler (no framework). Routes include:
- `GET /api/health`, `/api/ready` — liveness/readiness
- `POST /api/auth/login`, `/api/auth/logout` — bearer token auth
- `GET /api/mcu/edges`, `/api/mcu/edges/:tenant/:vessel/:edge` — edge visibility
- `POST /api/mcu/edges/:tenant/:vessel/:edge/commands` — dispatch commands to edge
- `GET /api/mcu/traffic`, `/api/mcu/quota` — traffic/quota queries
- `GET /api/mcu/alerts` — event/alert list
- `GET /api/mcu/hotspot/*` — hotspot account management
- `/ws` — WebSocket (upgrade from HTTP server); clients subscribe by `{"subscribe": "tenantCode/vesselCode/edgeCode"}`
- `/dashboard` — serves embedded AdminLTE HTML dashboard

**`services/worker/src/index.js`** — MQTT subscriber. One `client.on("message")` handler dispatches by channel. Runs a 60-second sweep to emit `edge_offline` events for stale edges.

**`shared/realtime-bus.js`** — in-process `EventEmitter` connecting worker → API. Events: `telemetry`, `command`, `package`, `hotspot_account`, `hotspot_user_directory`, `hotspot_active_users`. The API also bridges PostgreSQL `LISTEN` channels (`mcu_telemetry_stream`, `command_job_updates`, etc.) into the same bus.

**`shared/config.js`** — `loadApiRuntimeConfig()` and `loadWorkerRuntimeConfig()` parse all env vars with typed defaults. This is the single source of truth for config validation.

### Database

PostgreSQL schema defined in `db/schema_v1.sql` (idempotent). Incremental migrations are in `db/migrations/` (applied in order by `scripts/db-migrate.mjs`).

Core tables: `tenants` → `vessels` → `edge_boxes`. Ingest tables: `ingest_messages`, `ingest_errors`, `telemetry`, `edge_heartbeats`, `events`. Traffic/quota: `traffic_hourly`, `packages`, `package_assignments`. Hotspot: `hotspot_accounts`, `hotspot_user_directory`, `hotspot_active_users`. Commands: `command_jobs`.

Password hashes must use `pbkdf2$...` format. Run `npm run audit:password-hashes` to find rows using legacy formats.

### Pi4 MCU client command types

The Pi4 edge client (`mcu-client/`) sends commands via `mcu/{tenant}/{vessel}/{edge}/command` MQTT topic with the following `command_type` values:

| command_type | Purpose | Required payload fields |
|---|---|---|
| `hotspot_cmd` | Quản lý user/profile hotspot | `action` + fields tùy action |
| `quota_sync` | Đồng bộ hạn mức data/user | `rules[]` mảng quota rules |
| `radius_setup` | Cấu hình RADIUS trên MikroTik | `radius_ip`, `radius_secret`, `radius_port`, `hotspot_profile` |
| `policy_sync` | Routing policy theo nhóm IP | `groups[]` |
| `failover_starlink` | Chuyển sang Starlink | `preferred_uplink: "starlink"` |
| `failback_vsat` | Chuyển về VSAT | `preferred_uplink: "vsat"` |
| `restore_automatic` | Khôi phục tự động | `preferred_uplink: "automatic"` |

`hotspot_cmd` actions: `create_user_profile`, `create_account` (alias `create_user`), `edit_user`, `delete_user`, `get_all_users`, `get_active_users`.

`quota_sync` rule structure: `{ username, uplink, quota_gb, speed_up_kbps, speed_dn_kbps, month }` — `month` là `"every"` hoặc `"YYYY-MM"`.

### Auth

Two mechanisms:
- **HTTP Basic Auth** — protects dashboard and all `/api/*` routes when `BASIC_AUTH_ENABLED=true`
- **Bearer token** — issued by `POST /api/auth/login`; required for `admin`/`noc` write operations (creating commands, managing hotspot accounts). Tokens are HMAC-signed; secret rotation is supported via `AUTH_TOKEN_SECRET_V1`/`V2`.

### Payload normalization

`services/worker/src/parser.js` accepts field aliases from multiple MCU firmware variants (RouterOS, Pi4, generic). For example, `cpu_load`, `cpu_load_pct`, `cpu_pct` all map to `cpu_usage_pct`. Telemetry interfaces can be provided as either `interfaces[]` or `data[]` arrays with short field names (`p`, `s`, `in`, `out`, `t`).

### Production deployment

Systemd services (`ops/systemd/`) wrap the broker, worker, and API. Install with:
```bash
sudo bash ops/install-runtime-services.sh
```

Nginx reverse proxy (port 80, optional TLS): `sudo bash ops/install-nginx-reverse-proxy.sh`.

Remote access via ngrok tunnel: `bash ops/start_tunnels.sh` (MQTT tunnel disabled by default; enable with `NGROK_ENABLE_MQTT_TUNNEL=true`).
