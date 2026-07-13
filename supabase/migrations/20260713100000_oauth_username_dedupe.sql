-- Google OAuth signups arrive with a real email and no 'username' metadata,
-- so the profile trigger falls back to the email local part. Two problems the
-- password flow never hit:
--   1. Local parts can carry chars outside the app's username alphabet
--      ("John.Doe+x@gmail.com") — normalize to [a-z0-9_-].
--   2. profiles.username is UNIQUE; a collision would abort the auth.users
--      insert and the whole OAuth signup with it — dedupe with a numeric
--      suffix instead.

create or replace function public.handle_new_user()
returns trigger
language plpgsql security definer
set search_path = public
as $$
declare
  base text;
  candidate text;
  n int := 1;
begin
  base := coalesce(new.raw_user_meta_data ->> 'username', split_part(new.email, '@', 1));
  base := regexp_replace(lower(base), '[^a-z0-9_-]', '', 'g');
  if base = '' then
    base := 'user';
  end if;
  candidate := base;
  while exists (select 1 from public.profiles where username = candidate) loop
    n := n + 1;
    candidate := base || n::text;
  end loop;

  insert into public.profiles (id, username, team_id)
  values (new.id, candidate, (select id from public.teams where name = 'UBI'));
  return new;
end;
$$;
