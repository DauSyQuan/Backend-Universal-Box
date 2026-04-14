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
