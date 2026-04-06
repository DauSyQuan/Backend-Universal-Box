#!/usr/bin/env python3
import json
import os
import re
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


def post_json(url: str, payload: dict, timeout_seconds: float = 10.0) -> dict:
    body = json.dumps(payload).encode("utf-8")
    req = request.Request(
        url,
        data=body,
        headers={"content-type": "application/json; charset=utf-8"},
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
        self.ping_target = env_text("PING_TARGET", "8.8.8.8")
        self.ping_packets = env_int("PING_PACKETS", 2)
        self.ping_timeout_seconds = env_int("PING_TIMEOUT_SECONDS", 2)
        self.watch_ports = env_json("WATCH_PORTS_JSON", DEFAULT_WATCH_PORTS)
        self.wan_priority = env_csv("WAN_PRIORITY", DEFAULT_WAN_PRIORITY)

        self.register_url = f"{self.backend_api_url}/api/mcu/register"
        self.base_topic = f"mcu/{self.tenant_code}/{self.vessel_code}/{self.edge_code}"
        self.api_pool = None
        self.tracker: Optional[RouterOsTrafficTracker] = None

        self.mqtt_client = mqtt.Client(
            CallbackAPIVersion.VERSION2,
            client_id=f"{self.edge_code}-{uuid.uuid4().hex[:8]}",
            clean_session=True,
        )
        if self.mqtt_username:
            self.mqtt_client.username_pw_set(self.mqtt_username, self.mqtt_password or None)

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
        response = post_json(
            self.register_url,
            {
                "tenant_code": self.tenant_code,
                "vessel_code": self.vessel_code,
                "edge_code": self.edge_code,
                "firmware_version": self.firmware_version,
            },
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
