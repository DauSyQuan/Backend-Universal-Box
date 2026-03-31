# Role Matrix v1

## Roles

- `admin`: full platform control
- `noc`: operational monitoring and command execution
- `captain`: vessel-scoped monitoring for crew usage
- `customer`: read-only scoped visibility

## Access matrix

| Capability | admin | noc | captain | customer |
|---|---|---|---|---|
| Manage tenant/site/vessel | Y | N | N | N |
| Manage users/packages | Y | Y | N | N |
| View all telemetry/events | Y | Y | N | N |
| View vessel-scoped usage | Y | Y | Y | Y (scoped) |
| Send command to MCU | Y | Y | N | N |
| View command history | Y | Y | Y (scoped) | Y (scoped) |
| Manage RBAC | Y | N | N | N |

## Scope rules

- `captain` can only read entities linked to assigned vessel(s).
- `customer` can only read tenant-approved vessel/user summaries.
- Cross-tenant access is denied by default at query layer.

