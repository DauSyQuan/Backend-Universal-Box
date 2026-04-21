# Load Testing

This folder contains k6 scenarios for Phase 3 performance validation.

## Run with k6

```bash
k6 run tests/load/k6-scenarios.js
```

## Required env

- `API_BASE_URL`
- `BASIC_AUTH_USERNAME`
- `BASIC_AUTH_PASSWORD`

## Scenarios

- `baseline` - health and readiness checks
- `spike` - edge list pressure
- `stress` - command and package list pressure
- `soak` - usage report pressure

## Recommended thresholds

- `http_req_failed < 1%`
- `http_req_duration p95 < 500ms`
