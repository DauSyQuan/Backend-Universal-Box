create table if not exists traffic_hourly (
  vessel_id uuid not null references vessels(id) on delete cascade,
  edge_box_id uuid not null references edge_boxes(id) on delete cascade,
  hour_bucket timestamptz not null,
  rx_gb numeric(14,3) not null default 0,
  tx_gb numeric(14,3) not null default 0,
  total_gb numeric(14,3) not null default 0,
  primary key (vessel_id, edge_box_id, hour_bucket)
);

create index if not exists idx_traffic_hourly_vessel_hour
  on traffic_hourly(vessel_id, hour_bucket desc);

create index if not exists idx_traffic_hourly_edge_hour
  on traffic_hourly(edge_box_id, hour_bucket desc);

create table if not exists package_quotas (
  vessel_id uuid not null references vessels(id) on delete cascade,
  package_id uuid not null references packages(id) on delete cascade,
  quota_gb numeric(14,3) not null default 0,
  reset_day_of_month integer not null default 1 check (reset_day_of_month between 1 and 31),
  primary key (vessel_id, package_id)
);

create index if not exists idx_package_quotas_vessel
  on package_quotas(vessel_id);

insert into package_quotas (vessel_id, package_id, quota_gb, reset_day_of_month)
select distinct
  v.id as vessel_id,
  p.id as package_id,
  coalesce(p.quota_mb, 0)::numeric / 1024 as quota_gb,
  1 as reset_day_of_month
from package_assignments pa
join vessels v on v.code = pa.vessel_code
join packages p on p.id = pa.package_id
where pa.status = 'active'
  and pa.is_active = true
on conflict (vessel_id, package_id)
do update set
  quota_gb = excluded.quota_gb,
  reset_day_of_month = excluded.reset_day_of_month;
