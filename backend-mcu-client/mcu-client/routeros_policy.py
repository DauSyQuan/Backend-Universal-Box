#!/usr/bin/env python3
import argparse
import json
import os
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

try:
    from routeros_api import RouterOsApiPool
except ImportError:
    RouterOsApiPool = None


ENV_FILE = Path(__file__).with_suffix(".env")


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


def env_csv(name: str, default: Optional[list[str]] = None) -> list[str]:
    raw = os.getenv(name, "").strip()
    if not raw:
        return default or []

    if raw.startswith("["):
        try:
            parsed = json.loads(raw)
            return [str(item).strip() for item in parsed if str(item).strip()]
        except json.JSONDecodeError:
            pass

    return [item.strip() for item in raw.split(",") if item.strip()]


def normalize_label(value: str) -> str:
    return value.strip().lower()


def row_id(row: dict) -> Optional[str]:
    return row.get(".id") or row.get("id")


@dataclass
class PolicyGroup:
    name: str
    preferred_uplink: str
    address_list_name: str
    routing_table: str
    gateway: str
    source_addresses: list[str]

    @property
    def comment_prefix(self) -> str:
        return f"mcu-policy:{self.name.lower()}"


def build_groups(mode: str = "automatic") -> list[PolicyGroup]:
    work_sources = env_csv("WORK_SOURCE_ADDRESSES")
    entertainment_sources = env_csv("ENTERTAINMENT_SOURCE_ADDRESSES")
    normalized_mode = normalize_label(mode or "automatic")

    if normalized_mode == "failover_starlink":
        work_gateway = env_text("STARLINK_GATEWAY", env_text("VSAT_GATEWAY", ""))
        entertainment_gateway = work_gateway
        work_preferred = "Starlink"
        entertainment_preferred = "Starlink"
    elif normalized_mode == "failback_vsat":
        work_gateway = env_text("VSAT_GATEWAY", env_text("STARLINK_GATEWAY", ""))
        entertainment_gateway = work_gateway
        work_preferred = "VSAT"
        entertainment_preferred = "VSAT"
    else:
        work_gateway = env_text("WORK_GATEWAY", env_text("VSAT_GATEWAY", ""))
        entertainment_gateway = env_text("ENTERTAINMENT_GATEWAY", env_text("STARLINK_GATEWAY", ""))
        work_preferred = "VSAT"
        entertainment_preferred = "Starlink"

    return [
        PolicyGroup(
            name="work",
            preferred_uplink=work_preferred,
            address_list_name=env_text("WORK_ADDRESS_LIST", "mcu-work"),
            routing_table=env_text("WORK_ROUTING_TABLE", "to-vsat"),
            gateway=work_gateway,
            source_addresses=work_sources,
        ),
        PolicyGroup(
            name="entertainment",
            preferred_uplink=entertainment_preferred,
            address_list_name=env_text("ENTERTAINMENT_ADDRESS_LIST", "mcu-entertainment"),
            routing_table=env_text("ENTERTAINMENT_ROUTING_TABLE", "to-starlink"),
            gateway=entertainment_gateway,
            source_addresses=entertainment_sources,
        ),
    ]


def ensure_address_list(resource, group: PolicyGroup) -> list[str]:
    comment = f"{group.comment_prefix}:address"
    existing = [row for row in resource.get() if row.get("comment") == comment]
    for row in existing:
        identifier = row_id(row)
        if identifier:
            resource.remove(identifier)

    added = []
    for address in group.source_addresses:
        resource.add(
            list=group.address_list_name,
            address=address,
            comment=comment,
        )
        added.append(address)
    return added


def ensure_routing_table(resource, group: PolicyGroup) -> bool:
    existing = [row for row in resource.get() if normalize_label(row.get("name", "")) == normalize_label(group.routing_table)]
    if existing:
        return False

    resource.add(name=group.routing_table, fib="yes")
    return True


def ensure_routing_rule(resource, group: PolicyGroup) -> None:
    comment = f"{group.comment_prefix}:rule"
    existing = [row for row in resource.get() if row.get("comment") == comment]
    for row in existing:
        identifier = row_id(row)
        if identifier:
            resource.remove(identifier)

    resource.add(
        **{
            "src-address-list": group.address_list_name,
            "action": "lookup-only-in-table",
            "table": group.routing_table,
            "comment": comment,
        }
    )


def ensure_default_route(resource, group: PolicyGroup) -> bool:
    if not group.gateway:
        return False

    comment = f"{group.comment_prefix}:route"
    existing = [row for row in resource.get() if row.get("comment") == comment]
    for row in existing:
        identifier = row_id(row)
        if identifier:
            resource.remove(identifier)

    resource.add(
        **{
            "dst-address": "0.0.0.0/0",
            "gateway": group.gateway,
            "routing-table": group.routing_table,
            "distance": "1",
            "check-gateway": "ping",
            "comment": comment,
        }
    )
    return True


def render_plan(groups: list[PolicyGroup], mode: str = "automatic") -> str:
    lines = []
    lines.append(f"# mode={mode}")
    for group in groups:
        lines.append(f"# {group.name.upper()} -> {group.preferred_uplink}")
        lines.append(f"/routing table add fib=yes name={group.routing_table}")
        for address in group.source_addresses:
            lines.append(
                f'/ip firewall address-list add list={group.address_list_name} address={address} comment="{group.comment_prefix}:address"'
            )
        lines.append(
            f'/routing rule add src-address-list={group.address_list_name} action=lookup-only-in-table table={group.routing_table} comment="{group.comment_prefix}:rule"'
        )
        if group.gateway:
            lines.append(
                f'/ip route add dst-address=0.0.0.0/0 gateway={group.gateway} routing-table={group.routing_table} distance=1 check-gateway=ping comment="{group.comment_prefix}:route"'
            )
        else:
            lines.append(f"# gateway missing for {group.name}; default route not emitted")
        lines.append("")
    return "\n".join(lines).rstrip()


def apply_policy(router_ip: str, router_user: str, router_pass: str, groups: list[PolicyGroup]) -> None:
    if RouterOsApiPool is None:
        raise RuntimeError("RouterOS-api dependency missing. Install it with: python3 -m pip install RouterOS-api")

    api_pool = RouterOsApiPool(
        router_ip,
        username=router_user,
        password=router_pass,
        plaintext_login=True,
    )

    try:
        api = api_pool.get_api()
        address_list = api.get_resource("/ip/firewall/address-list")
        routing_table = api.get_resource("/routing/table")
        routing_rule = api.get_resource("/routing/rule")
        route = api.get_resource("/ip/route")

        for group in groups:
            ensure_routing_table(routing_table, group)
            ensure_address_list(address_list, group)
            ensure_routing_rule(routing_rule, group)
            if group.gateway:
                ensure_default_route(route, group)
    finally:
        api_pool.disconnect()


def main() -> int:
    load_env_file(ENV_FILE)

    parser = argparse.ArgumentParser(
        description="Generate or apply RouterOS policy routing for VSAT work traffic and Starlink entertainment traffic."
    )
    parser.add_argument("--apply", action="store_true", help="Apply the policy to the configured RouterOS device.")
    parser.add_argument("--print", dest="emit", action="store_true", help="Print the RouterOS commands that would be applied.")
    parser.add_argument(
        "--mode",
        choices=["automatic", "failback_vsat", "failover_starlink", "restore_automatic"],
        default="automatic",
        help="Apply the named uplink policy mode.",
    )
    args = parser.parse_args()

    mode = "automatic" if args.mode == "restore_automatic" else args.mode
    groups = build_groups(mode)

    if not args.apply and not args.emit:
        args.emit = True

    if args.emit:
        print(render_plan(groups, mode))

    if args.apply:
        router_ip = env_text("MK_IP", required=True)
        router_user = env_text("MK_USER", required=True)
        router_pass = env_text("MK_PASS", required=True)
        apply_policy(router_ip, router_user, router_pass, groups)
        print("[policy] applied successfully")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
