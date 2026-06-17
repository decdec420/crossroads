-- 0003 · API keys, usage metering, and billing for the hosted MCP.
-- Represents the end state (supersedes the incremental 11–14 migrations applied live):
-- per-OWNER atomic quota so minting extra keys can't multiply the free allowance.

create table public.api_keys (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  name text not null default 'default',
  key_hash text not null unique,           -- sha256 hex of the raw key; raw shown once at mint
  key_prefix text not null,
  plan public.plan_type not null default 'free',
  revoked boolean not null default false,
  created_at timestamptz not null default now(),
  last_used_at timestamptz
);
create index idx_api_keys_owner on public.api_keys(owner_id);

create table public.api_usage (
  api_key_id uuid not null references public.api_keys(id) on delete cascade,
  period text not null,                    -- 'YYYY-MM'
  calls integer not null default 0,
  updated_at timestamptz not null default now(),
  primary key (api_key_id, period)
);

alter table public.api_keys enable row level security;
alter table public.api_usage enable row level security;
create policy "ak_select" on public.api_keys for select to authenticated using (owner_id = (select auth.uid()));
create policy "ak_delete" on public.api_keys for delete to authenticated using (owner_id = (select auth.uid()));
create policy "ak_update_revoke" on public.api_keys for update to authenticated using (owner_id = (select auth.uid())) with check (owner_id = (select auth.uid()));
create policy "au_select" on public.api_usage for select to authenticated
  using (exists (select 1 from public.api_keys k where k.id = api_usage.api_key_id and k.owner_id = (select auth.uid())));

-- Mint a key for the signed-in user; returns the raw key ONCE.
create or replace function public.mint_api_key(p_name text default 'default')
returns table(api_key text, key_id uuid, key_prefix text)
language plpgsql security definer set search_path = '' as $$
declare raw text; h text; pref text; newid uuid;
begin
  if auth.uid() is null then raise exception 'must be authenticated to mint an API key'; end if;
  raw := 'cr_live_' || encode(extensions.gen_random_bytes(24), 'hex');
  h := encode(extensions.digest(raw, 'sha256'), 'hex');
  pref := left(raw, 14);
  insert into public.api_keys(owner_id, name, key_hash, key_prefix)
    values (auth.uid(), coalesce(nullif(p_name,''),'default'), h, pref) returning id into newid;
  return query select raw, newid, pref;
end;
$$;
revoke execute on function public.mint_api_key(text) from public, anon;
grant execute on function public.mint_api_key(text) to authenticated;

-- Validate a key, resolve the effective plan from the owner's active subscription, and
-- (for billable calls) enforce the monthly quota across ALL of the owner's keys, atomically.
create or replace function public.mcp_meter(p_key_hash text, p_tool text, p_billable boolean)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  k record; eff text; quota int; per text := to_char(now(), 'YYYY-MM'); used int;
begin
  select * into k from public.api_keys where key_hash = p_key_hash and revoked = false;
  if not found then return jsonb_build_object('ok', false, 'reason', 'invalid_key'); end if;
  update public.api_keys set last_used_at = now() where id = k.id;

  select s.plan::text into eff from public.subscriptions s
    where s.user_id = k.owner_id and s.status in ('active', 'trialing')
    order by (case s.plan when 'team' then 3 when 'pro' then 2 else 1 end) desc limit 1;
  eff := coalesce(eff, k.plan::text, 'free');
  quota := case eff when 'free' then 100 when 'pro' then 10000 when 'team' then 50000 else 1000000 end;

  if not p_billable then return jsonb_build_object('ok', true, 'plan', eff, 'quota', quota); end if;

  insert into public.api_usage(api_key_id, period, calls) values (k.id, per, 0) on conflict do nothing;
  perform 1 from public.api_usage u join public.api_keys kk on kk.id = u.api_key_id
    where kk.owner_id = k.owner_id and u.period = per for update of u;
  select coalesce(sum(u.calls), 0) into used from public.api_usage u join public.api_keys kk on kk.id = u.api_key_id
    where kk.owner_id = k.owner_id and u.period = per;
  if used >= quota then
    return jsonb_build_object('ok', false, 'reason', 'quota_exceeded', 'plan', eff, 'calls', used, 'quota', quota);
  end if;
  update public.api_usage set calls = calls + 1, updated_at = now() where api_key_id = k.id and period = per;
  return jsonb_build_object('ok', true, 'plan', eff, 'calls', used + 1, 'quota', quota);
end;
$$;
-- Metering integrity: only the edge function's service role may call this.
revoke execute on function public.mcp_meter(text, text, boolean) from public, anon, authenticated;
