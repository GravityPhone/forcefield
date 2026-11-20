-- New sign-ups land on the default campaigns, one per mode.
--
-- Until now a new account belonged to no campaign and was held on the
-- /join-campaign chooser until it picked one. For the demo that is a step
-- nobody needs, and the chooser also offers campaigns that are not the demo.
-- A campaign can now be marked the default for its mode (at most one each);
-- every new non-admin profile is put on the roster of each default and made
-- active on the petition one. The chooser still exists for a database with
-- no defaults, and join_campaign / set_active_campaign are unchanged.

alter table public.campaigns add column if not exists is_default boolean not null default false;

create unique index if not exists campaigns_one_default_per_mode
  on public.campaigns (mode) where is_default;

update public.campaigns set is_default = true
where name in ('Demo Campaign', 'Voter Registration Demo') and is_active;

create or replace function public.join_default_campaigns()
returns trigger
language plpgsql security definer set search_path = public
as $$
declare
  first_id uuid;
begin
  -- Admins are never on a campaign (guard_profile_privileges nulls it anyway).
  if new.role = 'admin' then
    return new;
  end if;

  insert into public.campaign_members (campaign_id, user_id)
  select c.id, new.id from public.campaigns c
  where c.is_default and c.is_active
  on conflict do nothing;

  if new.campaign_id is null then
    select c.id into first_id from public.campaigns c
    where c.is_default and c.is_active
    order by (c.mode = 'petition') desc, c.created_at
    limit 1;
    if first_id is not null then
      update public.profiles set campaign_id = first_id where id = new.id;
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists on_profile_created_join_defaults on public.profiles;
create trigger on_profile_created_join_defaults
  after insert on public.profiles
  for each row execute function public.join_default_campaigns();

-- Real (not simulated) accounts already here: on both rosters too, so the
-- header's mode switch never has to join them on the way through. Simulated
-- staff are left alone on purpose: each demo campaign has its own people.
insert into public.campaign_members (campaign_id, user_id)
select c.id, p.id from public.campaigns c cross join public.profiles p
where c.is_default and c.is_active and p.role <> 'admin' and not p.is_simulated
on conflict do nothing;

update public.profiles p set campaign_id = (
  select c.id from public.campaigns c where c.is_default and c.is_active
  order by (c.mode = 'petition') desc limit 1)
where p.campaign_id is null and p.role <> 'admin' and not p.is_simulated;
