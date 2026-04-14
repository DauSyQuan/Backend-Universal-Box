# MVP Scope v1

## Objective

Deliver a usable backend for MCU telemetry ingest, quota management, captain visibility, and basic command flow.

## In scope (MVP)

- Ingest from MCU:
  - heartbeat
  - telemetry
  - event
  - usage
  - vms
- Core entities:
  - tenant, site, vessel, edge_box
  - user, package, package_assignment
  - user_usage, alerts, command_jobs
- API:
  - auth (basic)
  - CRUD tenant/site/vessel/user/package
  - usage query (by vessel/user/time range)
  - captain scoped views
- Worker:
  - subscribe MQTT topics
  - validate payload
  - write PostgreSQL
  - record audit/error logs
- Security:
  - RBAC: admin, noc, captain, customer
  - scope isolation by tenant/site/vessel

## Out of scope (post-MVP)

- Advanced policy engine
- AI-based anomaly detection
- Full billing and invoicing
- Complex failover orchestration playbooks
- BI-heavy reporting suite

## Definition of done (MVP)

- MCU test client can publish heartbeat/telemetry/usage/event/vms to broker.
- Worker persists valid records into PostgreSQL and logs invalid payloads.
- Admin can manage package and user assignments.
- Captain can view only vessel-scoped user usage.
- Basic command job lifecycle exists: queued -> sent -> ack -> success/failed.

