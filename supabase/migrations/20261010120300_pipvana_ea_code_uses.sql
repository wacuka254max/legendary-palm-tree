-- A code is good for three downloads, not forever. The count lives on the
-- request the code belongs to; a fourth attempt is refused and the person is
-- told to send the form again — which approves them automatically when the
-- email and the ID match what was approved before.
alter table public.pipvana_ea_requests
  add column if not exists code_uses integer not null default 0;
