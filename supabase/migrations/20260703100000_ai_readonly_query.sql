-- Admin AI chat: give the assistant a general read-only SQL tool over the
-- canvassing data, while walling off private user-to-user chat content
-- (chats/chat_members/chat_messages) that even admins can't normally read.
--
-- Two independent layers of protection, neither relying on parsing the SQL
-- text (which is inherently unreliable — e.g. `with x as (delete ...) select
-- *` reads like a SELECT but writes):
--   1. transaction_read_only — sourced from Postgres itself. Any write of any
--      shape hard-fails inside the function's transaction, full stop.
--   2. A dedicated ai_readonly role with BYPASSRLS (so it isn't blocked by
--      RLS policies scoped `to authenticated`, which don't apply to it at
--      all) but only explicit table-level SELECT grants — the chat tables
--      are simply never granted, so touching them is a permission error
--      regardless of what the query looks like.

create role ai_readonly nologin bypassrls;
grant ai_readonly to postgres;
grant usage on schema public to ai_readonly;

-- Grant SELECT on every current table/view except the private chat ones.
-- New tables added by future migrations need their own explicit grant here —
-- this is intentionally not automatic, so nothing new is exposed by default.
do $$
declare r record;
begin
  for r in
    select tablename from pg_tables
    where schemaname = 'public'
      and tablename not in ('chats', 'chat_members', 'chat_messages')
  loop
    execute format('grant select on public.%I to ai_readonly', r.tablename);
  end loop;

  for r in select viewname from pg_views where schemaname = 'public' loop
    execute format('grant select on public.%I to ai_readonly', r.viewname);
  end loop;
end $$;

create or replace function public.ai_readonly_query(query text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  result jsonb;
begin
  perform set_config('transaction_read_only', 'on', true);
  perform set_config('statement_timeout', '5000', true);
  execute 'set local role ai_readonly';

  -- Wrapping as a subquery both caps rows before aggregation and structurally
  -- blocks stacked multi-statement injection (a bare `;` breaks the
  -- surrounding SQL rather than running as a second statement).
  execute format(
    'select coalesce(jsonb_agg(row_to_json(sub)), ''[]''::jsonb) from (%s) as sub limit 500',
    query
  ) into result;

  return result;
exception when others then
  return jsonb_build_object('error', sqlerrm);
end;
$$;

-- Only the Netlify function (calling with the service role key) may invoke
-- this — never anon/authenticated, which would let any logged-in user run
-- arbitrary read queries directly.
revoke all on function public.ai_readonly_query(text) from public;
revoke all on function public.ai_readonly_query(text) from anon, authenticated;
grant execute on function public.ai_readonly_query(text) to service_role;
