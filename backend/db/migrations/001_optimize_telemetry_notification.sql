-- Optimize telemetry notification payload to reduce N+1 fetches in the API SSE path.

create index if not exists idx_telemetry_interfaces_telemetry_interface
  on telemetry_interfaces(telemetry_id, interface_name);

create or replace function fn_notify_telemetry()
returns trigger as $$
begin
  perform pg_notify(
    'mcu_telemetry_stream',
    json_build_object(
      'tenant_id', new.tenant_id,
      'vessel_id', new.vessel_id,
      'edge_box_id', new.edge_box_id,
      'telemetry_id', new.id,
      'active_uplink', new.active_uplink,
      'rx_kbps', new.rx_kbps,
      'tx_kbps', new.tx_kbps,
      'throughput_kbps', new.throughput_kbps,
      'observed_at', new.observed_at,
      'interfaces', new.interfaces
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
