do $$ begin
  create type command_status as enum ('queued', 'sent', 'ack', 'success', 'failed');
exception
  when duplicate_object then null;
end $$;

alter table command_jobs
  alter column status type command_status using status::command_status;
