#!/usr/bin/env python3
import json
import os
import re
import shlex
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
    from paho.mqtt.enums import CallbackAPIVersion
except ImportError:
    print("Missing dependency: paho-mqtt", file=sys.stderr)
    print("Install it with: sudo apt install -y python3-paho-mqtt", file=sys.stderr)
    sys.exit(1)

try:
    from routeros_api import RouterOsApiPool
except ImportError:
    print("Missing dependency: RouterOS-api", file=sys.stderr)
    print("Install it with: python3 -m pip install RouterOS-api", file=sys.stderr)
    sys.exit(1)


ENV_FILE = Path(__file__).with_suffix(".env")
PING_RTT_RE = re.compile(r"=\s*([\d.]+)/([\d.]+)/([\d.]+)/([\d.]+)\s*ms")
PING_LOSS_RE = re.compile(r"(\d+(?:\.\d+)?)%\s*packet loss")
DEFAULT_WATCH_PORTS = {
    "ether1-Starlink": "P1-STARLINK",
    "ether2-VSAT": "P2-VSAT",
    "ether3-LTE": "P3-LTE",
    "ether4-MCU": "P4-MCU",
    "ether5-USER": "P5-USER",
}
DEFAULT_WAN_PRIORITY = ["ether1-Starlink", "ether2-VSAT", "ether3-LTE"]


def load_env_file(path: Path) -> None:
    if not path.exists():
        return
    for raw_line in path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        os.environ.setdefault(key.strip(), value.strip().strip("'").strip('"'))


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


def env_json(name: str, default):
    raw = os.getenv(name, "").strip()
    if not raw:
        return default
    return json.loads(raw)


def env_csv(name: str, default: list[str]) -> list[str]:
    raw = os.getenv(name, "").strip()
    if not raw:
        return default
    return [item.strip() for item in raw.split(",") if item.strip()]


def now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def log(message: str) -> None:
    print(f"[{now_iso()}] {message}", flush=True)


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


def measure_ping(target: str, packets: int, timeout_seconds: int) -> tuple[Optional[float], Optional[float], Optional[float]]:
    command = ["ping", "-c", str(max(1, packets)), "-W", str(max(1, timeout_seconds)), target]
    try:
        result = subprocess.run(
            command,
            capture_output=True,
            text=True,
            check=False,
            timeout=timeout_seconds + packets + 2,
        )
    except Exception:
        return None, None, None

    stdout = result.stdout or ""
    loss_match = PING_LOSS_RE.search(stdout)
    rtt_match = PING_RTT_RE.search(stdout)
    loss_pct = float(loss_match.group(1)) if loss_match else (100.0 if result.returncode else 0.0)
    if not rtt_match:
        return None, round(loss_pct, 3), None

    latency_ms = float(rtt_match.group(2))
    jitter_ms = float(rtt_match.group(4))
    return round(latency_ms, 2), round(loss_pct, 3), round(jitter_ms, 2)


@dataclass
class InterfaceCounters:
    name: str
    running: bool
    rx_bytes: int
    tx_bytes: int


@dataclass
class TelemetryInterface:
    name: str
    running: bool
    rx_kbps: float
    tx_kbps: float
    throughput_kbps: float
    total_gb: float


class RouterOsTrafficTracker:
    def __init__(self, api, watch_ports: dict[str, str]) -> None:
        self.interface_resource = api.get_resource("/interface")
        self.system_resource = api.get_resource("/system/resource")
        self.watch_ports = watch_ports
        self.previous_snapshot: Optional[dict[str, InterfaceCounters]] = None
        self.previous_timestamp: Optional[float] = None

    def read_system_resource(self) -> tuple[Optional[float], Optional[float], Optional[str]]:
        try:
            rows = self.system_resource.get()
        except Exception:
            return None, None, None
        if not rows:
            return None, None, None

        row = rows[0]
        cpu_usage_pct = self._as_float(row.get("cpu-load"))
        free_memory = self._as_float(row.get("free-memory"))
        total_memory = self._as_float(row.get("total-memory"))
        ram_usage_pct = None
        if total_memory and total_memory > 0 and free_memory is not None:
            ram_usage_pct = round(((total_memory - free_memory) / total_memory) * 100.0, 2)
        return cpu_usage_pct, ram_usage_pct, row.get("version")

    def sample(self) -> list[TelemetryInterface]:
        current_snapshot = self._read_interfaces()
        current_timestamp = time.monotonic()
        previous_snapshot = self.previous_snapshot
        previous_timestamp = self.previous_timestamp
        self.previous_snapshot = current_snapshot
        self.previous_timestamp = current_timestamp

        if not previous_snapshot or previous_timestamp is None:
            return []

        interval = current_timestamp - previous_timestamp
        if interval <= 0:
            return []

        samples: list[TelemetryInterface] = []
        for name, current in current_snapshot.items():
            previous = previous_snapshot.get(name)
            if not previous:
                continue

            rx_delta = max(0, current.rx_bytes - previous.rx_bytes)
            tx_delta = max(0, current.tx_bytes - previous.tx_bytes)
            rx_kbps = round((rx_delta * 8.0) / interval / 1000.0, 2)
            tx_kbps = round((tx_delta * 8.0) / interval / 1000.0, 2)
            samples.append(
                TelemetryInterface(
                    name=name,
                    running=current.running,
                    rx_kbps=rx_kbps,
                    tx_kbps=tx_kbps,
                    throughput_kbps=round(rx_kbps + tx_kbps, 2),
                    total_gb=round((current.rx_bytes + current.tx_bytes) / (1024.0 ** 3), 3),
                )
            )
        return samples

    def _read_interfaces(self) -> dict[str, InterfaceCounters]:
        interfaces = {}
        for iface in self.interface_resource.get():
            name = iface.get("name")
            if name not in self.watch_ports:
                continue
            interfaces[name] = InterfaceCounters(
                name=name,
                running=iface.get("running") == "true",
                rx_bytes=int(iface.get("rx-byte", 0)),
                tx_bytes=int(iface.get("tx-byte", 0)),
            )
        return interfaces

    @staticmethod
    def _as_float(value) -> Optional[float]:
        try:
            if value is None or value == "":
                return None
            return float(value)
        except (TypeError, ValueError):
            return None


class BackendCompatibleMcu:
    def __init__(self) -> None:
        load_env_file(ENV_FILE)

        self.backend_api_url = env_text("BACKEND_API_URL", required=True).rstrip("/")
        self.mqtt_host = env_text("BACKEND_MQTT_HOST", required=True)
        self.mqtt_port = env_int("BACKEND_MQTT_PORT", 1883)
        self.mqtt_username = env_text("BACKEND_MQTT_USERNAME", "")
        self.mqtt_password = env_text("BACKEND_MQTT_PASSWORD", "")
        self.tenant_code = env_text("TENANT_CODE", required=True)
        self.vessel_code = env_text("VESSEL_CODE", required=True)
        self.edge_code = env_text("EDGE_CODE", required=True)
        self.firmware_version = env_text("FIRMWARE_VERSION", "routeros-uplink-1.0.0")
        self.mk_ip = env_text("MK_IP", "10.0.0.1")
        self.mk_user = env_text("MK_USER", required=True)
        self.mk_pass = env_text("MK_PASS", required=True)
        self.heartbeat_interval = env_float("HEARTBEAT_INTERVAL_SECONDS", 15.0)
        self.telemetry_interval = env_float("TELEMETRY_INTERVAL_SECONDS", 5.0)
        self.register_interval = env_float("REGISTER_INTERVAL_SECONDS", 300.0)
        self.register_token = env_text("BACKEND_REGISTER_TOKEN", "")
        self.ping_target = env_text("PING_TARGET", "8.8.8.8")
        self.ping_packets = env_int("PING_PACKETS", 2)
        self.ping_timeout_seconds = env_int("PING_TIMEOUT_SECONDS", 2)
        self.watch_ports = env_json("WATCH_PORTS_JSON", DEFAULT_WATCH_PORTS)
        self.wan_priority = env_csv("WAN_PRIORITY", DEFAULT_WAN_PRIORITY)
        self.command_hook = env_text("COMMAND_HOOK", "")

        self.register_url = f"{self.backend_api_url}/api/mcu/register"
        self.base_topic = f"mcu/{self.tenant_code}/{self.vessel_code}/{self.edge_code}"
        self.command_topic = f"{self.base_topic}/command"
        self.api_pool = None
        self.tracker: Optional[RouterOsTrafficTracker] = None

        self.mqtt_client = mqtt.Client(
            CallbackAPIVersion.VERSION2,
            client_id=f"{self.edge_code}-{uuid.uuid4().hex[:8]}",
            clean_session=True,
        )
        if self.mqtt_username:
            self.mqtt_client.username_pw_set(self.mqtt_username, self.mqtt_password or None)
        self.mqtt_client.on_connect = self._on_connect
        self.mqtt_client.on_message = self._on_message

    def _on_connect(self, client, userdata, flags, reason_code, properties=None):
        reason = getattr(reason_code, "value", reason_code)
        try:
            reason_int = int(reason)
        except (TypeError, ValueError):
            reason_int = 1 if str(reason).lower() not in {"success", "0"} else 0

        if reason_int == 0:
            log(f"Connected to MQTT {self.mqtt_host}:{self.mqtt_port}")
            client.subscribe(self.command_topic, qos=1)
            log(f"Subscribed command topic {self.command_topic}")
        else:
            log(f"MQTT connect failed rc={reason}")

    def _on_message(self, client, userdata, message):
        if message.topic != self.command_topic:
            return

        try:
            envelope = json.loads(message.payload.decode("utf-8"))
        except Exception as exc:
            log(f"command parse failed topic={message.topic}: {exc}")
            return

        self.handle_command(envelope)

    def connect(self) -> None:
        self.mqtt_client.connect(self.mqtt_host, self.mqtt_port, keepalive=60)
        self.mqtt_client.loop_start()
        self.api_pool = RouterOsApiPool(
            self.mk_ip,
            username=self.mk_user,
            password=self.mk_pass,
            plaintext_login=True,
        )
        self.tracker = RouterOsTrafficTracker(self.api_pool.get_api(), self.watch_ports)
        log(f"connected backend={self.mqtt_host}:{self.mqtt_port} mikrotik={self.mk_ip}")

    def disconnect(self) -> None:
        try:
            self.mqtt_client.loop_stop()
            self.mqtt_client.disconnect()
        except Exception:
            pass
        if self.api_pool:
            try:
                self.api_pool.disconnect()
            except Exception:
                pass
        self.api_pool = None
        self.tracker = None

    def register(self) -> None:
        headers = {"x-mcu-register-token": self.register_token} if self.register_token else None
        response = post_json(
            self.register_url,
            {
                "tenant_code": self.tenant_code,
                "vessel_code": self.vessel_code,
                "edge_code": self.edge_code,
                "firmware_version": self.firmware_version,
            },
            headers=headers,
        )
        log(f"register ok edge={response.get('edge', {}).get('edge_code', self.edge_code)}")

    def publish(self, channel: str, payload: dict) -> None:
        message = {
            "msg_id": str(uuid.uuid4()),
            "timestamp": now_iso(),
            "tenant_id": self.tenant_code,
            "vessel_id": self.vessel_code,
            "edge_id": self.edge_code,
            "schema_version": "v1",
            "payload": payload,
        }
        self.mqtt_client.publish(f"{self.base_topic}/{channel}", json.dumps(message), qos=1)

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

    def extract_command_payload(self, envelope: dict) -> tuple[Optional[str], Optional[str], dict]:
        raw_payload = envelope.get("payload") if isinstance(envelope, dict) else None
        payload = raw_payload if isinstance(raw_payload, dict) else (envelope if isinstance(envelope, dict) else {})
        command_job_id = payload.get("command_job_id") or (envelope.get("msg_id") if isinstance(envelope, dict) else None)
        command_type = payload.get("command_type") if isinstance(payload, dict) else None
        command_payload = payload.get("command_payload") if isinstance(payload, dict) else {}
        if not isinstance(command_payload, dict):
            command_payload = {}
        return (
            str(command_job_id).strip() if command_job_id else None,
            str(command_type).strip() if command_type else None,
            command_payload,
        )

    def run_policy_sync(self) -> dict:
        script_path = Path(__file__).with_name("routeros_policy.py")
        completed = subprocess.run(
            [sys.executable, str(script_path), "--apply"],
            capture_output=True,
            text=True,
            check=False,
            timeout=120,
        )

        stdout = (completed.stdout or "").strip()
        stderr = (completed.stderr or "").strip()
        if completed.returncode == 0:
            return {
                "status": "success",
                "message": stdout or "RouterOS policy synchronized",
                "result_payload": {
                    "applied": True,
                    "mode": "routeros_policy_apply",
                    "stdout": stdout or None,
                },
            }

        return {
            "status": "failed",
            "message": stderr or stdout or f"Policy sync exited with rc={completed.returncode}",
            "result_payload": {
                "applied": False,
                "mode": "routeros_policy_apply",
                "returncode": completed.returncode,
                "stderr": stderr or None,
                "stdout": stdout or None,
            },
        }

    def run_command_hook(self, command_job_id: str, command_type: str, command_payload: dict) -> dict:
        if not self.command_hook:
            return {
                "status": "success",
                "message": "Command received; no COMMAND_HOOK configured",
                "result_payload": {
                    "applied": False,
                    "mode": "noop",
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
            return self.run_policy_sync()

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
        command_job_id, command_type, command_payload = self.extract_command_payload(envelope)
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

    def choose_active_uplink(self, interfaces: list[TelemetryInterface]) -> Optional[TelemetryInterface]:
        by_name = {iface.name: iface for iface in interfaces}
        for name in self.wan_priority:
            iface = by_name.get(name)
            if iface and iface.running and iface.throughput_kbps > 0:
                return iface
        running = [iface for iface in interfaces if iface.running]
        if running:
            return max(running, key=lambda item: item.throughput_kbps)
        return interfaces[0] if interfaces else None

    def run(self) -> None:
        self.connect()
        last_register_at = 0.0
        last_heartbeat_at = 0.0
        last_telemetry_at = 0.0

        while True:
            try:
                if not self.tracker:
                    raise RuntimeError("tracker_unavailable")

                now = time.monotonic()
                if now - last_register_at >= self.register_interval:
                    self.register()
                    last_register_at = now

                cpu_usage_pct, ram_usage_pct, firmware_version = self.tracker.read_system_resource()
                if now - last_heartbeat_at >= self.heartbeat_interval:
                    self.publish(
                        "heartbeat",
                        {
                            "firmware_version": firmware_version or self.firmware_version,
                            "cpu_usage_pct": cpu_usage_pct,
                            "ram_usage_pct": ram_usage_pct,
                            "status": "online",
                        },
                    )
                    last_heartbeat_at = now

                interfaces = self.tracker.sample()
                if interfaces and now - last_telemetry_at >= self.telemetry_interval:
                    active = self.choose_active_uplink(interfaces)
                    latency_ms, loss_pct, jitter_ms = measure_ping(
                        self.ping_target,
                        self.ping_packets,
                        self.ping_timeout_seconds,
                    )
                    self.publish(
                        "telemetry",
                        {
                            "active_uplink": active.name if active else None,
                            "latency_ms": latency_ms,
                            "loss_pct": loss_pct,
                            "jitter_ms": jitter_ms,
                            "rx_kbps": active.rx_kbps if active else 0,
                            "tx_kbps": active.tx_kbps if active else 0,
                            "throughput_kbps": active.throughput_kbps if active else 0,
                            "interfaces": [
                                {
                                    "name": iface.name,
                                    "rx_kbps": iface.rx_kbps,
                                    "tx_kbps": iface.tx_kbps,
                                    "throughput_kbps": iface.throughput_kbps,
                                    "total_gb": iface.total_gb,
                                }
                                for iface in interfaces
                            ],
                        },
                    )
                    log(
                        f"telemetry sent active={active.name if active else 'n/a'} "
                        f"rx={active.rx_kbps if active else 0:.2f}kbps "
                        f"tx={active.tx_kbps if active else 0:.2f}kbps"
                    )
                    last_telemetry_at = now

                time.sleep(1)
            except error.URLError as exc:
                log(f"register failed: {exc}")
                time.sleep(5)
            except KeyboardInterrupt:
                log("stopped by user")
                break
            except Exception as exc:
                log(f"runtime error: {exc}")
                time.sleep(5)

        self.disconnect()


if __name__ == "__main__":
    BackendCompatibleMcu().run()
