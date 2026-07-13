-- Google OAuth signups: use the person's real name ("First Last") as their
-- username instead of the email local part. Google populates
-- raw_user_meta_data.full_name / .name; the password flow still passes an
-- explicit 'username' and is unchanged. Spaces/capitals are fine here —
-- OAuth users never type their username to log in (that mapping only exists
-- for @example.com password accounts), it's display + uniqueness only.

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
  base := new.raw_user_meta_data ->> 'username';

  if base is null or base = '' then
    -- OAuth path: prefer the provider-supplied display name. Keep letters
    -- (incl. accented), digits, spaces, apostrophes and hyphens; collapse runs
    -- of whitespace.
    base := coalesce(new.raw_user_meta_data ->> 'full_name', new.raw_user_meta_data ->> 'name');
    if base is not null then
      base := trim(regexp_replace(regexp_replace(base, '[^[:alnum:] ''-]', '', 'g'), '\s+', ' ', 'g'));
    end if;
  end if;

  if base is null or base = '' then
    base := regexp_replace(lower(split_part(new.email, '@', 1)), '[^a-z0-9_-]', '', 'g');
  end if;
  if base = '' then
    base := 'user';
  end if;

  candidate := base;
  while exists (select 1 from public.profiles where username = candidate) loop
    n := n + 1;
    candidate := base || ' ' || n::text;
  end loop;

  insert into public.profiles (id, username, team_id)
  values (new.id, candidate, (select id from public.teams where name = 'UBI'));
  return new;
end;
$$;
