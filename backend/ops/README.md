# Ops

Operational files for running the backend outside development.

## Main files

- `env.example`: baseline runtime environment variables
- `.env`: local runtime secrets and machine-specific values
- `start_tunnels.sh`: open ngrok tunnels for API and MQTT
- `setup-ssh-server.sh`: configure SSH server on the backend host
- `install-runtime-services.sh`: install systemd units for API, worker, and MQTT broker
- `systemd/`: service templates used by the installer

## Binaries

- `ngrok`: local ngrok binary used by tunnel scripts
- `bore`: legacy tunnel binary kept for fallback use

## Notes

- Keep `.env` local only.
- Use `install-runtime-services.sh` for stable runtime.
- Use `start_tunnels.sh` only when public tunnels are needed.
