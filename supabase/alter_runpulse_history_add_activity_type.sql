-- Supabase SQL Editorで一度だけ実行してください。
-- 既存の記録は running として扱い、新しい記録は running / walking を保存します。
alter table public.runpulse_history
  add column if not exists activity_type text not null default 'running';

alter table public.runpulse_history
  drop constraint if exists runpulse_history_activity_type_check;

alter table public.runpulse_history
  add constraint runpulse_history_activity_type_check
  check (activity_type in ('running', 'walking'));