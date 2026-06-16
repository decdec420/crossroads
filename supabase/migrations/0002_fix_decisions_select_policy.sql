-- 0002 · Fix: decisions SELECT/UPDATE policies must not self-requery the table.
--
-- The original dec_select/dec_update policies called can_read_decision()/
-- can_edit_decision(), which SELECT from public.decisions. During an
-- INSERT ... RETURNING (what supabase-js upsert with representation does), that
-- self-requery cannot see the row being inserted, so the row was rejected with
-- "new row violates row-level security policy for table decisions".
--
-- Fix: evaluate ownership against the row's OWN columns (owner_id/team_id/id),
-- which are available during RETURNING. The participant check hits a different
-- table, which is fine. Authorization logic is unchanged.

drop policy if exists "dec_select" on public.decisions;
create policy "dec_select" on public.decisions for select to authenticated using (
  owner_id = (select auth.uid())
  or (team_id is not null and public.is_team_member(team_id))
  or exists (select 1 from public.decision_participants p
             where p.decision_id = decisions.id and p.user_id = (select auth.uid()))
);

drop policy if exists "dec_update" on public.decisions;
create policy "dec_update" on public.decisions for update to authenticated using (
  owner_id = (select auth.uid())
  or (team_id is not null and public.is_team_admin(team_id))
  or exists (select 1 from public.decision_participants p
             where p.decision_id = decisions.id and p.user_id = (select auth.uid()) and p.role in ('owner','facilitator'))
) with check (
  owner_id = (select auth.uid())
  or (team_id is not null and public.is_team_admin(team_id))
  or exists (select 1 from public.decision_participants p
             where p.decision_id = decisions.id and p.user_id = (select auth.uid()) and p.role in ('owner','facilitator'))
);
