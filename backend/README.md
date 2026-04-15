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

- `backend-docs/docs/phase0`: scope, roles, API surface
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

5. Open monitoring dashboard:
```bash
xdg-open http://localhost:3000/dashboard
```

## Remote access via ngrok

If you already have ngrok set up on the backend host, you can expose the same dashboard to another laptop without any code changes. The tunnel script now exposes only the dashboard/API by default and keeps MQTT private unless you explicitly enable it:

```bash
bash backend/ops/start_tunnels.sh
```

When the tunnel is ready, the script prints:

- `HTTP API WAN`
- `Dashboard URL`
- `MQTT Broker` only when `NGROK_ENABLE_MQTT_TUNNEL=true`

Open the `Dashboard URL` on the other laptop. It will look like:

- `https://<your-ngrok-subdomain>.ngrok-free.app/dashboard`

Because the dashboard is served from the same origin as the API, the page and its `/api/*` calls keep working through ngrok.

If you want a shorter address, set `NGROK_API_DOMAIN` in `backend/ops/.env` to a reserved ngrok domain or your own custom domain. Then the dashboard will be available at:

- `https://<your-short-domain>/dashboard`

Example:

```bash
NGROK_API_DOMAIN=ops.ngrok.app
```

If you prefer to use the server IP directly without ngrok, install the Nginx reverse proxy and open the dashboard on port 80:

```bash
sudo bash backend/ops/install-nginx-reverse-proxy.sh
```

After that, the dashboard is available at:

- `http://<server-ip>/dashboard`

If you also point your domain DNS A record to the same IP, the same proxy will serve `https://` once you add TLS later.

## Go-live hardening

Before exposing the dashboard to another person, set runtime secrets in `backend/ops/.env`:

```bash
BASIC_AUTH_ENABLED=true
BASIC_AUTH_USERNAME=demo
BASIC_AUTH_PASSWORD=<strong password>
BASIC_AUTH_ROLE=admin
AUTH_TOKEN_SECRET=<long random secret>

MCU_REGISTER_ENABLED=false
# Enable only when you intentionally onboard new devices
# MCU_REGISTER_TOKEN=<shared token>

MQTT_ALLOW_ANONYMOUS=false
MQTT_USERNAME=<broker user>
MQTT_PASSWORD=<broker password>
MQTT_AUTO_PROVISION=false
```

Notes:

- Dashboard and protected API routes now require HTTP Basic Auth. If `BASIC_AUTH_PASSWORD` is left blank, the API prints a one-time password in its startup log.
- `POST /api/auth/login` issues a bearer token for the same credentials, and `admin` / `noc` are the only roles allowed to create MCU commands.
- `/api/mcu/register` is disabled by default and must be explicitly enabled with `MCU_REGISTER_ENABLED=true` plus `MCU_REGISTER_TOKEN`.
- Worker no longer auto-creates unknown edges unless `MQTT_AUTO_PROVISION=true`. Seed or register the edge first for a cleaner demo.
- The ngrok helper does not publish MQTT unless `NGROK_ENABLE_MQTT_TUNNEL=true`.
- The bundled Node MQTT broker expects `MQTT_USERNAME` and `MQTT_PASSWORD` when `MQTT_ALLOW_ANONYMOUS=false`. For isolated local development only, you can temporarily set `MQTT_ALLOW_ANONYMOUS=true`.

## Realtime runtime

To keep broker, worker, and API alive after terminal close or reboot:

```bash
sudo bash backend/ops/install-runtime-services.sh
```

This installs 3 systemd services:

- `mcu-mqtt-broker.service`
- `mcu-worker.service`
- `mcu-api.service`

Check them with:

```bash
systemctl status mcu-mqtt-broker.service
systemctl status mcu-worker.service
systemctl status mcu-api.service
```

Follow logs:

```bash
journalctl -u mcu-mqtt-broker.service -f
journalctl -u mcu-worker.service -f
journalctl -u mcu-api.service -f
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
- Monitoring dashboard is available at `/dashboard`.
- Pi4 / RouterOS client setup guide: `../backend-mcu-client/mcu-client/README.md`.
- Sample Pi4 environment: `../backend-mcu-client/mcu-client/pi4_uplink.env.example`.
- Sample RouterOS MCU environment: `../backend-mcu-client/mcu-client/read_traffic.env.example`.
