-- Add the critical indexes called out by the Phase 1 optimization plan.

create index if not exists idx_edge_boxes_vessel_last_seen
  on edge_boxes(vessel_id, last_seen_at desc);

create index if not exists idx_package_assignments_vessel_status_assigned
  on package_assignments(vessel_code, status, assigned_at desc);

create index if not exists idx_package_assignments_package_status_assigned
  on package_assignments(package_id, status, assigned_at desc);

create index if not exists idx_package_assignments_user_status_assigned
  on package_assignments(user_id, status, assigned_at desc);

create index if not exists idx_telemetry_interfaces_telemetry_interface
  on telemetry_interfaces(telemetry_id, interface_name);

create index if not exists idx_ingest_errors_topic_created
  on ingest_errors(topic text_pattern_ops, created_at desc);

create index if not exists idx_user_usage_package_assignment_observed
  on user_usage(package_assignment_id, observed_at desc);

create index if not exists idx_alerts_scope_created
  on alerts(tenant_code, vessel_code, username, created_at desc);

create index if not exists idx_command_jobs_status_created
  on command_jobs(status, created_at desc);

create index if not exists idx_command_jobs_tenant_status_created
  on command_jobs(tenant_id, status, created_at desc);
