-- Core schema v1 for MCU backend

create extension if not exists "pgcrypto";

create table if not exists tenants (
  id uuid primary key default gen_random_uuid(),
  code text unique not null,
  name text not null,
  created_at timestamptz not null default now()
);

create table if not exists sites (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  code text not null,
  name text not null,
  created_at timestamptz not null default now(),
  unique (tenant_id, code)
);

create table if not exists vessels (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  site_id uuid references sites(id) on delete set null,
  code text not null,
  name text not null,
  created_at timestamptz not null default now(),
  unique (tenant_id, code)
);

create table if not exists edge_boxes (
  id uuid primary key default gen_random_uuid(),
  vessel_id uuid not null references vessels(id) on delete cascade,
  edge_code text not null,
  public_wan_ip inet,
  firmware_version text,
  device_token_hash text,
  device_token_issued_at timestamptz,
  device_last_register_at timestamptz,
  device_last_register_ip inet,
  last_seen_at timestamptz,
  created_at timestamptz not null default now(),
  unique (vessel_id, edge_code)
);

alter table edge_boxes
  add column if not exists public_wan_ip inet;
alter table edge_boxes
  add column if not exists device_token_hash text;
alter table edge_boxes
  add column if not exists device_token_issued_at timestamptz;
alter table edge_boxes
  add column if not exists device_last_register_at timestamptz;
alter table edge_boxes
  add column if not exists device_last_register_ip inet;

create index if not exists idx_edge_boxes_public_wan_ip
  on edge_boxes(public_wan_ip);

do $$
begin
  create type user_role as enum ('admin', 'noc', 'captain', 'customer');
exception
  when duplicate_object then null;
end
$$;

create table if not exists users (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  vessel_id uuid references vessels(id) on delete set null,
  username text not null,
  password_hash text not null,
  role user_role not null,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  unique (tenant_id, username)
);

create table if not exists packages (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  tenant_code text,
  code text not null,
  name text not null,
  description text,
  quota_mb bigint not null check (quota_mb >= 0),
  validity_days integer,
  price_usd numeric(10,2) not null default 0,
  is_active boolean not null default true,
  speed_limit_kbps integer,
  duration_days integer,
  updated_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  unique (tenant_id, code)
);

alter table packages
  add column if not exists tenant_code text;
alter table packages
  add column if not exists description text;
alter table packages
  add column if not exists validity_days integer;
alter table packages
  add column if not exists price_usd numeric(10,2) not null default 0;
alter table packages
  add column if not exists is_active boolean not null default true;
alter table packages
  add column if not exists updated_at timestamptz not null default now();

update packages p
set
  tenant_code = coalesce(p.tenant_code, t.code),
  validity_days = coalesce(p.validity_days, p.duration_days),
  updated_at = now()
from tenants t
where t.id = p.tenant_id
  and p.tenant_code is null;

create index if not exists idx_packages_tenant_code
  on packages(tenant_code);

create table if not exists package_assignments (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  package_id uuid not null references packages(id) on delete cascade,
  vessel_code text,
  remaining_mb bigint,
  assigned_at timestamptz not null default now(),
  expires_at timestamptz,
  status text not null default 'active',
  is_active boolean not null default true
);

alter table package_assignments
  add column if not exists vessel_code text;
alter table package_assignments
  add column if not exists remaining_mb bigint;
alter table package_assignments
  add column if not exists status text not null default 'active';

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'package_assignments_user_vessel_key'
  ) then
    alter table package_assignments
      add constraint package_assignments_user_vessel_key unique (user_id, vessel_code);
  end if;
end $$;

create table if not exists telemetry (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  vessel_id uuid not null references vessels(id) on delete cascade,
  edge_box_id uuid references edge_boxes(id) on delete set null,
  active_uplink text,
  latency_ms numeric(10,2),
  loss_pct numeric(6,3),
  jitter_ms numeric(10,2),
  throughput_kbps numeric(12,2),
  rx_kbps numeric(12,2),
  tx_kbps numeric(12,2),
  interfaces jsonb not null default '[]'::jsonb,
  observed_at timestamptz not null,
  created_at timestamptz not null default now()
);

create index if not exists idx_telemetry_vessel_observed
  on telemetry(vessel_id, observed_at desc);

create index if not exists idx_telemetry_edge_observed
  on telemetry(edge_box_id, observed_at desc);

create table if not exists telemetry_interfaces (
  id uuid primary key default gen_random_uuid(),
  telemetry_id uuid not null references telemetry(id) on delete cascade,
  interface_name text not null,
  rx_kbps numeric(12,2),
  tx_kbps numeric(12,2),
  throughput_kbps numeric(12,2),
  total_gb numeric(14,3),
  observed_at timestamptz not null,
  created_at timestamptz not null default now()
);

create index if not exists idx_telemetry_interfaces_lookup
  on telemetry_interfaces(telemetry_id);

create index if not exists idx_telemetry_interfaces_name_observed
  on telemetry_interfaces(interface_name, observed_at desc);

create or replace function fn_notify_telemetry()
returns trigger as $$
begin
  perform pg_notify(
    'mcu_telemetry_stream',
    json_build_object(
      'tenant_id', new.tenant_id,
      'vessel_id', new.vessel_id,
      'edge_box_id', new.edge_box_id,
      'telemetry_id', new.id
    )::text
  );
  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_notify_telemetry on telemetry;
create trigger trg_notify_telemetry
  after insert on telemetry
  for each row
  execute function fn_notify_telemetry();

create table if not exists ingest_messages (
  id uuid primary key default gen_random_uuid(),
  topic text not null,
  channel text not null,
  msg_id text,
  tenant_code text,
  vessel_code text,
  edge_code text,
  schema_version text,
  payload jsonb not null default '{}'::jsonb,
  raw jsonb not null default '{}'::jsonb,
  received_at timestamptz not null default now()
);

create index if not exists idx_ingest_messages_received
  on ingest_messages(received_at desc);

create index if not exists idx_ingest_messages_context
  on ingest_messages(tenant_code, vessel_code, edge_code, channel, received_at desc);

create unique index if not exists idx_ingest_messages_msg_id_unique
  on ingest_messages(msg_id)
  where msg_id is not null;

create table if not exists ingest_errors (
  id uuid primary key default gen_random_uuid(),
  topic text not null,
  channel text,
  msg_id text,
  reason text not null,
  detail text,
  raw jsonb,
  created_at timestamptz not null default now()
);

create index if not exists idx_ingest_errors_created
  on ingest_errors(created_at desc);

create index if not exists idx_ingest_errors_topic
  on ingest_errors(topic text_pattern_ops);

create table if not exists edge_heartbeats (
  id uuid primary key default gen_random_uuid(),
  tenant_code text not null,
  vessel_code text not null,
  edge_code text not null,
  firmware_version text,
  cpu_usage_pct numeric(6,3),
  ram_usage_pct numeric(6,3),
  status text,
  observed_at timestamptz not null,
  created_at timestamptz not null default now()
);

create index if not exists idx_edge_heartbeats_observed
  on edge_heartbeats(tenant_code, vessel_code, edge_code, observed_at desc);

create table if not exists user_usage (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  vessel_id uuid not null references vessels(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  tenant_code text,
  vessel_code text,
  username text,
  session_id text,
  package_assignment_id uuid references package_assignments(id) on delete set null,
  upload_mb numeric(14,3) not null default 0,
  download_mb numeric(14,3) not null default 0,
  total_mb numeric(14,3) generated always as (upload_mb + download_mb) stored,
  observed_at timestamptz not null,
  created_at timestamptz not null default now()
);

alter table user_usage
  add column if not exists tenant_code text;
alter table user_usage
  add column if not exists vessel_code text;
alter table user_usage
  add column if not exists username text;
alter table user_usage
  add column if not exists session_id text;
alter table user_usage
  add column if not exists package_assignment_id uuid references package_assignments(id) on delete set null;
alter table user_usage
  add column if not exists total_mb numeric(14,3) generated always as (upload_mb + download_mb) stored;

update user_usage uu
set
  tenant_code = coalesce(uu.tenant_code, t.code),
  vessel_code = coalesce(uu.vessel_code, v.code),
  username = coalesce(uu.username, u.username)
from tenants t
join vessels v on v.tenant_id = t.id
join users u on u.tenant_id = t.id
where uu.tenant_id = t.id
  and uu.vessel_id = v.id
  and uu.user_id = u.id
  and (uu.tenant_code is null or uu.vessel_code is null or uu.username is null);

create index if not exists idx_user_usage_username_time
  on user_usage(username, observed_at desc);

create index if not exists idx_user_usage_vessel_code_time
  on user_usage(vessel_code, observed_at desc);

create table if not exists alerts (
  id uuid primary key default gen_random_uuid(),
  tenant_code text,
  vessel_code text,
  username text,
  alert_type text not null check (alert_type in ('quota_80', 'quota_90', 'quota_exhausted')),
  message text,
  remaining_mb bigint,
  created_at timestamptz not null default now()
);

create index if not exists idx_alerts_username
  on alerts(username, created_at desc);

create table if not exists package_audit_events (
  id uuid primary key default gen_random_uuid(),
  tenant_code text,
  package_id uuid references packages(id) on delete set null,
  package_code text,
  vessel_code text,
  username text,
  action_type text not null,
  actor_user_id uuid,
  actor_username text,
  actor_role text,
  before_payload jsonb,
  after_payload jsonb,
  created_at timestamptz not null default now()
);

create index if not exists idx_package_audit_events_created_at
  on package_audit_events(created_at desc);

create index if not exists idx_package_audit_events_scope
  on package_audit_events(tenant_code, package_code, vessel_code, username, created_at desc);

create index if not exists idx_user_usage_user_observed
  on user_usage(user_id, observed_at desc);

create index if not exists idx_user_usage_vessel_observed
  on user_usage(vessel_id, observed_at desc);

create table if not exists vms_positions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  vessel_id uuid not null references vessels(id) on delete cascade,
  latitude numeric(9,6) not null,
  longitude numeric(9,6) not null,
  speed_knots numeric(8,3),
  heading_deg numeric(8,3),
  observed_at timestamptz not null,
  created_at timestamptz not null default now()
);

create table if not exists events (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  vessel_id uuid not null references vessels(id) on delete cascade,
  edge_box_id uuid references edge_boxes(id) on delete set null,
  event_type text not null,
  severity text not null,
  payload jsonb not null default '{}'::jsonb,
  observed_at timestamptz not null,
  created_at timestamptz not null default now()
);

create index if not exists idx_events_vessel_observed
  on events(vessel_id, observed_at desc);

create index if not exists idx_vms_positions_vessel_observed
  on vms_positions(vessel_id, observed_at desc);

create table if not exists command_jobs (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  vessel_id uuid not null references vessels(id) on delete cascade,
  edge_box_id uuid references edge_boxes(id) on delete set null,
  command_type text not null,
  command_payload jsonb not null default '{}'::jsonb,
  status text not null check (status in ('queued', 'sent', 'ack', 'success', 'failed')),
  ack_at timestamptz,
  result_at timestamptz,
  result_payload jsonb,
  created_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now()
);

create index if not exists idx_command_jobs_vessel_created
  on command_jobs(vessel_id, created_at desc);
