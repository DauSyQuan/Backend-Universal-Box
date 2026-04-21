create table if not exists policies (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  vessel_id uuid not null references vessels(id) on delete cascade,
  groups jsonb not null default '[]'::jsonb,
  command_job_id uuid references command_jobs(id) on delete set null,
  created_at timestamptz not null default now(),
  applied_at timestamptz
);

create index if not exists idx_policies_tenant_vessel_created
  on policies(tenant_id, vessel_id, created_at desc);

create index if not exists idx_policies_applied_at
  on policies(applied_at desc);
