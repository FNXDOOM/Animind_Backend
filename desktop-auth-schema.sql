-- Durable desktop auth sessions for backend-issued access/refresh tokens
create extension if not exists pgcrypto;

create table if not exists public.desktop_auth_sessions (
  id uuid primary key default gen_random_uuid(),
  user_id text not null,
  session_id text not null unique,
  device_id text,
  device_name text,
  refresh_token_hash text not null unique,
  refresh_token_expires_at timestamptz not null,
  access_token_hash text not null unique,
  access_token_expires_at timestamptz not null,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_desktop_auth_user_id on public.desktop_auth_sessions(user_id);
create index if not exists idx_desktop_auth_refresh_hash on public.desktop_auth_sessions(refresh_token_hash);
create index if not exists idx_desktop_auth_access_hash on public.desktop_auth_sessions(access_token_hash);
create index if not exists idx_desktop_auth_refresh_exp on public.desktop_auth_sessions(refresh_token_expires_at);
create index if not exists idx_desktop_auth_access_exp on public.desktop_auth_sessions(access_token_expires_at);

-- Periodic cleanup is handled by the backend cron job:
-- DESKTOP_AUTH_CLEANUP_ENABLED=true
-- DESKTOP_AUTH_CLEANUP_CRON=30 2 * * *
-- DESKTOP_AUTH_EXPIRED_RETENTION_DAYS=7
