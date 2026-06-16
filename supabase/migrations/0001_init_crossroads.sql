-- Crossroads — consolidated initial schema (Supabase / Postgres 17)
-- Reconstructed from the 8 applied migrations, in order. Idempotent where practical.
-- Apply with `supabase db push` or psql.

-- ========================= 01 · foundation: enums & helpers =========================
create extension if not exists citext with schema extensions;

create type public.decision_status   as enum ('draft','active','decided','archived');
create type public.visibility         as enum ('private','team','link');
create type public.uncertainty_level  as enum ('low','med','high');
create type public.participant_role   as enum ('owner','facilitator','contributor','viewer');
create type public.team_role          as enum ('admin','member');
create type public.sim_status         as enum ('queued','running','done','error');
create type public.sim_kind           as enum ('individual','group');
create type public.aggregation_method as enum ('individual','mean','median','consensus');
create type public.plan_type          as enum ('free','pro','team');

create or replace function public.set_updated_at()
returns trigger language plpgsql set search_path = '' as $$
begin new.updated_at = now(); return new; end; $$;

-- ========================= 02 · identity & teams =========================
create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text, avatar_url text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create table public.teams (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete restrict,
  name text not null, slug text unique,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create table public.team_members (
  team_id uuid not null references public.teams(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role public.team_role not null default 'member',
  created_at timestamptz not null default now(),
  primary key (team_id, user_id)
);
create index idx_team_members_user on public.team_members(user_id);

create or replace function public.is_team_member(p_team uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists(select 1 from public.team_members m where m.team_id = p_team and m.user_id = auth.uid()); $$;
create or replace function public.is_team_admin(p_team uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists(select 1 from public.team_members m where m.team_id = p_team and m.user_id = auth.uid() and m.role = 'admin'); $$;
create or replace function public.shares_team_with(p_user uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists(select 1 from public.team_members a join public.team_members b on a.team_id = b.team_id
    where a.user_id = auth.uid() and b.user_id = p_user); $$;
create or replace function public.handle_team_owner()
returns trigger language plpgsql security definer set search_path = '' as $$
begin insert into public.team_members(team_id, user_id, role) values (new.id, new.owner_id, 'admin') on conflict do nothing; return new; end; $$;

create trigger trg_profiles_updated before update on public.profiles for each row execute function public.set_updated_at();
create trigger trg_teams_updated    before update on public.teams    for each row execute function public.set_updated_at();
create trigger trg_team_owner       after insert  on public.teams    for each row execute function public.handle_team_owner();

alter table public.profiles enable row level security;
alter table public.teams enable row level security;
alter table public.team_members enable row level security;

create policy "profiles_select" on public.profiles for select to authenticated using (id = (select auth.uid()) or public.shares_team_with(id));
create policy "profiles_update_self" on public.profiles for update to authenticated using (id = (select auth.uid())) with check (id = (select auth.uid()));
create policy "teams_select" on public.teams for select to authenticated using (public.is_team_member(id));
create policy "teams_insert" on public.teams for insert to authenticated with check (owner_id = (select auth.uid()));
create policy "teams_update" on public.teams for update to authenticated using (public.is_team_admin(id)) with check (public.is_team_admin(id));
create policy "teams_delete" on public.teams for delete to authenticated using (public.is_team_admin(id));
create policy "tm_select" on public.team_members for select to authenticated using (public.is_team_member(team_id));
create policy "tm_insert" on public.team_members for insert to authenticated with check (public.is_team_admin(team_id));
create policy "tm_update" on public.team_members for update to authenticated using (public.is_team_admin(team_id)) with check (public.is_team_admin(team_id));
create policy "tm_delete" on public.team_members for delete to authenticated using (public.is_team_admin(team_id) or user_id = (select auth.uid()));

-- ========================= 03 · decisions core =========================
create table public.decisions (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  team_id uuid references public.teams(id) on delete set null,
  title text not null, description text,
  status public.decision_status not null default 'draft',
  mode text not null default 'pro' check (mode in ('simple','pro')),
  risk numeric not null default 0 check (risk >= -1 and risk <= 1),
  trials int not null default 6000 check (trials between 100 and 200000),
  visibility public.visibility not null default 'private',
  share_token uuid, decided_option_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index idx_decisions_owner on public.decisions(owner_id);
create index idx_decisions_team  on public.decisions(team_id);

create table public.options (
  id uuid primary key default gen_random_uuid(),
  decision_id uuid not null references public.decisions(id) on delete cascade,
  name text not null, position int not null default 0,
  created_at timestamptz not null default now()
);
create index idx_options_decision on public.options(decision_id);

create table public.criteria (
  id uuid primary key default gen_random_uuid(),
  decision_id uuid not null references public.decisions(id) on delete cascade,
  name text not null,
  uncertainty public.uncertainty_level not null default 'med',
  default_weight numeric not null default 50 check (default_weight >= 0 and default_weight <= 100),
  position int not null default 0,
  created_at timestamptz not null default now()
);
create index idx_criteria_decision on public.criteria(decision_id);

create table public.decision_participants (
  id uuid primary key default gen_random_uuid(),
  decision_id uuid not null references public.decisions(id) on delete cascade,
  user_id uuid references auth.users(id) on delete set null,
  display_name text, invite_email extensions.citext,
  role public.participant_role not null default 'contributor',
  status text not null default 'active' check (status in ('invited','active')),
  created_at timestamptz not null default now(),
  unique (decision_id, user_id)
);
create index idx_participants_decision on public.decision_participants(decision_id);
create index idx_participants_user on public.decision_participants(user_id);

alter table public.decisions add constraint decisions_decided_option_fk
  foreign key (decided_option_id) references public.options(id) on delete set null;
create trigger trg_decisions_updated before update on public.decisions for each row execute function public.set_updated_at();

create or replace function public.can_read_decision(p_decision uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists(select 1 from public.decisions d where d.id = p_decision and (
    d.owner_id = auth.uid()
    or (d.team_id is not null and public.is_team_member(d.team_id))
    or exists(select 1 from public.decision_participants p where p.decision_id = d.id and p.user_id = auth.uid()))); $$;
create or replace function public.can_edit_decision(p_decision uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists(select 1 from public.decisions d where d.id = p_decision and (
    d.owner_id = auth.uid()
    or (d.team_id is not null and public.is_team_admin(d.team_id))
    or exists(select 1 from public.decision_participants p where p.decision_id = d.id and p.user_id = auth.uid() and p.role in ('owner','facilitator')))); $$;

alter table public.decisions enable row level security;
alter table public.options enable row level security;
alter table public.criteria enable row level security;
alter table public.decision_participants enable row level security;

create policy "dec_select" on public.decisions for select to authenticated using (public.can_read_decision(id));
create policy "dec_insert" on public.decisions for insert to authenticated with check (owner_id = (select auth.uid()));
create policy "dec_update" on public.decisions for update to authenticated using (public.can_edit_decision(id)) with check (public.can_edit_decision(id));
create policy "dec_delete" on public.decisions for delete to authenticated using (owner_id = (select auth.uid()) or (team_id is not null and public.is_team_admin(team_id)));

create policy "opt_select" on public.options for select to authenticated using (public.can_read_decision(decision_id));
create policy "opt_insert" on public.options for insert to authenticated with check (public.can_edit_decision(decision_id));
create policy "opt_update" on public.options for update to authenticated using (public.can_edit_decision(decision_id)) with check (public.can_edit_decision(decision_id));
create policy "opt_delete" on public.options for delete to authenticated using (public.can_edit_decision(decision_id));

create policy "crit_select" on public.criteria for select to authenticated using (public.can_read_decision(decision_id));
create policy "crit_insert" on public.criteria for insert to authenticated with check (public.can_edit_decision(decision_id));
create policy "crit_update" on public.criteria for update to authenticated using (public.can_edit_decision(decision_id)) with check (public.can_edit_decision(decision_id));
create policy "crit_delete" on public.criteria for delete to authenticated using (public.can_edit_decision(decision_id));

create policy "part_select" on public.decision_participants for select to authenticated using (public.can_read_decision(decision_id));
create policy "part_insert" on public.decision_participants for insert to authenticated with check (public.can_edit_decision(decision_id));
create policy "part_update" on public.decision_participants for update to authenticated using (public.can_edit_decision(decision_id)) with check (public.can_edit_decision(decision_id));
create policy "part_delete" on public.decision_participants for delete to authenticated using (public.can_edit_decision(decision_id));

-- ========================= 04 · inputs, simulations, records =========================
create table public.input_weights (
  decision_id uuid not null references public.decisions(id) on delete cascade,
  participant_id uuid not null references public.decision_participants(id) on delete cascade,
  criterion_id uuid not null references public.criteria(id) on delete cascade,
  weight numeric not null default 50 check (weight >= 0 and weight <= 100),
  updated_at timestamptz not null default now(),
  primary key (participant_id, criterion_id)
);
create index idx_input_weights_decision on public.input_weights(decision_id);
create index idx_input_weights_criterion on public.input_weights(criterion_id);

create table public.input_scores (
  decision_id uuid not null references public.decisions(id) on delete cascade,
  participant_id uuid not null references public.decision_participants(id) on delete cascade,
  option_id uuid not null references public.options(id) on delete cascade,
  criterion_id uuid not null references public.criteria(id) on delete cascade,
  likely numeric not null check (likely >= 0 and likely <= 10),
  updated_at timestamptz not null default now(),
  primary key (participant_id, option_id, criterion_id)
);
create index idx_input_scores_decision on public.input_scores(decision_id);
create index idx_input_scores_criterion on public.input_scores(criterion_id);
create index idx_input_scores_option on public.input_scores(option_id);

create table public.simulations (
  id uuid primary key default gen_random_uuid(),
  decision_id uuid not null references public.decisions(id) on delete cascade,
  participant_id uuid references public.decision_participants(id) on delete set null,
  kind public.sim_kind not null default 'individual',
  aggregation public.aggregation_method not null default 'individual',
  seed bigint not null, trials int not null default 6000,
  engine_version text not null default 'v1',
  status public.sim_status not null default 'queued',
  result jsonb, error text,
  created_by uuid default auth.uid() references auth.users(id) on delete set null,
  created_at timestamptz not null default now(), completed_at timestamptz
);
create index idx_simulations_decision on public.simulations(decision_id, created_at desc);
create index idx_simulations_participant on public.simulations(participant_id);
create index idx_simulations_created_by on public.simulations(created_by);

create table public.decision_records (
  id uuid primary key default gen_random_uuid(),
  decision_id uuid not null references public.decisions(id) on delete cascade,
  simulation_id uuid references public.simulations(id) on delete set null,
  title text, format text not null default 'pdf' check (format in ('pdf','html')),
  storage_path text, public_token uuid,
  created_by uuid default auth.uid() references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);
create index idx_records_decision on public.decision_records(decision_id);
create index idx_records_simulation on public.decision_records(simulation_id);
create index idx_records_created_by on public.decision_records(created_by);

create or replace function public.owns_participant(p_participant uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists(select 1 from public.decision_participants p where p.id = p_participant and p.user_id = auth.uid()); $$;

create trigger trg_input_weights_updated before update on public.input_weights for each row execute function public.set_updated_at();
create trigger trg_input_scores_updated  before update on public.input_scores  for each row execute function public.set_updated_at();

alter table public.input_weights enable row level security;
alter table public.input_scores enable row level security;
alter table public.simulations enable row level security;
alter table public.decision_records enable row level security;

create policy "iw_select" on public.input_weights for select to authenticated using (public.can_read_decision(decision_id));
create policy "iw_insert" on public.input_weights for insert to authenticated with check ((public.owns_participant(participant_id) or public.can_edit_decision(decision_id)) and public.can_read_decision(decision_id));
create policy "iw_update" on public.input_weights for update to authenticated using (public.owns_participant(participant_id) or public.can_edit_decision(decision_id)) with check (public.owns_participant(participant_id) or public.can_edit_decision(decision_id));
create policy "iw_delete" on public.input_weights for delete to authenticated using (public.owns_participant(participant_id) or public.can_edit_decision(decision_id));

create policy "is_select" on public.input_scores for select to authenticated using (public.can_read_decision(decision_id));
create policy "is_insert" on public.input_scores for insert to authenticated with check ((public.owns_participant(participant_id) or public.can_edit_decision(decision_id)) and public.can_read_decision(decision_id));
create policy "is_update" on public.input_scores for update to authenticated using (public.owns_participant(participant_id) or public.can_edit_decision(decision_id)) with check (public.owns_participant(participant_id) or public.can_edit_decision(decision_id));
create policy "is_delete" on public.input_scores for delete to authenticated using (public.owns_participant(participant_id) or public.can_edit_decision(decision_id));

create policy "sim_select" on public.simulations for select to authenticated using (public.can_read_decision(decision_id));
create policy "sim_insert" on public.simulations for insert to authenticated with check (public.can_read_decision(decision_id) and created_by = (select auth.uid()));
create policy "sim_update" on public.simulations for update to authenticated using (public.can_edit_decision(decision_id)) with check (public.can_edit_decision(decision_id));
create policy "sim_delete" on public.simulations for delete to authenticated using (public.can_edit_decision(decision_id));

create policy "rec_select" on public.decision_records for select to authenticated using (public.can_read_decision(decision_id));
create policy "rec_insert" on public.decision_records for insert to authenticated with check (public.can_edit_decision(decision_id));
create policy "rec_delete" on public.decision_records for delete to authenticated using (public.can_edit_decision(decision_id));

-- ========================= 05 · templates, journal, billing + realtime =========================
create table public.templates (
  id uuid primary key default gen_random_uuid(),
  slug text unique not null, title text not null, description text, category text,
  is_official boolean not null default false,
  author_id uuid references public.profiles(id) on delete set null,
  payload jsonb not null, usage_count int not null default 0,
  created_at timestamptz not null default now()
);
create index idx_templates_category on public.templates(category) where is_official;
create index idx_templates_author on public.templates(author_id);

create table public.decision_outcomes (
  id uuid primary key default gen_random_uuid(),
  decision_id uuid not null unique references public.decisions(id) on delete cascade,
  chosen_option_id uuid references public.options(id) on delete set null,
  decided_at timestamptz not null default now(),
  predicted_pbest numeric, expected_score numeric, review_due date,
  outcome_rating int check (outcome_rating between -2 and 2),
  reflection text, reviewed_at timestamptz,
  created_by uuid default auth.uid() references auth.users(id) on delete set null
);
create index idx_outcomes_review_due on public.decision_outcomes(review_due) where reviewed_at is null;
create index idx_outcomes_chosen_option on public.decision_outcomes(chosen_option_id);
create index idx_outcomes_created_by on public.decision_outcomes(created_by);

create table public.subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete cascade,
  team_id uuid references public.teams(id) on delete cascade,
  plan public.plan_type not null default 'free', status text not null default 'active',
  seats int not null default 1, stripe_customer_id text, stripe_subscription_id text,
  current_period_end timestamptz, updated_at timestamptz not null default now(),
  constraint sub_scope_chk check (num_nonnulls(user_id, team_id) = 1),
  unique (user_id), unique (team_id)
);
create trigger trg_subscriptions_updated before update on public.subscriptions for each row execute function public.set_updated_at();

alter table public.templates enable row level security;
alter table public.decision_outcomes enable row level security;
alter table public.subscriptions enable row level security;

create policy "tpl_select" on public.templates for select to authenticated using (is_official or author_id = (select auth.uid()));
create policy "tpl_insert" on public.templates for insert to authenticated with check (author_id = (select auth.uid()));
create policy "tpl_update" on public.templates for update to authenticated using (author_id = (select auth.uid())) with check (author_id = (select auth.uid()));
create policy "tpl_delete" on public.templates for delete to authenticated using (author_id = (select auth.uid()));

create policy "out_select" on public.decision_outcomes for select to authenticated using (public.can_read_decision(decision_id));
create policy "out_insert" on public.decision_outcomes for insert to authenticated with check (public.can_edit_decision(decision_id));
create policy "out_update" on public.decision_outcomes for update to authenticated using (public.can_edit_decision(decision_id)) with check (public.can_edit_decision(decision_id));
create policy "out_delete" on public.decision_outcomes for delete to authenticated using (public.can_edit_decision(decision_id));

-- Subscriptions are read-only to clients; only the Stripe webhook (service role) writes.
create policy "sub_select" on public.subscriptions for select to authenticated using (user_id = (select auth.uid()) or (team_id is not null and public.is_team_admin(team_id)));

alter publication supabase_realtime add table public.input_scores;
alter publication supabase_realtime add table public.input_weights;
alter publication supabase_realtime add table public.decision_participants;
alter publication supabase_realtime add table public.simulations;

-- ========================= 06 · new-user trigger + seed templates =========================
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  insert into public.profiles(id, display_name)
  values (new.id, coalesce(new.raw_user_meta_data->>'name', new.raw_user_meta_data->>'full_name', split_part(coalesce(new.email,''),'@',1)))
  on conflict (id) do nothing;
  return new;
end; $$;
create trigger on_auth_user_created after insert on auth.users for each row execute function public.handle_new_user();

insert into public.templates (slug, title, description, category, is_official, payload) values
('job-offer','Which job offer?','Compare offers across comp, growth, balance and stability.','Career',true,
 '{"options":["Offer A","Offer B"],"criteria":[{"name":"Compensation","uncertainty":"low","default_weight":25},{"name":"Growth & learning","uncertainty":"high","default_weight":35},{"name":"Work-life balance","uncertainty":"med","default_weight":20},{"name":"Stability","uncertainty":"low","default_weight":20}]}'::jsonb),
('hire-candidate','Which candidate to hire?','Structured, bias-resistant candidate comparison.','Hiring',true,
 '{"options":["Candidate 1","Candidate 2","Candidate 3"],"criteria":[{"name":"Skill & craft","uncertainty":"med","default_weight":30},{"name":"Collaboration","uncertainty":"high","default_weight":25},{"name":"Growth potential","uncertainty":"high","default_weight":25},{"name":"Compensation fit","uncertainty":"low","default_weight":20}]}'::jsonb),
('vendor-selection','Which vendor?','Weigh price, fit, risk and support across vendors.','Procurement',true,
 '{"options":["Vendor A","Vendor B"],"criteria":[{"name":"Total cost","uncertainty":"low","default_weight":30},{"name":"Feature fit","uncertainty":"med","default_weight":30},{"name":"Implementation risk","uncertainty":"high","default_weight":25},{"name":"Support quality","uncertainty":"med","default_weight":15}]}'::jsonb),
('where-to-live','Where should I live?','Compare places across cost, career, lifestyle and community.','Life',true,
 '{"options":["City A","City B"],"criteria":[{"name":"Cost of living","uncertainty":"low","default_weight":25},{"name":"Career opportunity","uncertainty":"med","default_weight":25},{"name":"Lifestyle & climate","uncertainty":"med","default_weight":25},{"name":"Community & friends","uncertainty":"high","default_weight":25}]}'::jsonb);

-- ========================= 07-08 · hardening (perf + security) =========================
-- FK covering indexes added inline above. Wrap auth.uid() in scalar subselects (done in policies above).
-- Lock down helper EXECUTE: keep authenticated (RLS needs it), drop anon; triggers need neither.
revoke execute on function public.is_team_member(uuid)    from anon;
revoke execute on function public.is_team_admin(uuid)     from anon;
revoke execute on function public.shares_team_with(uuid)  from anon;
revoke execute on function public.can_read_decision(uuid) from anon;
revoke execute on function public.can_edit_decision(uuid) from anon;
revoke execute on function public.owns_participant(uuid)  from anon;
revoke execute on function public.handle_new_user()  from anon, authenticated;
revoke execute on function public.handle_team_owner() from anon, authenticated;
revoke execute on function public.set_updated_at()    from anon, authenticated;
