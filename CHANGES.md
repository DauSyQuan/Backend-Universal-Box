# CHANGES — MCU Backend Platform

Tổng hợp những gì đã xây dựng và thay đổi phía **backend** từ đầu đến hiện tại.

---

## Phase 0 + 1 — Baseline (`8d8e628`, `e906c6b`)

- Node.js (ESM, >=22), kiến trúc monorepo `services/api` + `services/worker` + `shared/`
- PostgreSQL schema (`db/schema_v1.sql`): tenants → vessels → edge_boxes, ingest_messages, telemetry, events, heartbeats
- MQTT worker subscribe `mcu/{tenant}/{vessel}/{edge}/{channel}`, parse + persist
- REST API: `/api/health`, `/api/ready`, `/api/mcu/edges`, `/api/mcu/traffic`, `/api/mcu/alerts`
- Basic Auth trên tất cả `/api/*` routes
- Docker Compose local: PostgreSQL :5433, Mosquitto :1883

---

## Phase 2 — Ingest + MCU Live API (`0861c8a`)

- Parser (`services/worker/src/parser.js`) normalize field aliases từ nhiều MCU firmware variant:
  - `cpu_load`, `cpu_load_pct`, `cpu_pct` → `cpu_usage_pct`
  - `interfaces[]` hoặc `data[]` với short keys (`p`, `s`, `in`, `out`, `t`)
- Idempotency: `msg_id` dedup — duplicate silently dropped
- Validation failures → persist vào `ingest_errors`
- Live API endpoints: `/api/mcu/edges/:tenant/:vessel/:edge` trả telemetry mới nhất
- Pi4 / RouterOS client (`mcu-client/`) tích hợp

---

## Phase 2 — Traffic + Quota (`1bbecd6`, `29d2b05`)

- Migration `004_add_traffic_and_quota.sql`: bảng `traffic_hourly`, `packages`, `package_assignments`
- Worker tích hợp ingest traffic per-interface theo giờ
- API: `GET /api/mcu/traffic`, `GET /api/mcu/quota`

---

## Phase 2 — Command Orchestration (`559fd09`, `1520b16`)

- Bảng `command_jobs` — lưu trữ và theo dõi trạng thái lệnh
- `POST /api/mcu/edges/:tenant/:vessel/:edge/commands` — dispatch command qua MQTT
- Worker lắng nghe `ack` + `result` channel → cập nhật trạng thái job
- Command types: `failover_starlink`, `failback_vsat`, `restore_automatic`, `hotspot_cmd`, `quota_sync`, `radius_setup`, `policy_sync`

---

## Phase 2 — Hotspot Accounts (`5eaeef9`, `accbbb5`, `58cf0d2`)

- Migration `006_add_hotspot_accounts.sql`: bảng `hotspot_accounts`
- Migration `007_add_hotspot_sync_tables.sql`: bảng `hotspot_user_directory`, `hotspot_active_users`
- API: `GET/POST /api/mcu/hotspot/*` — CRUD hotspot accounts
- Worker xử lý `hotspot_account` + `hotspot_user_directory` + `hotspot_active_users` channels
- Bridge flow: API → `command_jobs` → MQTT → Pi4 → reply topic `tram1/reply/hotspot` → worker → DB

---

## Phase 3 — Package Catalog (`d5e1781`)

- Bảng `packages`, `package_assignments` seed với 3 packages
- API endpoint quản lý packages và gán cho edges

---

## Go-Live Patch (`7529e37`)

Đây là commit tổng hợp chuẩn bị production:

### Auth Hardening
- `AUTH_TOKEN_SECRET` bắt buộc >= 32 chars trong production (`NODE_ENV=production`)
- Token rotation: hỗ trợ `AUTH_TOKEN_SECRET_V1` / `AUTH_TOKEN_SECRET_V2` — verify token cũ khi rotate
- HMAC-signed bearer token, TTL configurable (`AUTH_TOKEN_TTL_SECONDS`, default 3600s)
- `POST /api/auth/login` → issue token · `POST /api/auth/logout`
- Two-layer auth: HTTP Basic (dashboard) + Bearer (API write operations)

### Migration 008 — command_status enum
- Chuyển `command_jobs.status` từ `text CHECK(...)` sang PostgreSQL `enum command_status`
- Values: `queued | sent | ack | success | failed`

### Worker Extensions
- **Edge offline sweep**: cron 60s quét edges không heartbeat → emit `edge_offline` event
- **MQTT alias normalisation**: `MQTT_TOPIC_TENANT_ALIASES`, `MQTT_TOPIC_VESSEL_ALIASES`, `MQTT_TOPIC_EDGE_ALIASES` — map topic codes trước khi lookup DB

### Shared Config
- `shared/config.js`: `loadApiRuntimeConfig()` + `loadWorkerRuntimeConfig()` — single source of truth
- Typed defaults, validation tại startup
- Unit tests: `tests/unit/config.test.mjs`

### Scripts Helper
- `scripts/db-status.mjs` — hiển thị trạng thái migrations đã apply
- `scripts/audit-password-hashes.mjs` — tìm rows dùng legacy password format
- `scripts/db-migrate.mjs` — idempotent migration runner (hash-based, không re-apply)

### Systemd Services
```
ops/systemd/mcu-api.service
ops/systemd/mcu-worker.service
```
Cài đặt bằng: `sudo bash ops/install-runtime-services.sh`

### CI (GitHub Actions)
- `.github/workflows/ci.yml`: lint + unit tests (`npm run verify`) trên mỗi push/PR

### Nginx Reverse Proxy
- `ops/install-nginx-reverse-proxy.sh` — cài Nginx proxy port 80 → :3000

### Ngrok Remote Access
- `ops/start_tunnels.sh` — tạo tunnel cho dashboard + API
- `NGROK_ENABLE_MQTT_TUNNEL=true` để tunnel cả MQTT :1883

---

## Fix — Migration 008 Cast Error (session này)

**Vấn đề:** Migration 008 lỗi `operator does not exist: command_status = text` khi reset DB từ đầu vì `CHECK constraint` còn tồn tại.

**Fix** trong `008_command_status_enum.sql`:
```sql
-- Thêm drop constraint trước khi alter type
alter table command_jobs
  drop constraint if exists command_jobs_status_check;

alter table command_jobs
  alter column status type command_status using status::text::command_status;
```

---

## Database Reset & Reseed (session này)

```bash
# Xóa sạch data cũ
sudo docker-compose -f docker-compose.local.yml down -v

# Khởi động lại infra
sudo docker-compose -f docker-compose.local.yml up -d

# Apply tất cả migrations (000 → 008)
npm run db:migrate

# Seed dữ liệu demo
npm run db:seed:phase2   # tenant: tnr13, vessel: vsl-001, edge: edge-001, user: crew01/crew01
npm run db:seed:phase3   # 3 packages

# Restart services
sudo systemctl restart mcu-api mcu-worker
```

---

## Kiến trúc Data Flow

```
Edge (Pi4 / RouterOS)
  → MQTT broker (Mosquitto :1883 / bundled aedes)
    → services/worker — subscribe mcu/+/+/+/<channel>
      → parser.js — validate + normalize
      → PostgreSQL — persist
      → realtimeBus (EventEmitter) — emit events
        → services/api — WebSocket broadcast → browser clients
```

### MQTT Topic Structure
```
mcu/{tenantCode}/{vesselCode}/{edgeCode}/{channel}
```
Channels: `heartbeat` · `telemetry` · `usage` · `event` · `vms` · `command` · `ack` · `result`

Hotspot reply: `tram1/reply/hotspot`

### Message Envelope
```json
{
  "msg_id": "unique-string",
  "schema_version": "v1",
  "timestamp": "ISO-8601",
  "payload": { ... }
}
```

---

## Môi trường

| Biến | Mô tả |
|---|---|
| `DATABASE_URL` | PostgreSQL connection string |
| `MQTT_URL` | Broker URL (default `mqtt://localhost:1883`) |
| `AUTH_TOKEN_SECRET` | HMAC secret >= 32 chars — **bắt buộc production** |
| `BASIC_AUTH_ENABLED` | Bật/tắt Basic Auth dashboard |
| `MQTT_AUTO_PROVISION` | Tự tạo edge mới từ MQTT (default off) |
| `MCU_REGISTER_ENABLED` | Cho phép edge tự đăng ký (default off) |
| `NGROK_AUTHTOKEN` | Token ngrok cho remote access |
| `WORKER_HEALTH_PORT` | Health endpoint worker (default 3100) |

Copy từ `ops/env.example` → `ops/.env` trước khi chạy.
