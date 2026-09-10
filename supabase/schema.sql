-- RunPulse Supabase schema

create extension if not exists pgcrypto;

create table if not exists public.runpulse_profiles (
  user_id uuid primary key references auth.users (id) on delete cascade,
  settings jsonb not null default '{
    "goalPace": "5:00",
    "unit": "km",
    "audioOn": true,
    "brightness": "standard"
  }'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.runpulse_history (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  date text not null,
  activity_type text not null default 'running' check (activity_type in ('running', 'walking')),
  distance text not null,
  time text not null,
  pace text not null,
  created_at timestamptz not null default now()
);

alter table public.runpulse_profiles enable row level security;
alter table public.runpulse_history enable row level security;

create policy "Profiles are viewable by the owner"
  on public.runpulse_profiles
  for select
  using (auth.uid() = user_id);

create policy "Profiles can be created by the owner"
  on public.runpulse_profiles
  for insert
  with check (auth.uid() = user_id);

create policy "Profiles can be updated by the owner"
  on public.runpulse_profiles
  for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create policy "History is viewable by the owner"
  on public.runpulse_history
  for select
  using (auth.uid() = user_id);

create policy "History can be created by the owner"
  on public.runpulse_history
  for insert
  with check (auth.uid() = user_id);

create policy "History can be updated by the owner"
  on public.runpulse_history
  for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create policy "History can be deleted by the owner"
  on public.runpulse_history
  for delete
  using (auth.uid() = user_id);
