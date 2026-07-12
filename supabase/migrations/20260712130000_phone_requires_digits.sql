-- Tighten the member_phones CHECK from 20260712120000: the original shape
-- regex never required an actual digit, so punctuation-only strings like
-- "(...) - ..." passed and produced a dead tel: link (telHref strips
-- non-digits). Require 7–15 real digits — shortest dialable local number up
-- to the E.164 maximum. ProfileView mirrors this client-side.

alter table public.member_phones
  drop constraint if exists member_phones_phone_check;

alter table public.member_phones
  add constraint member_phones_phone_check check (
    phone ~ '^\+?[0-9() .-]{7,20}$'
    and length(regexp_replace(phone, '\D', '', 'g')) between 7 and 15
  );
