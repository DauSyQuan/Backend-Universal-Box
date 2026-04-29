create table if not exists hotspot_accounts (
  id uuid primary key default gen_random_uuid(),
  command_job_id uuid not null unique references command_jobs(id) on delete cascade,
  tenant_id uuid not null references tenants(id) on delete cascade,
  tenant_code text not null,
  vessel_id uuid not null references vessels(id) on delete cascade,
  vessel_code text not null,
  edge_box_id uuid references edge_boxes(id) on delete set null,
  edge_code text,
  username text not null,
  profile text not null,
  qos text not null,
  status text not null check (status in ('queued', 'sent', 'ack', 'success', 'failed')),
  ack_at timestamptz,
  result_at timestamptz,
  result_payload jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_hotspot_accounts_tenant_created
  on hotspot_accounts(tenant_id, created_at desc);

create index if not exists idx_hotspot_accounts_vessel_created
  on hotspot_accounts(vessel_id, created_at desc);

create index if not exists idx_hotspot_accounts_status_created
  on hotspot_accounts(status, created_at desc);

create index if not exists idx_hotspot_accounts_username
  on hotspot_accounts(username text_pattern_ops);

insert into hotspot_accounts (
  command_job_id,
  tenant_id,
  tenant_code,
  vessel_id,
  vessel_code,
  edge_box_id,
  edge_code,
  username,
  profile,
  qos,
  status,
  ack_at,
  result_at,
  result_payload,
  created_at,
  updated_at
)
select
  cj.id as command_job_id,
  cj.tenant_id,
  t.code as tenant_code,
  cj.vessel_id,
  v.code as vessel_code,
  cj.edge_box_id,
  e.edge_code,
  coalesce(nullif(trim(cj.command_payload->>'username'), ''), '') as username,
  coalesce(nullif(trim(cj.command_payload->>'profile'), ''), '') as profile,
  coalesce(nullif(trim(cj.command_payload->>'qos'), ''), '') as qos,
  cj.status,
  cj.ack_at,
  cj.result_at,
  cj.result_payload,
  cj.created_at,
  now()
from command_jobs cj
join tenants t on t.id = cj.tenant_id
join vessels v on v.id = cj.vessel_id
left join edge_boxes e on e.id = cj.edge_box_id
where cj.command_type = 'hotspot_create_account'
on conflict (command_job_id) do update set
  tenant_id = excluded.tenant_id,
  tenant_code = excluded.tenant_code,
  vessel_id = excluded.vessel_id,
  vessel_code = excluded.vessel_code,
  edge_box_id = excluded.edge_box_id,
  edge_code = excluded.edge_code,
  username = excluded.username,
  profile = excluded.profile,
  qos = excluded.qos,
  status = excluded.status,
  ack_at = excluded.ack_at,
  result_at = excluded.result_at,
  result_payload = excluded.result_payload,
  updated_at = now();
