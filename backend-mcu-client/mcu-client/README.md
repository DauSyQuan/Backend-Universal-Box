# MCU Client

Client-side scripts for pushing MCU or RouterOS traffic into the backend.

## Files

- `read_traffic.py`: RouterOS-to-backend bridge for the current MCU flow
- `pi4_uplink.py`: generic Pi4 uplink client
- `routeros_policy.py`: RouterOS policy-routing helper for VSAT work and Starlink entertainment
- `pi4_uplink.env.example`: sample environment for the Pi4 client
- `routeros_policy.env.example`: sample environment for the policy helper
- `read_traffic.env.example`: sample environment for the RouterOS uplink bridge
- `pi4_uplink.service`: sample systemd unit for the Pi4 client

## Current choice

For the current RouterOS MCU setup, use:

- `read_traffic.py`

It sends:

- `heartbeat`
- `telemetry`

to backend MQTT topics in the form:

- `mcu/{tenant}/{vessel}/{edge}/{channel}`

It also listens for backend commands on:

- `mcu/{tenant}/{vessel}/{edge}/command`

and publishes `ack` / `result` replies back to the backend.

By default:

- `policy_sync` runs the bundled `routeros_policy.py --apply`
- `failback_vsat`, `failover_starlink`, and `restore_automatic` run the bundled RouterOS policy helper, or `COMMAND_HOOK` if configured
- MQTT uses a persistent client session so queued commands survive reconnects

Optional registration hardening env value:

- `BACKEND_REGISTER_TOKEN=<shared register token>`

Optional device auth env value:

- `BACKEND_DEVICE_TOKEN_FILE=.mcu-device-token`

The backend returns a `device_token` after the first successful registration. The client stores it in this file and reuses it for future register calls.

Optional env values for command execution:

- `COMMAND_HOOK=/usr/local/bin/apply-edge-command.sh`
- `WORK_SOURCE_ADDRESSES=192.168.88.10,192.168.88.11`
- `ENTERTAINMENT_SOURCE_ADDRESSES=192.168.88.20,192.168.88.21`
- `VSAT_GATEWAY=10.10.10.1`
- `STARLINK_GATEWAY=100.64.0.1`

## Policy routing helper

Use `routeros_policy.py` when you want RouterOS to keep:

- `work` traffic on `VSAT`
- `entertainment` traffic on `Starlink`

The helper supports two modes:

- `--print`: emit RouterOS CLI commands
- `--apply`: apply the policy over the RouterOS API

Example env values:

- `WORK_SOURCE_ADDRESSES=192.168.88.10,192.168.88.11`
- `ENTERTAINMENT_SOURCE_ADDRESSES=192.168.88.20,192.168.88.21`
- `VSAT_GATEWAY=10.10.10.1`
- `STARLINK_GATEWAY=100.64.0.1`

## Runtime notes

- Place a same-name `.env` file next to the script when needed.
- Do not run old and new MCU traffic scripts at the same time.
