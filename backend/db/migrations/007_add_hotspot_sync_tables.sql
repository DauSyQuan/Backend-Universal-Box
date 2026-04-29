create table if not exists hotspot_user_directory (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  tenant_code text not null,
  vessel_id uuid not null references vessels(id) on delete cascade,
  vessel_code text not null,
  edge_box_id uuid references edge_boxes(id) on delete set null,
  edge_code text not null,
  username text not null,
  profile text,
  qos text,
  uptime text,
  is_deleted boolean not null default false,
  last_action text,
  status text not null default 'synced',
  raw_payload jsonb,
  synced_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_code, vessel_code, edge_code, username)
);

create index if not exists idx_hotspot_user_directory_tenant_created
  on hotspot_user_directory(tenant_id, created_at desc);

create index if not exists idx_hotspot_user_directory_vessel_created
  on hotspot_user_directory(vessel_id, created_at desc);

create index if not exists idx_hotspot_user_directory_edge_created
  on hotspot_user_directory(edge_code, created_at desc);

create index if not exists idx_hotspot_user_directory_username
  on hotspot_user_directory(username text_pattern_ops);

create table if not exists hotspot_active_users (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  tenant_code text not null,
  vessel_id uuid not null references vessels(id) on delete cascade,
  vessel_code text not null,
  edge_box_id uuid references edge_boxes(id) on delete set null,
  edge_code text not null,
  username text not null,
  ip_address text,
  mac_address text,
  session_time text,
  uptime text,
  raw_payload jsonb,
  synced_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_code, vessel_code, edge_code, username)
);

create index if not exists idx_hotspot_active_users_tenant_created
  on hotspot_active_users(tenant_id, created_at desc);

create index if not exists idx_hotspot_active_users_vessel_created
  on hotspot_active_users(vessel_id, created_at desc);

create index if not exists idx_hotspot_active_users_edge_created
  on hotspot_active_users(edge_code, created_at desc);

create index if not exists idx_hotspot_active_users_username
  on hotspot_active_users(username text_pattern_ops);
