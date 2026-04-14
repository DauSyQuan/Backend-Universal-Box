# MQTT Payload Examples v1

Topic format:

`mcu/{tenant_code}/{vessel_code}/{edge_code}/{channel}`

## heartbeat

```json
{
  "msg_id": "f7ce5de4-a85e-42fa-8c28-e31cf7069eb9",
  "timestamp": "2026-04-01T03:00:00Z",
  "schema_version": "v1",
  "payload": {
    "firmware_version": "1.0.0",
    "cpu_usage_pct": 22.3,
    "ram_usage_pct": 58.9,
    "status": "online"
  }
}
```

## telemetry

```json
{
  "msg_id": "2f4819a5-60fb-4f67-8ef7-d7e9e65d3a49",
  "timestamp": "2026-04-01T03:00:01Z",
  "schema_version": "v1",
  "payload": {
    "active_uplink": "starlink",
    "latency_ms": 41.5,
    "loss_pct": 0.05,
    "jitter_ms": 5.2,
    "throughput_kbps": 9820
  }
}
```

## RouterOS-compatible payload aliases

Backend worker now accepts RouterOS-style keys and normalizes them to v1 fields:

- heartbeat aliases:
  - `cpu_load` / `cpu_load_pct` -> `cpu_usage_pct`
  - `memory_used_pct` / `memory_usage_pct` -> `ram_usage_pct`
  - `routeros_version` / `version` -> `firmware_version`
  - `router_status` / `state` -> `status`
- telemetry aliases:
  - `active_interface` / `wan_interface` -> `active_uplink`
  - `rtt_ms` / `ping_latency_ms` -> `latency_ms`
  - `packet_loss_pct` / `ping_loss_pct` -> `loss_pct`
  - `ping_jitter_ms` -> `jitter_ms`
  - `rx_kbps` + `tx_kbps` -> `throughput_kbps` (auto-sum when `throughput_kbps` is missing)

### RouterOS heartbeat example

```json
{
  "msg_id": "edge-rb-001-2026-04-02T12:00:00+07:00-hb",
  "timestamp": "2026-04-02T12:00:00+07:00",
  "tenant_id": "tnr13",
  "vessel_id": "vs1-001",
  "edge_id": "edge-rb-001",
  "schema_version": "v1",
  "payload": {
    "routeros_version": "7.17.2",
    "cpu_load": 17,
    "memory_used_pct": 43,
    "state": "online"
  }
}
```

### RouterOS telemetry example

```json
{
  "msg_id": "edge-rb-001-2026-04-02T12:00:00+07:00-tm",
  "timestamp": "2026-04-02T12:00:00+07:00",
  "tenant_id": "tnr13",
  "vessel_id": "vs1-001",
  "edge_id": "edge-rb-001",
  "schema_version": "v1",
  "payload": {
    "active_interface": "ether1",
    "rtt_ms": 28,
    "packet_loss_pct": 0,
    "ping_jitter_ms": 1.2,
    "rx_kbps": 1480,
    "tx_kbps": 350
  }
}
```

## usage

```json
{
  "msg_id": "ef71028e-3691-4f48-8198-599d02e5f6a7",
  "timestamp": "2026-04-01T03:00:02Z",
  "schema_version": "v1",
  "payload": {
    "username": "crew01",
    "session_id": "05db490b-69be-4942-8f5e-c08f018da53b",
    "upload_mb": 125.4,
    "download_mb": 512.7
  }
}
```

## event

```json
{
  "msg_id": "10858f91-d29c-43be-9035-f7186cdb8f92",
  "timestamp": "2026-04-01T03:00:03Z",
  "schema_version": "v1",
  "payload": {
    "event_type": "link_down",
    "severity": "warning",
    "details": {
      "link": "starlink",
      "reason": "packet_loss_high"
    }
  }
}
```

## vms

```json
{
  "msg_id": "5cbc7ef9-bc1f-4c23-b4a9-ca541d7e3f4f",
  "timestamp": "2026-04-01T03:00:04Z",
  "schema_version": "v1",
  "payload": {
    "latitude": 10.8231,
    "longitude": 106.6297,
    "speed_knots": 9.8,
    "heading_deg": 135.5
  }
}
```
