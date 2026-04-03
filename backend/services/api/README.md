# API service (Phase 1 baseline)

Current endpoints:

1. `GET /api/health`
2. `GET /api/ready` (checks PostgreSQL connectivity)
3. `GET /api/mcu/edges?tenant=...&vessel=...&online_seconds=120`
4. `GET /api/mcu/edges/{tenant}/{vessel}/{edge}`
5. `POST /api/mcu/register`
6. `GET /api/mcu/live/status` (MQTT live collector status, no DB needed)
7. `GET /api/mcu/live/edges?tenant=...&vessel=...&online_seconds=120` (MQTT live view)
8. `GET /api/mcu/live/edges/{tenant}/{vessel}/{edge}`

Notes:

- When DB is unavailable, `/api/mcu/edges*` automatically falls back to live MQTT data if `MCU_EDGES_FALLBACK_TO_LIVE=true`.
