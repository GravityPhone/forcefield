-- Lets any authenticated user (not just admins) persist a lat/lng for an
-- address they've just geocoded client-side in Talk mode. Narrowly scoped —
-- only touches lat/lng/updated_at, nothing else on the row — so it doesn't
-- require widening the admin-only addresses update policy.
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
  update public.addresses
  set lat = new_lat, lng = new_lng, updated_at = now()
  where id = address_id;
end;
$$;

grant execute on function public.set_address_location(uuid, double precision, double precision)
  to authenticated;
