-- Run once in the Supabase SQL Editor.
-- Existing history rows remain valid; their splits value will be an empty JSON array in the app.
alter table public.runpulse_history
  add column if not exists splits jsonb not null default '[]'::jsonb;
