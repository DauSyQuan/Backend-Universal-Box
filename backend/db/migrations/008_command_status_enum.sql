do $$ begin
  create type command_status as enum ('queued', 'sent', 'ack', 'success', 'failed');
exception
  when duplicate_object then null;
end $$;

alter table command_jobs
  drop constraint if exists command_jobs_status_check;

alter table command_jobs
  alter column status type command_status using status::text::command_status;
