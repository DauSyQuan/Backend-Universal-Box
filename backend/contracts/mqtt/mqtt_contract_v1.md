# MQTT Contract v1

## Topic convention

`mcu/{tenant_id}/{vessel_id}/{edge_id}/{channel}`

## Inbound channels (MCU -> Server)

- `heartbeat`
- `telemetry`
- `usage`
- `event`
- `vms`

## Outbound channels (Server -> MCU)

- `command`
- `policy_sync`
- `package_sync`

## Response channels (MCU -> Server)

- `ack`
- `result`

## Common envelope

```json
{
  "msg_id": "uuid",
  "timestamp": "2026-03-31T07:00:00Z",
  "tenant_id": "tnr13",
  "vessel_id": "vsl-001",
  "edge_id": "edge-001",
  "schema_version": "v1",
  "payload": {}
}
```

## QoS and retention

- Inbound telemetry/heartbeat/usage/event/vms: QoS 1
- Command/policy/package sync: QoS 1
- ACK/result: QoS 1
- Retain flag:
  - heartbeat latest optional
  - command and result not retained

## Validation rules

- `msg_id` must be unique.
- `timestamp` must be ISO-8601 UTC.
- Server rejects unknown `schema_version`.
- Payload-specific fields validated at worker layer.

