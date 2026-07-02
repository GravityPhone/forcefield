-- Talk mode lets a canvasser change their mind about a just-logged outcome
-- (tap a different button to switch it, tap the same one again to undo).
-- That requires canvassers to update/delete their OWN knock_logs rows —
-- previously insert-only. Scoped to canvasser_id = auth.uid(); admins
-- already had full update/delete via the existing admin-only policies,
-- which stay in place alongside these.
create policy "canvassers update their own knock logs"
  on public.knock_logs for update to authenticated
  using (canvasser_id = auth.uid())
  with check (canvasser_id = auth.uid());

create policy "canvassers delete their own knock logs"
  on public.knock_logs for delete to authenticated
  using (canvasser_id = auth.uid());
