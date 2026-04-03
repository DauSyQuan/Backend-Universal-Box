# Worker service (Phase 2 ingest)

Current responsibility:

- subscribe MQTT topics: `mcu/+/+/+/+`
- parse topic and envelope
- persist raw messages to `ingest_messages`
- persist heartbeat to `edge_heartbeats`
- persist telemetry to `telemetry` when context exists
- persist usage to `user_usage` when user can be resolved
- persist event to `events`
- persist vms to `vms_positions`
- persist ingest failures to `ingest_errors`
- skip duplicate `msg_id` safely
- reconnect automatically on broker disconnect
- normalize RouterOS MQTT aliases into v1 fields (heartbeat/telemetry)

Validation rules:

1. envelope validation for `msg_id`, `timestamp`, `schema_version`.
2. channel payload validation for numeric/range/required fields.
3. mapping validation (tenant/vessel/user resolution).
