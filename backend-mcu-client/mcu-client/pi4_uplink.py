#!/usr/bin/env python3
import json
import os
import re
import shlex
import socket
import subprocess
import sys
import time
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional
from urllib import error, request

try:
    import paho.mqtt.client as mqtt
except ImportError:
    print("Missing dependency: paho-mqtt", file=sys.stderr)
    print("Install it with: sudo apt install -y python3-paho-mqtt", file=sys.stderr)
    sys.exit(1)


ENV_FILE = Path(__file__).with_suffix(".env")
DEVICE_TOKEN_FILE = Path(os.getenv("BACKEND_DEVICE_TOKEN_FILE", str(Path(__file__).with_name(".mcu-device-token"))))
PING_RTT_RE = re.compile(r"=\s*([\d.]+)/([\d.]+)/([\d.]+)/([\d.]+)\s*ms")
PING_LOSS_RE = re.compile(r"(\d+(?:\.\d+)?)%\s*packet loss")


def load_env_file(path: Path) -> None:
    if not path.exists():
        return

    for raw_line in path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue

        key, value = line.split("=", 1)
        key = key.strip()
        value = value.strip().strip("'").strip('"')
        os.environ.setdefault(key, value)


def env_text(name: str, default: Optional[str] = None, required: bool = False) -> str:
    value = os.getenv(name, default)
    if required and (value is None or value == ""):
        raise RuntimeError(f"Missing required env: {name}")
    return value or ""


def env_int(name: str, default: int) -> int:
    try:
        return int(os.getenv(name, str(default)))
    except ValueError:
        return default


def env_float(name: str, default: float) -> float:
    try:
        return float(os.getenv(name, str(default)))
    except ValueError:
        return default


def read_device_token(path: Path) -> str:
    try:
        return path.read_text(encoding="utf-8").strip()
    except FileNotFoundError:
        return ""
    except OSError:
        return ""


def write_device_token(path: Path, token: str) -> None:
    token = token.strip()
    if not token:
        return
    try:
        path.write_text(token + "\n", encoding="utf-8")
    except OSError:
        pass


def now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def log(message: str) -> None:
    print(f"[{now_iso()}] {message}", flush=True)


def safe_hostname() -> str:
    try:
        return socket.gethostname()
    except OSError:
        return "pi4"


def detect_public_ip(timeout_seconds: float = 5.0) -> Optional[str]:
    url = env_text("PUBLIC_IP_DETECT_URL", "https://api.ipify.org")
    try:
        with request.urlopen(url, timeout=timeout_seconds) as response:
            value = response.read().decode("utf-8").strip()
            return value or None
    except Exception:
        return None


def post_json(url: str, payload: dict, timeout_seconds: float = 10.0, headers: Optional[dict] = None) -> dict:
    body = json.dumps(payload).encode("utf-8")
    request_headers = {"content-type": "application/json; charset=utf-8"}
    if headers:
        request_headers.update(headers)
    req = request.Request(
        url,
        data=body,
        headers=request_headers,
        method="POST",
    )
    with request.urlopen(req, timeout=timeout_seconds) as response:
        content = response.read().decode("utf-8")
        return json.loads(content) if content else {}


def read_first_line(path: Path) -> int:
    return int(path.read_text(encoding="utf-8").strip())


def read_mem_usage_pct() -> Optional[float]:
    meminfo = {}
    try:
        for line in Path("/proc/meminfo").read_text(encoding="utf-8").splitlines():
            if ":" not in line:
                continue
            key, value = line.split(":", 1)
            meminfo[key.strip()] = value.strip().split()[0]

        total = float(meminfo["MemTotal"])
        available = float(meminfo.get("MemAvailable", meminfo.get("MemFree", "0")))
        if total <= 0:
            return None
        return round(((total - available) / total) * 100.0, 2)
    except Exception:
        return None


@dataclass
class CpuSample:
    idle: float
    total: float


class CpuUsageTracker:
    def __init__(self) -> None:
        self.previous = self._read_sample()

    def _read_sample(self) -> Optional[CpuSample]:
        try:
            parts = Path("/proc/stat").read_text(encoding="utf-8").splitlines()[0].split()
            values = [float(part) for part in parts[1:]]
            idle = values[3] + values[4]
            total = sum(values)
            return CpuSample(idle=idle, total=total)
        except Exception:
            return None

    def usage_pct(self) -> Optional[float]:
        current = self._read_sample()
        previous = self.previous
        self.previous = current

        if not current or not previous:
            return None

        total_delta = current.total - previous.total
        idle_delta = current.idle - previous.idle
        if total_delta <= 0:
            return None

        used = 1.0 - (idle_delta / total_delta)
        return round(max(0.0, min(100.0, used * 100.0)), 2)


@dataclass
class TrafficSample:
    timestamp: float
    rx_bytes: int
    tx_bytes: int


class InterfaceTrafficTracker:
    def __init__(self, interface_name: str) -> None:
        self.interface_name = interface_name
        self.previous = self._read_sample()

    def _read_sample(self) -> Optional[TrafficSample]:
        base_path = Path("/sys/class/net") / self.interface_name / "statistics"
        try:
            return TrafficSample(
                timestamp=time.monotonic(),
                rx_bytes=read_first_line(base_path / "rx_bytes"),
                tx_bytes=read_first_line(base_path / "tx_bytes"),
            )
        except Exception:
            return None

    def sample_kbps(self) -> tuple[Optional[float], Optional[float]]:
        current = self._read_sample()
        previous = self.previous
        self.previous = current

        if not current or not previous:
            return None, None

        delta_seconds = current.timestamp - previous.timestamp
        if delta_seconds <= 0:
            return None, None

        rx_delta = max(0, current.rx_bytes - previous.rx_bytes)
        tx_delta = max(0, current.tx_bytes - previous.tx_bytes)
        rx_kbps = round((rx_delta * 8.0) / delta_seconds / 1000.0, 2)
        tx_kbps = round((tx_delta * 8.0) / delta_seconds / 1000.0, 2)
        return rx_kbps, tx_kbps


def measure_ping(target: str, packets: int, timeout_seconds: int) -> tuple[Optional[float], Optional[float], Optional[float]]:
    command = [
        "ping",
        "-c",
        str(max(1, packets)),
        "-W",
        str(max(1, timeout_seconds)),
        target,
    ]

    try:
        result = subprocess.run(command, capture_output=True, text=True, check=False, timeout=timeout_seconds + packets + 2)
    except Exception:
        return None, None, None

    stdout = result.stdout or ""
    loss_match = PING_LOSS_RE.search(stdout)
    rtt_match = PING_RTT_RE.search(stdout)

    loss_pct = float(loss_match.group(1)) if loss_match else (100.0 if result.returncode else 0.0)
    if not rtt_match:
        return None, loss_pct, None

    latency_ms = float(rtt_match.group(2))
    jitter_ms = float(rtt_match.group(4))
    return round(latency_ms, 2), round(loss_pct, 3), round(jitter_ms, 2)


class Pi4McuClient:
    def __init__(self) -> None:
        load_env_file(ENV_FILE)

        self.backend_api_url = env_text("BACKEND_API_URL", required=True).rstrip("/")
        self.mqtt_host = env_text("BACKEND_MQTT_HOST", required=True)
        self.mqtt_port = env_int("BACKEND_MQTT_PORT", 1883)
        self.mqtt_username = env_text("BACKEND_MQTT_USERNAME", "")
        self.mqtt_password = env_text("BACKEND_MQTT_PASSWORD", "")
        self.tenant_code = env_text("TENANT_CODE", required=True)
        self.vessel_code = env_text("VESSEL_CODE", required=True)
        self.edge_code = env_text("EDGE_CODE", default=safe_hostname(), required=True)
        self.interface_name = env_text("ACTIVE_INTERFACE", "eth0")
        self.public_wan_ip = env_text("PUBLIC_WAN_IP", "")
        self.firmware_version = env_text("FIRMWARE_VERSION", "pi4-uplink-1.0.0")
        self.heartbeat_interval = env_float("HEARTBEAT_INTERVAL_SECONDS", 30.0)
        self.telemetry_interval = env_float("TELEMETRY_INTERVAL_SECONDS", 10.0)
        self.register_interval = env_float("REGISTER_INTERVAL_SECONDS", 300.0)
        self.register_token = env_text("BACKEND_REGISTER_TOKEN", "")
        self.device_token_file = Path(env_text("BACKEND_DEVICE_TOKEN_FILE", str(DEVICE_TOKEN_FILE)))
        self.device_token = read_device_token(self.device_token_file)
        self.ping_target = env_text("PING_TARGET", "1.1.1.1")
        self.ping_packets = env_int("PING_PACKETS", 2)
        self.ping_timeout_seconds = env_int("PING_TIMEOUT_SECONDS", 2)
        self.command_hook = env_text("COMMAND_HOOK", "")
        self.connected = False

        self.cpu_tracker = CpuUsageTracker()
        self.traffic_tracker = InterfaceTrafficTracker(self.interface_name)
        self.register_url = f"{self.backend_api_url}/api/mcu/register"
        self.base_topic = f"mcu/{self.tenant_code}/{self.vessel_code}/{self.edge_code}"
        self.command_topic = f"{self.base_topic}/command"

        self.mqtt_client = mqtt.Client(client_id=f"{self.tenant_code}-{self.vessel_code}-{self.edge_code}", clean_session=False)
        if self.mqtt_username:
            self.mqtt_client.username_pw_set(self.mqtt_username, self.mqtt_password or None)
        self.mqtt_client.reconnect_delay_set(min_delay=1, max_delay=30)
        self.mqtt_client.on_connect = self._on_connect
        self.mqtt_client.on_disconnect = self._on_disconnect
        self.mqtt_client.on_message = self._on_message

    def _on_connect(self, client, userdata, flags, rc):
        self.connected = rc == 0
        if self.connected:
            log(f"Connected to MQTT {self.mqtt_host}:{self.mqtt_port}")
            client.subscribe(self.command_topic, qos=1)
            log(f"Subscribed command topic {self.command_topic}")
        else:
            log(f"MQTT connect failed rc={rc}")

    def _on_disconnect(self, client, userdata, rc):
        self.connected = False
        log(f"MQTT disconnected rc={rc}")

    def _on_message(self, client, userdata, message):
        if message.topic != self.command_topic:
            return

        try:
            envelope = json.loads(message.payload.decode("utf-8"))
        except Exception as exc:
            log(f"command parse failed topic={message.topic}: {exc}")
            return

        self.handle_command(envelope)

    def ensure_public_wan_ip(self) -> Optional[str]:
        if self.public_wan_ip:
            return self.public_wan_ip

        detected = detect_public_ip()
        if detected:
            self.public_wan_ip = detected
            log(f"Detected public WAN IP: {detected}")
        return self.public_wan_ip or None

    def register_edge(self) -> None:
        payload = {
            "tenant_code": self.tenant_code,
            "vessel_code": self.vessel_code,
            "edge_code": self.edge_code,
            "firmware_version": self.firmware_version,
            "public_wan_ip": self.ensure_public_wan_ip(),
            "observed_at": now_iso(),
        }

        headers = {"x-mcu-register-token": self.register_token} if self.register_token else {}
        if self.device_token:
            headers["x-mcu-device-token"] = self.device_token

        try:
            result = post_json(self.register_url, payload, headers=headers or None)
            edge = result.get("edge", {})
            registered_ip = edge.get("public_wan_ip") or payload["public_wan_ip"] or "unknown"
            device_token = result.get("device_token") or edge.get("device_token")
            if device_token:
                self.device_token = str(device_token).strip()
                write_device_token(self.device_token_file, self.device_token)
            log(f"Edge registered successfully, WAN IP={registered_ip}")
        except error.HTTPError as exc:
            log(f"Edge register failed HTTP {exc.code}: {exc.read().decode('utf-8', errors='ignore')}")
        except Exception as exc:
            log(f"Edge register failed: {exc}")

    def mqtt_connect(self) -> None:
        log(f"Connecting MQTT to {self.mqtt_host}:{self.mqtt_port}")
        self.mqtt_client.connect(self.mqtt_host, self.mqtt_port, keepalive=60)
        self.mqtt_client.loop_start()

    def publish(self, channel: str, payload: dict) -> None:
        message = {
            "msg_id": f"{channel}-{uuid.uuid4()}",
            "timestamp": now_iso(),
            "schema_version": "v1",
            "payload": payload,
        }
        topic = f"{self.base_topic}/{channel}"
        info = self.mqtt_client.publish(topic, json.dumps(message), qos=1)
        info.wait_for_publish(timeout=5.0)
        if info.rc != mqtt.MQTT_ERR_SUCCESS:
            raise RuntimeError(f"publish failed rc={info.rc}")
        log(f"Published {channel} to {topic}")

    def publish_command_status(
        self,
        channel: str,
        command_job_id: str,
        status: str,
        message_text: Optional[str] = None,
        result_payload: Optional[dict] = None,
    ) -> None:
        payload = {
            "command_job_id": command_job_id,
            "status": status,
        }
        if message_text:
            payload["message"] = message_text
        if result_payload is not None:
            payload["result_payload"] = result_payload
        self.publish(channel, payload)

    def run_command_hook(self, command_job_id: str, command_type: str, command_payload: dict) -> dict:
        if not self.command_hook:
            return {
                "status": "failed",
                "message": "COMMAND_HOOK is not configured",
                "result_payload": {
                    "applied": False,
                    "mode": "missing_hook",
                    "command_type": command_type,
                    "command_payload": command_payload,
                },
            }

        command = shlex.split(self.command_hook)
        env = os.environ.copy()
        env.update(
            {
                "MCU_COMMAND_JOB_ID": command_job_id,
                "MCU_COMMAND_TYPE": command_type,
                "MCU_COMMAND_PAYLOAD": json.dumps(command_payload),
                "MCU_COMMAND_TOPIC": self.command_topic,
                "MCU_TENANT_CODE": self.tenant_code,
                "MCU_VESSEL_CODE": self.vessel_code,
                "MCU_EDGE_CODE": self.edge_code,
            }
        )

        completed = subprocess.run(
            command,
            capture_output=True,
            text=True,
            check=False,
            timeout=60,
            env=env,
        )

        stdout = (completed.stdout or "").strip()
        stderr = (completed.stderr or "").strip()
        if completed.returncode == 0:
            return {
                "status": "success",
                "message": stdout or "Command hook completed successfully",
                "result_payload": {
                    "applied": True,
                    "mode": "hook",
                    "command_type": command_type,
                    "command_payload": command_payload,
                    "stdout": stdout or None,
                },
            }

        return {
            "status": "failed",
            "message": stderr or stdout or f"Command hook exited with rc={completed.returncode}",
            "result_payload": {
                "applied": False,
                "mode": "hook",
                "returncode": completed.returncode,
                "command_type": command_type,
                "command_payload": command_payload,
                "stderr": stderr or None,
                "stdout": stdout or None,
            },
        }

    def execute_command(self, command_job_id: str, command_type: str, command_payload: dict) -> dict:
        if command_type == "policy_sync":
            return {
                "status": "success",
                "message": "Policy sync acknowledged",
                "result_payload": {
                    "applied": False,
                    "mode": "noop",
                    "command_type": command_type,
                    "command_payload": command_payload,
                },
            }

        if command_type in {"failback_vsat", "failover_starlink", "restore_automatic"}:
            return self.run_command_hook(command_job_id, command_type, command_payload)

        return {
            "status": "failed",
            "message": f"Unsupported command_type: {command_type}",
            "result_payload": {
                "applied": False,
                "command_type": command_type,
                "command_payload": command_payload,
            },
        }

    def handle_command(self, envelope: dict) -> None:
        raw_payload = envelope.get("payload") if isinstance(envelope, dict) else None
        payload = raw_payload if isinstance(raw_payload, dict) else (envelope if isinstance(envelope, dict) else {})
        command_job_id = payload.get("command_job_id") or (envelope.get("msg_id") if isinstance(envelope, dict) else None)
        command_type = payload.get("command_type") if isinstance(payload, dict) else None
        command_payload = payload.get("command_payload") if isinstance(payload, dict) else {}
        if not isinstance(command_payload, dict):
            command_payload = {}

        command_job_id = str(command_job_id).strip() if command_job_id else None
        command_type = str(command_type).strip() if command_type else None

        if not command_job_id or not command_type:
            log("command ignored: missing command_job_id or command_type")
            return

        log(f"command received job_id={command_job_id} type={command_type}")
        try:
            self.publish_command_status("ack", command_job_id, "ack", "accepted")
        except Exception as exc:
            log(f"command ack failed job_id={command_job_id}: {exc}")
            return

        try:
            result = self.execute_command(command_job_id, command_type, command_payload)
        except Exception as exc:
            result = {
                "status": "failed",
                "message": str(exc),
                "result_payload": {
                    "applied": False,
                    "command_type": command_type,
                    "command_payload": command_payload,
                },
            }

        try:
            self.publish_command_status(
                "result",
                command_job_id,
                result.get("status", "failed"),
                result.get("message"),
                result.get("result_payload"),
            )
            log(f"command result published job_id={command_job_id} status={result.get('status', 'failed')}")
        except Exception as exc:
            log(f"command result publish failed job_id={command_job_id}: {exc}")

    def send_heartbeat(self) -> None:
        payload = {
            "firmware_version": self.firmware_version,
            "cpu_usage_pct": self.cpu_tracker.usage_pct(),
            "ram_usage_pct": read_mem_usage_pct(),
            "status": "online",
            "public_wan_ip": self.ensure_public_wan_ip(),
        }
        self.publish("heartbeat", payload)

    def send_telemetry(self) -> None:
        rx_kbps, tx_kbps = self.traffic_tracker.sample_kbps()
        latency_ms, loss_pct, jitter_ms = measure_ping(
            target=self.ping_target,
            packets=self.ping_packets,
            timeout_seconds=self.ping_timeout_seconds,
        )

        payload = {
            "active_uplink": self.interface_name,
            "latency_ms": latency_ms,
            "loss_pct": loss_pct,
            "jitter_ms": jitter_ms,
            "rx_kbps": rx_kbps,
            "tx_kbps": tx_kbps,
            "throughput_kbps": round((rx_kbps or 0.0) + (tx_kbps or 0.0), 2) if (rx_kbps is not None or tx_kbps is not None) else None,
            "public_wan_ip": self.ensure_public_wan_ip(),
            "interfaces": [
                {
                    "name": self.interface_name,
                    "rx_kbps": rx_kbps,
                    "tx_kbps": tx_kbps,
                    "throughput_kbps": round((rx_kbps or 0.0) + (tx_kbps or 0.0), 2)
                    if (rx_kbps is not None or tx_kbps is not None)
                    else None,
                }
            ],
        }
        self.publish("telemetry", payload)

    def run(self) -> None:
        self.register_edge()
        self.mqtt_connect()

        next_register = time.monotonic() + self.register_interval
        next_heartbeat = time.monotonic() + 2.0
        next_telemetry = time.monotonic() + 5.0

        while True:
            now = time.monotonic()

            if now >= next_register:
                self.register_edge()
                next_register = now + self.register_interval

            if self.connected and now >= next_heartbeat:
                try:
                    self.send_heartbeat()
                except Exception as exc:
                    log(f"Heartbeat publish failed: {exc}")
                next_heartbeat = now + self.heartbeat_interval

            if self.connected and now >= next_telemetry:
                try:
                    self.send_telemetry()
                except Exception as exc:
                    log(f"Telemetry publish failed: {exc}")
                next_telemetry = now + self.telemetry_interval

            time.sleep(1.0)


def main() -> int:
    try:
        client = Pi4McuClient()
        client.run()
    except KeyboardInterrupt:
        log("Stopped by user")
        return 0
    except Exception as exc:
        log(f"Fatal error: {exc}")
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
