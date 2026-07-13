-- The security-hardening constraint profiles_username_format only allowed the
-- password flow's ^[a-z0-9_-]{3,20}$ usernames — but Google OAuth signups now
-- store the person's real name ("First Last"), so every OAuth signup aborted
-- with "Database error saving new user". Accept both shapes: the classic
-- handle, or a display name (letters/digits/spaces/apostrophes/hyphens,
-- 3-40 chars, starts and ends on a letter/digit — handle_new_user trims and
-- sanitizes to this alphabet already).

alter table public.profiles drop constraint profiles_username_format;
alter table public.profiles add constraint profiles_username_format
  check (
    username ~ '^[a-z0-9_-]{3,20}$'
    or username ~ '^[[:alnum:]][[:alnum:] ''-]{1,38}[[:alnum:]]$'
  ) not valid;
