# Worker service (Phase 1 baseline)

Current responsibility:

- subscribe MQTT topics: `mcu/+/+/+/+`
- parse topic and envelope
- persist raw messages to `ingest_messages`
- persist heartbeat to `edge_heartbeats`
- persist telemetry to `telemetry` when context exists
- reconnect automatically on broker disconnect

Next phase:

1. strict schema validation per channel
2. ingest usage/event/vms tables
3. dead-letter and replay strategy
