-- New role tier: campaign_manager sits between admin and team_lead (shown in
-- the UI as "Campaign Manager"; team_lead displays as "Squad Leader").
-- Hierarchy: admin > campaign_manager > team_lead (squad leader) > canvasser.
--
-- Deliberately the ONLY statement in this migration: a value added to an enum
-- can't be referenced in the same transaction that added it, and each
-- migration is applied as one transaction — everything that uses the new
-- value lives in the next migration file.
alter type public.app_role add value if not exists 'campaign_manager' before 'admin';
