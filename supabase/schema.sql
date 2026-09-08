-- ARIS · схема Supabase. Выполните целиком в SQL Editor проекта (бесплатный тариф).
-- Всё закрыто RLS: каждая строка и каждый файл принадлежат одному пользователю.

create extension if not exists pgcrypto;

/* ---------- профиль: настройки, память и подключения ---------- */
create table if not exists public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  account jsonb not null default '{}'::jsonb,
  providers jsonb not null default '[]'::jsonb,
  current_chat_id text,
  updated_at timestamptz not null default now()
);
alter table public.profiles enable row level security;

drop policy if exists "profiles are private" on public.profiles;
create policy "profiles are private" on public.profiles
  for all to authenticated
  using (auth.uid() = id)
  with check (auth.uid() = id);

/* ---------- история чатов ---------- */
create table if not exists public.chats (
  id text primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  title text not null default '',
  draft text not null default '',
  messages jsonb not null default '[]'::jsonb,
  updated_at timestamptz not null default now()
);
create index if not exists chats_user_updated_idx on public.chats (user_id, updated_at desc);
alter table public.chats enable row level security;

drop policy if exists "chats are private" on public.chats;
create policy "chats are private" on public.chats
  for all to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

/* Ограничение размера: один чат не больше ~1 МБ JSON, чтобы не выесть бесплатную базу. */
alter table public.chats drop constraint if exists chats_messages_size;
alter table public.chats add constraint chats_messages_size
  check (pg_column_size(messages) < 1048576);

/* ---------- вложения ---------- */
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('attachments', 'attachments', false, 8388608,
  array['image/png','image/jpeg','image/webp','image/gif','text/plain','text/markdown','text/csv','application/json'])
on conflict (id) do update
  set public = excluded.public,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- Путь к файлу: "<uid>/<uuid>". Первая папка = владелец, только он читает и пишет.
drop policy if exists "attachments are private" on storage.objects;
create policy "attachments are private" on storage.objects
  for all to authenticated
  using (bucket_id = 'attachments' and (storage.foldername(name))[1] = auth.uid()::text)
  with check (bucket_id = 'attachments' and (storage.foldername(name))[1] = auth.uid()::text);
