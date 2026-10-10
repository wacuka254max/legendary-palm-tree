-- SUPPORT — a conversation between the site and a phone.
--
-- Every message the support bubble sends is posted to Telegram and recorded
-- here with the id of the Telegram message it became. When the owner
-- swipe-replies to that message, Telegram hands back the id it was a reply
-- to, which is how we know which visitor the answer belongs to. Nothing else
-- identifies them: there is no account to sign into.
--
-- `visitor_id` is the random string minted in the visitor's own browser. It is
-- a thread key, not a tracker.
--
-- RLS is ON with NO policies, which denies everything. Nothing reaches this
-- from a browser: the only door is the functions under /api, and they hold
-- the service key.

create table if not exists public.pipvana_support_messages (
  id              uuid primary key default gen_random_uuid(),
  visitor_id      text not null,

  -- 'in'  = from the visitor, posted to Telegram
  -- 'out' = the owner's reply, waiting for the visitor to collect it
  direction       text not null check (direction in ('in', 'out')),
  body            text not null,

  -- Carried on inbound messages so a reply has context without a second lookup.
  email           text,
  name            text,
  source          text,
  page            text,

  -- The Telegram message this became. Only inbound rows have one.
  tg_message_id   bigint,

  -- A picture or a document, either direction. The file lives in the
  -- `support-files` storage bucket; these are the pointer, label and type.
  attachment_url  text,
  attachment_name text,
  attachment_type text,

  -- When the visitor's browser collected an outbound reply. Null = waiting.
  seen_at         timestamptz,
  created_at      timestamptz not null default now()
);

create index if not exists pipvana_support_messages_visitor_idx
  on public.pipvana_support_messages (visitor_id, created_at desc);

create unique index if not exists pipvana_support_messages_tg_idx
  on public.pipvana_support_messages (tg_message_id)
  where tg_message_id is not null;

create index if not exists pipvana_support_messages_unseen_idx
  on public.pipvana_support_messages (created_at)
  where direction = 'out' and seen_at is null;

alter table public.pipvana_support_messages enable row level security;

-- THE DOOR. A ban matches on EITHER the browser id or the email. Unbanning
-- does not delete the row: `active` goes false and `unbanned_at` is stamped.
create table if not exists public.pipvana_support_bans (
  id           uuid primary key default gen_random_uuid(),
  visitor_id   text,
  email        text,
  name         text,
  reason       text,
  active       boolean not null default true,
  banned_at    timestamptz not null default now(),
  unbanned_at  timestamptz,
  constraint pipvana_support_bans_has_key check (visitor_id is not null or email is not null)
);

create index if not exists pipvana_support_bans_visitor_idx
  on public.pipvana_support_bans (visitor_id) where active and visitor_id is not null;
create index if not exists pipvana_support_bans_email_idx
  on public.pipvana_support_bans (lower(email)) where active and email is not null;

alter table public.pipvana_support_bans enable row level security;

-- Attachments are served from a public bucket under random names.
insert into storage.buckets (id, name, public)
  values ('support-files', 'support-files', true)
  on conflict (id) do nothing;
