create extension if not exists pgcrypto;

create table if not exists public.accounts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  type text not null check (type in ('bank','broker','cash')),
  currency char(3) not null default 'EUR',
  opening_balance numeric(14,2) not null default 0,
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);

create index if not exists accounts_user_active_idx on public.accounts(user_id, is_active);

create table if not exists public.cash_transactions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  account_id uuid not null references public.accounts(id) on delete restrict,
  type text not null check (type in ('income','expense','transfer')),
  amount numeric(14,2) not null check (amount >= 0),
  occurred_on date not null,
  category text,
  description text,
  created_at timestamptz not null default now()
);

create table if not exists public.assets (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  ticker text,
  isin text,
  name text not null,
  currency char(3) not null default 'EUR',
  created_at timestamptz not null default now(),
  unique(user_id, isin)
);

create table if not exists public.investment_transactions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  account_id uuid references public.accounts(id) on delete restrict,
  asset_id uuid not null references public.assets(id) on delete cascade,
  external_hash text not null,
  operation text not null check (operation in ('buy','sell','dividend','fee','tax','cash')),
  traded_on date not null,
  quantity numeric(18,8) not null default 0,
  price numeric(18,8),
  amount numeric(14,2),
  description text,
  source text not null default 'degiro',
  created_at timestamptz not null default now(),
  unique(user_id, external_hash),
  check (quantity >= 0),
  check (price is null or price >= 0)
);

create table if not exists public.portfolio_quotes (
  asset_id uuid primary key references public.assets(id) on delete cascade,
  ticker text not null,
  price numeric(18,8) not null,
  currency char(3),
  quoted_at timestamptz not null default now(),
  is_stale boolean not null default false
);

alter table public.accounts enable row level security;
alter table public.cash_transactions enable row level security;
alter table public.assets enable row level security;
alter table public.investment_transactions enable row level security;
alter table public.portfolio_quotes enable row level security;

create policy "Users manage own accounts" on public.accounts for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "Users view own accounts" on public.accounts for select using (auth.uid() = user_id);
create policy "Users manage own cash transactions" on public.cash_transactions for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "Users view own cash transactions" on public.cash_transactions for select using (auth.uid() = user_id);
create policy "Users manage own assets" on public.assets for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "Users manage own investments" on public.investment_transactions for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "Users manage own quotes" on public.portfolio_quotes for all using (exists (select 1 from public.assets a where a.id = asset_id and a.user_id = auth.uid())) with check (exists (select 1 from public.assets a where a.id = asset_id and a.user_id = auth.uid()));

create index if not exists cash_transactions_user_date_idx on public.cash_transactions(user_id, occurred_on desc);
create index if not exists investment_transactions_user_asset_idx on public.investment_transactions(user_id, asset_id, traded_on);
create index if not exists portfolio_quotes_ticker_idx on public.portfolio_quotes(ticker);

create or replace function public.prevent_account_hard_delete()
returns trigger language plpgsql as $$
begin
  if exists (select 1 from public.cash_transactions where account_id = old.id)
     or exists (select 1 from public.investment_transactions where account_id = old.id) then
    raise exception 'Conta com transações não pode ser apagada; marque is_active=false.';
  end if;
  return old;
end;
$$;

drop trigger if exists prevent_account_delete on public.accounts;
create trigger prevent_account_delete before delete on public.accounts for each row execute function public.prevent_account_hard_delete();

create or replace view public.account_balances as
select a.*, a.opening_balance + coalesce(sum(case when t.type = 'income' then t.amount when t.type = 'expense' then -t.amount else 0 end), 0) as current_balance
from public.accounts a left join public.cash_transactions t on t.account_id = a.id group by a.id;
