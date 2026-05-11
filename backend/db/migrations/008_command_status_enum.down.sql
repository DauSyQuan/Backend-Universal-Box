alter table command_jobs
  alter column status type text using status::text;

drop type if exists command_status;
