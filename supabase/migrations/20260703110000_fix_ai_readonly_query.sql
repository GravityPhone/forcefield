-- Fix for 20260703100000: Postgres refuses `set role`/`set session
-- authorization` inside a SECURITY DEFINER function ("cannot set parameter
-- \"role\" within security-definer function") — a deliberate restriction to
-- prevent exactly the privilege-downgrade trick that migration attempted.
--
-- New approach: make the function SECURITY INVOKER so it runs as the caller
-- (service_role, since only the Netlify function calls it with the service
-- key). service_role has ALL privileges on every table by default in
-- Supabase, including the chat ones — so the wall against private chat
-- content has to be a real REVOKE on service_role itself, not a role switch.
-- transaction_read_only still hard-blocks any write, on every other table.

drop function if exists public.ai_readonly_query(text);

-- The role-switch approach is abandoned; drop the now-unused role and its
-- grants from the previous migration.
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'ai_readonly') then
    execute 'reassign owned by ai_readonly to postgres';
    execute 'drop owned by ai_readonly';
    execute 'drop role ai_readonly';
  end if;
end $$;

revoke select, insert, update, delete on public.chats from service_role;
revoke select, insert, update, delete on public.chat_members from service_role;
revoke select, insert, update, delete on public.chat_messages from service_role;

create or replace function public.ai_readonly_query(query text)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  result jsonb;
begin
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

revoke all on function public.ai_readonly_query(text) from public;
revoke all on function public.ai_readonly_query(text) from anon, authenticated;
grant execute on function public.ai_readonly_query(text) to service_role;
