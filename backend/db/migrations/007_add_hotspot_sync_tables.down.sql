drop index if exists idx_hotspot_active_users_username;
drop index if exists idx_hotspot_active_users_edge_created;
drop index if exists idx_hotspot_active_users_vessel_created;
drop index if exists idx_hotspot_active_users_tenant_created;
drop table if exists hotspot_active_users;

drop index if exists idx_hotspot_user_directory_username;
drop index if exists idx_hotspot_user_directory_edge_created;
drop index if exists idx_hotspot_user_directory_vessel_created;
drop index if exists idx_hotspot_user_directory_tenant_created;
drop table if exists hotspot_user_directory;
