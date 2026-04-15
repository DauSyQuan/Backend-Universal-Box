# API service (Phase 1 baseline)

Current endpoints:

1. `GET /api/health`
2. `GET /api/ready` (checks PostgreSQL connectivity)
3. `GET /api/mcu/edges?tenant=...&vessel=...&online_seconds=120`
4. `GET /api/mcu/edges/{tenant}/{vessel}/{edge}`
5. `POST /api/mcu/register`
6. `GET /api/mcu/edges/{tenant}/{vessel}/{edge}/traffic?window_minutes=60&limit=300`
7. `POST /api/commands`
8. `GET /api/commands`
9. `GET /api/commands/{id}`


Security controls:

- Dashboard and all non-public API routes are protected with HTTP Basic Auth when `BASIC_AUTH_ENABLED=true`.
- `GET /api/health` and `GET /api/ready` stay public for smoke checks.
- `POST /api/mcu/register` is disabled by default and requires `MCU_REGISTER_ENABLED=true` plus `MCU_REGISTER_TOKEN`.
- `POST /api/mcu/register` will auto-bind to an existing edge when the public WAN IP already exists in `edge_boxes.public_wan_ip`, and it issues a per-device `device_token` for future register calls.
- Trust forwarded IP headers only when `TRUST_PROXY_HEADERS=true`.
