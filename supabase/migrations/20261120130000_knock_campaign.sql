-- Which campaign a knock was logged under (2026-11-20, user call: the petition
-- and the registration drive should not show each other's door history).
--
-- Doors are shared by every campaign, and until now so was everything logged
-- at them: a registration campaign opened a door and read the petition's
-- visits. This stamps the canvasser's ACTIVE campaign on each new knock, the
-- same way stamp_registration_campaign does, so Talk can list only the visits
-- that belong to the campaign on screen.
--
-- Null on every knock from before this existed. Those are petition history
-- (the registration mode is a day old), and clients treat null as "petition".
-- Maps and the knock views are untouched: pin colors still read every visit.
alter table public.knock_logs
  add column campaign_id uuid references public.campaigns (id) on delete set null;

create function public.stamp_knock_campaign()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.campaign_id is null then
    select p.campaign_id into new.campaign_id
    from public.profiles p
    where p.id = new.canvasser_id;
  end if;
  return new;
end;
$$;

create trigger stamp_knock_campaign
  before insert on public.knock_logs
  for each row execute function public.stamp_knock_campaign();

-- Door registrations logged so far already know their campaign.
update public.knock_logs k
set campaign_id = r.campaign_id
from public.registration_logs r
where r.knock_log_id = k.id and r.campaign_id is not null;
