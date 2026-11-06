-- Run in Supabase: SQL Editor -> New query -> paste -> Run.

-- One portfolio blob per user (account, watchlist, settings).
create table if not exists public.portfolios (
  user_id uuid primary key references auth.users(id) on delete cascade,
  data jsonb not null,
  updated_at timestamptz not null default now()
);
alter table public.portfolios enable row level security;
create policy "own portfolio select" on public.portfolios for select using (auth.uid() = user_id);
create policy "own portfolio insert" on public.portfolios for insert with check (auth.uid() = user_id);
create policy "own portfolio update" on public.portfolios for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "own portfolio delete" on public.portfolios for delete using (auth.uid() = user_id);

-- Subscription state. Users can READ their plan; only the server (Stripe webhook,
-- using the service_role key) can write it, so it can't be self-upgraded.
create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  plan text not null default 'free',
  stripe_customer_id text,
  created_at timestamptz not null default now()
);
alter table public.profiles enable row level security;
create policy "own profile select" on public.profiles for select using (auth.uid() = id);

create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id) values (new.id) on conflict do nothing;
  return new;
end $$;
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();
