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
  firmware_version text,
  last_seen_at timestamptz,
  created_at timestamptz not null default now(),
  unique (vessel_id, edge_code)
);

create type user_role as enum ('admin', 'noc', 'captain', 'customer');

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
  code text not null,
  name text not null,
  quota_mb bigint not null check (quota_mb >= 0),
  speed_limit_kbps integer,
  duration_days integer,
  created_at timestamptz not null default now(),
  unique (tenant_id, code)
);

create table if not exists package_assignments (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  package_id uuid not null references packages(id) on delete cascade,
  assigned_at timestamptz not null default now(),
  expires_at timestamptz,
  is_active boolean not null default true
);

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
  observed_at timestamptz not null,
  created_at timestamptz not null default now()
);

create index if not exists idx_telemetry_vessel_observed
  on telemetry(vessel_id, observed_at desc);

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
  session_id text,
  upload_mb numeric(14,3) not null default 0,
  download_mb numeric(14,3) not null default 0,
  observed_at timestamptz not null,
  created_at timestamptz not null default now()
);

create index if not exists idx_user_usage_user_observed
  on user_usage(user_id, observed_at desc);

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
