# Ops

Operational files for running the backend outside development.

## Main files

- `env.example`: baseline runtime environment variables
- `.env`: local runtime secrets and machine-specific values
- `start_tunnels.sh`: open an ngrok tunnel for the API/dashboard and optionally MQTT
- `install-nginx-reverse-proxy.sh`: install and configure Nginx for direct IP or domain access
- `setup-ssh-server.sh`: configure SSH server on the backend host
- `install-runtime-services.sh`: install systemd units for API, worker, and MQTT broker
- `systemd/`: service templates used by the installer
- `nginx/`: Nginx config templates

## Binaries

- `ngrok`: local ngrok binary used by tunnel scripts
- `bore`: legacy tunnel binary kept for fallback use

## Notes

- Keep `.env` local only.
- Use `install-runtime-services.sh` for stable runtime.
- Use `start_tunnels.sh` only when public tunnels are needed.
- The public dashboard is available at `${API_PUBLIC_URL}/dashboard` when `start_tunnels.sh` is running.
- MQTT is not exposed by default. Set `NGROK_ENABLE_MQTT_TUNNEL=true` only when you intentionally need a public MQTT broker address.
- Set `NGROK_API_DOMAIN` in `ops/.env` if you want a shorter reserved or custom domain for the API and dashboard.
- Set `BASIC_AUTH_*`, `MCU_REGISTER_*`, and MQTT credentials in `ops/.env` before a boss/demo go-live.
- Run `install-nginx-reverse-proxy.sh` if you want to expose the dashboard directly on port 80 through Nginx instead of ngrok.
- The bundled Node MQTT broker requires `MQTT_USERNAME` and `MQTT_PASSWORD` when `MQTT_ALLOW_ANONYMOUS=false`.
