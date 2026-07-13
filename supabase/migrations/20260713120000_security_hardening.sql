-- Security hardening pass (2026-07-13).
--
-- Closes the gaps found in the security review. Product decisions kept as-is
-- on purpose: the Union County voter file (public data) stays readable to any
-- authenticated user, and open self-signup stays on for the demo. Everything
-- else here is a lockdown.
--
-- 1. The admin AI's SQL tool now runs as a dedicated, allow-listed reader role
--    instead of service_role — so any table not explicitly granted (API keys,
--    chat internals, auth.*, storage.*) is unreachable BY DEFAULT rather than
--    unreachable only if someone remembered to REVOKE it.
-- 2. Belt-and-suspenders REVOKEs on the private tables that were missed.
-- 3. set_address_location can no longer overwrite an existing coordinate.
-- 4. profiles.username gets a server-side format constraint.
-- 5. chat-media attachments become private + chat-membership-scoped.

-- ============================================================
-- 1. Allow-listed reader role for the AI SQL tool
-- ============================================================
-- ai_readonly_query previously ran SECURITY INVOKER as service_role, which has
-- SELECT on every table by default — so walling anything off depended on a
-- per-table REVOKE (and admin_settings / message_reactions / chat_reads slipped
-- through). Instead, own the function with a role that has BYPASSRLS (to read
-- all rows for org-wide analytics) but only the explicit SELECT grants below.
-- Anything not listed → permission denied, regardless of the query text.

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'ai_reader') then
    create role ai_reader nologin bypassrls;
  end if;
end $$;

-- postgres must be a member of ai_reader to hand it ownership of the function.
grant ai_reader to postgres;
-- USAGE on schema public is already held by every role via the PUBLIC default
-- grant (schema public is owned by pg_database_owner, so postgres can't re-grant
-- it), so ai_reader needs no explicit schema grant — only the table SELECTs.

-- The allow-list: exactly the canvassing tables/views the assistant's system
-- prompt documents. New tables are NOT auto-granted — that's the point.
grant select on
  public.addresses,
  public.persons,
  public.knock_logs,
  public.profiles,
  public.teams,
  public.campaigns,
  public.squads,
  public.squad_members,
  public.turfs,
  public.turf_assignments,
  public.canvasser_leaderboard,
  public.household_knock_summary,
  public.household_latest_knock
to ai_reader;

create or replace function public.ai_readonly_query(query text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  result jsonb;
begin
  -- transaction_read_only stays as a second, shape-independent wall against
  -- writes; statement_timeout + the limit-500 subquery wrapper bound cost and
  -- block stacked multi-statement injection.
  perform set_config('transaction_read_only', 'on', true);
  perform set_config('statement_timeout', '5000', true);

  execute format(
    'select coalesce(jsonb_agg(row_to_json(sub)), ''[]''::jsonb) from (%s) as sub limit 500',
    query
  ) into result;

  return result;
exception when others then
  return jsonb_build_object('error', sqlerrm);
end;
$$;

-- Run the body as ai_reader (allow-list), not as the calling service_role.
-- Postgres requires the incoming owner to hold CREATE on the schema, so grant
-- it just long enough to take ownership, then revoke it — ai_reader keeps only
-- its table SELECTs and can create nothing (it's also nologin + read-only).
grant create on schema public to ai_reader;
alter function public.ai_readonly_query(text) owner to ai_reader;
revoke create on schema public from ai_reader;

revoke all on function public.ai_readonly_query(text) from public;
revoke all on function public.ai_readonly_query(text) from anon, authenticated;
grant execute on function public.ai_readonly_query(text) to service_role;

-- ============================================================
-- 2. Defense-in-depth REVOKEs on private tables the AI must never read
--    (harmless now that it runs as ai_reader, but keeps service_role honest)
-- ============================================================
revoke select, insert, update, delete on public.admin_settings from service_role;
revoke select, insert, update, delete on public.message_reactions from service_role;
revoke select, insert, update, delete on public.chat_reads from service_role;

-- ============================================================
-- 3. set_address_location: fill missing coordinates only
-- ============================================================
-- Was: any authenticated user could rewrite lat/lng on ANY address, corrupting
-- every map pin. Now non-managers may only backfill a still-uncoordinated door
-- (the legitimate field/geocoding path); managers can still correct anything.
create or replace function public.set_address_location(
  address_id uuid,
  new_lat double precision,
  new_lng double precision
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if public.is_admin() or auth.uid() is null then
    update public.addresses
    set lat = new_lat, lng = new_lng, updated_at = now()
    where id = address_id;
  else
    update public.addresses
    set lat = new_lat, lng = new_lng, updated_at = now()
    where id = address_id and lat is null and lng is null;
  end if;
end;
$$;

-- ============================================================
-- 4. Server-side username format constraint
-- ============================================================
-- The 3–20 lowercase-alnum rule was only enforced in the Vue form; a direct
-- anon-key signUp could set homoglyph/whitespace/overlong usernames that mimic
-- staff. NOT VALID so existing rows aren't retroactively rejected; it holds for
-- every future insert/update.
alter table public.profiles
  add constraint profiles_username_format
  check (username ~ '^[a-z0-9_-]{3,20}$') not valid;

-- ============================================================
-- 5. chat-media: private bucket, chat-membership-scoped access
-- ============================================================
-- A public bucket serves every object over an un-authenticated CDN URL, so a
-- private attachment leaked only its (unguessable) URL and it was world-open.
-- Make the bucket private and gate both upload and read on membership of the
-- chat whose id is the object's first path segment (<chatId>/<messageId>-i.ext).
-- The client now mints short-lived signed URLs at view time.
update storage.buckets set public = false where id = 'chat-media';

drop policy if exists "chat media is publicly readable" on storage.objects;
drop policy if exists "authenticated users upload chat media" on storage.objects;

create policy "chat media upload by members"
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'chat-media'
    and (
      public.chat_kind(((storage.foldername(name))[1])::uuid) = 'global'
      or public.is_chat_member(((storage.foldername(name))[1])::uuid)
    )
  );

create policy "chat media read by members"
  on storage.objects for select to authenticated
  using (
    bucket_id = 'chat-media'
    and (
      public.chat_kind(((storage.foldername(name))[1])::uuid) = 'global'
      or public.is_chat_member(((storage.foldername(name))[1])::uuid)
    )
  );
