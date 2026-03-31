# API Surface v1

## Auth

- `POST /api/auth/login`
- `POST /api/auth/refresh`
- `POST /api/auth/logout`

## Tenant and site

- `GET /api/tenants`
- `POST /api/tenants`
- `GET /api/sites`
- `POST /api/sites`
- `GET /api/vessels`
- `POST /api/vessels`

## User and package

- `GET /api/users`
- `POST /api/users`
- `PATCH /api/users/{id}`
- `GET /api/packages`
- `POST /api/packages`
- `POST /api/packages/{id}/assign`

## Usage and monitoring

- `GET /api/usage/users`
- `GET /api/usage/vessels`
- `GET /api/telemetry/latest`
- `GET /api/events`
- `GET /api/vms/latest`

## Command flow

- `POST /api/commands`
- `GET /api/commands`
- `GET /api/commands/{id}`

## Health and ops

- `GET /api/health`
- `GET /api/ready`

