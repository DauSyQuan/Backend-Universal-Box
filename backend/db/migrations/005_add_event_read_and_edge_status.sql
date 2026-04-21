alter table events
  add column if not exists read_at timestamptz;

create index if not exists idx_events_vessel_read_created
  on events(vessel_id, read_at, created_at desc);

create index if not exists idx_events_unread_created
  on events(read_at, created_at desc);
