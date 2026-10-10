-- A visitor's screenshot goes to Telegram as its own message under their
-- words. Swiping on the picture to answer is as natural as swiping on the
-- text, so its id is kept too and both lead back to the same person.
alter table public.pipvana_support_messages
  add column if not exists tg_file_message_id bigint;

create unique index if not exists pipvana_support_messages_tg_file_idx
  on public.pipvana_support_messages (tg_file_message_id)
  where tg_file_message_id is not null;
