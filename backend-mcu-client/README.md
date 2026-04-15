# Backend MCU Client

Client-side tooling split out of the backend runtime repo.

This repo contains the Pi4 and RouterOS helper scripts that used to live under `backend/mcu-client`.

Main content:

- `mcu-client/read_traffic.py`
- `mcu-client/pi4_uplink.py`
- `mcu-client/routeros_policy.py`

Both MCU clients now subscribe to the backend command topic and keep a persistent MQTT session so command delivery survives reconnects.
