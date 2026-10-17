-- Used keyring token ids (single use). RLS on and no policy: only the service role reaches it.
create table if not exists public.klicenka_jti (
  jti text primary key,
  expires_at timestamptz not null
);
alter table public.klicenka_jti enable row level security;
create index if not exists klicenka_jti_expires_at on public.klicenka_jti (expires_at);
