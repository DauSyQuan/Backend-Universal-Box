drop index if exists idx_events_unread_created;
drop index if exists idx_events_vessel_read_created;
alter table events drop column if exists read_at;
