# MCU Backend API

Versioned API documentation for the MCU backend platform.

## Base URL

- Local: `http://localhost:3000`
- Behind Nginx: `http://<server-ip>` or your domain

## Authentication

The API supports two auth styles:

- HTTP Basic Auth for browser and CLI access
- Bearer tokens from `POST /api/auth/login`

Roles:

- `admin`
- `noc`
- `captain`
- `customer`

Command creation is restricted to `admin` and `noc`.

## Rate Limits

Public IPs are rate limited in-memory:

- `/api/auth/login` - 10 requests/minute
- `/api/commands` - 30 requests/minute
- `/api/mcu/register` - 20 requests/minute
- Other public endpoints - 120 requests/minute

Private and local IPs are bypassed.

## Common Errors

The API returns JSON error payloads:

```json
{ "error": "not_found" }
```

Common codes:

- `400` - invalid request or payload
- `401` - auth required / invalid credentials
- `403` - forbidden
- `404` - resource not found
- `408` - request timeout
- `409` - conflict
- `413` - payload too large
- `429` - rate limited
- `500` - internal error

## Health and Metrics

### `GET /api/health`

Returns database latency, pool stats, and memory health.

```bash
curl http://localhost:3000/api/health
```

### `GET /api/ready`

Returns `ready` when PostgreSQL is reachable.

```bash
curl http://localhost:3000/api/ready
```

### `GET /metrics`

Prometheus text format metrics:

- `http_requests_total`
- `http_request_duration_seconds`
- `http_requests_in_flight`

## Auth

### `POST /api/auth/login`

Body:

```json
{ "username": "admin", "password": "123" }
```

Response:

```json
{
  "access_token": "Bearer token...",
  "token_type": "Bearer",
  "expires_in": 3600,
  "user": {
    "user_id": null,
    "username": "admin",
    "role": "admin",
    "tenant_code": null,
    "vessel_code": null
  }
}
```

### `POST /api/auth/refresh`

Refresh an existing bearer token.

### `POST /api/auth/logout`

No-op logout endpoint for client-side session cleanup.

## Commands

### `GET /api/commands`

List command jobs.

Query params:

- `tenant`, `tenant_code`
- `vessel`, `vessel_code`
- `edge`, `edge_code`
- `status`
- `limit`
- `offset`
- `after`

### `POST /api/commands`

Create a command job.

Example:

```bash
curl -u admin:123 \
  -H 'content-type: application/json' \
  -d '{
    "tenant_code": "tnr13",
    "vessel_code": "vsl-001",
    "edge_code": "edge-001",
    "command_type": "policy_sync",
    "command_payload": {
      "preferred_uplink": "automatic",
      "scope": "automatic",
      "mode": "manual"
    }
  }' \
  http://localhost:3000/api/commands
```

### `GET /api/commands/:id`

Fetch a single command job.

## MCU Visibility

### `GET /api/mcu/edges`

List edge boxes and their latest heartbeat/telemetry.

Query params:

- `tenant`
- `vessel`
- `wan_ip`
- `limit`
- `offset`
- `after`

### `GET /api/mcu/edges/:tenant/:vessel/:edge`

Fetch edge detail:

- latest heartbeat
- latest telemetry
- usage summary
- top users
- recent events
- ingest errors
- alerts

### `GET /api/mcu/edges/:tenant/:vessel/:edge/traffic`

Per-port traffic samples and summary.

### `GET /api/mcu/edges/:tenant/:vessel/:edge/stream`

SSE stream for live telemetry updates.

### `GET /api/mcu/edges/by-wan/:wan_ip`

Lookup an edge by public WAN IP.

### `GET /api/mcu/traffic/by-wan/:wan_ip`

Traffic lookup by public WAN IP.

### `POST /api/mcu/register`

Register an MCU/edge device.

Requires `MCU_REGISTER_ENABLED=true` and `MCU_REGISTER_TOKEN`.

## Packages and Usage

### `GET /api/packages`

List package catalog entries.

Query params:

- `include_inactive`

### `POST /api/packages`

Create a package.

### `PATCH /api/packages/:id`

Update or archive/restore a package.

### `POST /api/packages/:id/assign`

Assign a package to a user and vessel.

### `GET /api/package-assignments`

List assignments.

Query params:

- `tenant`
- `vessel`
- `username`
- `status`
- `package_code`
- `active_only`
- `limit`
- `offset`
- `after`

### `GET /api/package-assignments/:id`

Assignment lifecycle detail:

- assignment
- usage summary
- recent usage
- audit history
- alerts

### `DELETE /api/package-assignments/:id`

Cancel/unassign an active package assignment.

### `GET /api/package-audit`

Audit history for package operations.

Query params:

- `tenant`
- `package`
- `vessel`
- `username`
- `action`
- `date_from`
- `date_to`
- `after`
- `limit`
- `offset`

### `GET /api/reports/usage`

Usage aggregation report.

Query params:

- `tenant`
- `vessel`
- `username`
- `package`
- `date_from`
- `date_to`
- `bucket`
- `window_minutes`

### `GET /api/reports/usage/export`

CSV export for the same usage filters.

## Example cURL

```bash
curl -u admin:123 http://localhost:3000/api/mcu/edges?limit=5
curl -u admin:123 http://localhost:3000/api/package-assignments?limit=5
curl -u admin:123 http://localhost:3000/api/package-audit?limit=5
curl -u admin:123 http://localhost:3000/api/reports/usage?bucket=hour
```

## Versioning

The API currently follows the backend repository version. When you add breaking changes, update this document and the OpenAPI spec together.
