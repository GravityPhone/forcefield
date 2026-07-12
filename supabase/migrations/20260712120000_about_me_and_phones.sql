-- About me + tap-to-call.
--
-- Bio fields live on profiles: the row is already org-readable by design
-- (leaderboards, chat, squad pages), self-writable (the update policy covers
-- the whole own row), and guard_profile_privileges only protects
-- role/team_id/username — so short self-descriptions need no policy changes.
--
-- Phone numbers do NOT live on profiles, on purpose: profiles' SELECT policy
-- is `using (true)` for every logged-in user, and RLS is row-level — a phone
-- column there could never be team-private. Instead each number is its own
-- row in member_phones, visible only to the owner and their teammates. No
-- row = no number = no call button, enforced at the database, not the UI.

alter table public.profiles
  add column bio text check (bio is null or char_length(bio) <= 500),
  add column why_canvassing text check (why_canvassing is null or char_length(why_canvassing) <= 300),
  add column fun_fact text check (fun_fact is null or char_length(fun_fact) <= 300);

create table public.member_phones (
  user_id uuid primary key references public.profiles (id) on delete cascade,
  -- Loose shape check only — digits plus common punctuation, enough to make
  -- a working tel: link. Not a full E.164 validation; canvassers type these
  -- on phones in the field.
  phone text not null check (phone ~ '^\+?[0-9() .-]{7,20}$'),
  updated_at timestamptz not null default now()
);

alter table public.member_phones enable row level security;

create policy "phones readable by owner and teammates"
  on public.member_phones for select
  to authenticated
  using (
    user_id = auth.uid()
    or (
      public.my_team_id() is not null
      and public.my_team_id() = (select team_id from public.profiles where id = user_id)
    )
  );

create policy "users insert own phone"
  on public.member_phones for insert
  to authenticated
  with check (user_id = auth.uid());

create policy "users update own phone"
  on public.member_phones for update
  to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

create policy "users delete own phone"
  on public.member_phones for delete
  to authenticated
  using (user_id = auth.uid());

-- Wall phones off from the admin AI's read-only SQL tool, same treatment as
-- the private chat tables: ai_readonly_query runs as service_role (security
-- invoker), so a real REVOKE is the barrier. Personal contact info is for
-- teammates in the field, not for querying.
revoke select, insert, update, delete on public.member_phones from service_role;
