# MCU Client

Client-side scripts for pushing MCU or RouterOS traffic into the backend.

## Files

- `read_traffic.py`: RouterOS-to-backend bridge for the current MCU flow
- `pi4_uplink.py`: generic Pi4 uplink client
- `pi4_uplink.env.example`: sample environment for the Pi4 client
- `pi4_uplink.service`: sample systemd unit for the Pi4 client

## Current choice

For the current RouterOS MCU setup, use:

- `read_traffic.py`

It sends:

- `heartbeat`
- `telemetry`

to backend MQTT topics in the form:

- `mcu/{tenant}/{vessel}/{edge}/{channel}`

## Runtime notes

- Place a same-name `.env` file next to the script when needed.
- Do not run old and new MCU traffic scripts at the same time.
