-- MT5 EA ACCESS — who asked, who was approved, and the code that lets them in.
--
-- The Pipvana MT5 Expert Advisor is free, but it is only for the Pipvana trading
-- community: it takes its signals from our own engine, and that is
-- shared with people who came to Deriv through us rather than with anyone who
-- finds the page. So the file is not a public download; it is a request.
--
-- The shape of it: somebody enters their client or MT5 ID, a name and an
-- email. That arrives in Telegram through the ordinary support pipe, in the
-- same chat as every other message, with the conversation so far attached. The
-- owner checks the ID against the partner list on Deriv and answers /approve or
-- /decline. Approval mints a code here and posts it into that person's support
-- window; the code then unlocks the download.
--
-- `visitor_id` is the random string minted in the visitor's own browser — the
-- same key support conversations already use. It is what binds a code to one
-- person: a code pasted by anybody else is refused, which is the whole point of
-- issuing one.
--
-- `answered_at` is the third way a request stops waiting. /approve and /decline
-- decide it; replying to the person by hand takes it out of the queue WITHOUT
-- deciding it, because most conversations are handled by talking. Status still
-- says what was decided, if anything.
--
-- RLS is ON with NO policies, which denies everything. Nothing here is
-- reachable from a browser — the only doors are the functions under /api/mt5,
-- and they hold the service key.

create table if not exists public.pipvana_ea_requests (
  id            uuid primary key default gen_random_uuid(),
  visitor_id    text not null,
  mt5_login     text not null,
  name          text not null,
  email         text not null,

  status        text not null default 'pending'
                check (status in ('pending', 'approved', 'declined')),

  -- Minted on approval. Unique, so a code identifies exactly one request and
  -- therefore exactly one person.
  code          text unique,
  code_used_at  timestamptz,

  -- The Telegram message this request became. A swipe-reply points back at it.
  tg_message_id bigint,

  page          text,
  created_at    timestamptz not null default now(),
  decided_at    timestamptz,
  answered_at   timestamptz
);

create unique index if not exists pipvana_ea_requests_code_idx
  on public.pipvana_ea_requests (code) where code is not null;

create unique index if not exists pipvana_ea_requests_tg_idx
  on public.pipvana_ea_requests (tg_message_id) where tg_message_id is not null;

create index if not exists pipvana_ea_requests_visitor_idx
  on public.pipvana_ea_requests (visitor_id, created_at desc);

create index if not exists pipvana_ea_requests_open_idx
  on public.pipvana_ea_requests (created_at desc)
  where status = 'pending' and answered_at is null;

alter table public.pipvana_ea_requests enable row level security;
