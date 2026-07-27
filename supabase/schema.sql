-- Murmex — схема БД для Supabase (Postgres). §10.2
--
-- Как применить: Supabase → SQL Editor → New query → вставить этот файл → Run.
-- Идемпотентно (IF NOT EXISTS), можно прогонять повторно.
--
-- RLS включён на всех таблицах: анонимный/публичный доступ закрыт по умолчанию.
-- Бэкенд Murmex ходит с ключом service_role (обходит RLS) — как и задумано:
-- вся бизнес-логика доступа (роли §8.1, подписки §5.4) уже в Node-слое. Позже,
-- если понадобится прямой доступ фронта к таблицам, добавим точечные policy.

-- ─────────────────────────────────────────────────────────────
-- ПОЛЬЗОВАТЕЛИ И РОЛИ
-- ─────────────────────────────────────────────────────────────

create table if not exists roles (
  id          text primary key,           -- role_admin, role_moderator, …
  name        text not null,
  permissions jsonb not null default '{}', -- §8.1: modules/blocks/sections/resources
  builtin     boolean not null default false,
  created_at  timestamptz not null default now()
);

create table if not exists users (
  id            text primary key,          -- usr_…
  email         text unique not null,
  name          text not null default '',
  password_hash text,                       -- наш формат salt:hash; при переходе на Supabase Auth — убрать
  role_ids      text[] not null default '{}',
  active        boolean not null default true,
  -- Вложенные юзеры (§10.4): под каким админом-клиентом заведён.
  parent_id     text references users(id) on delete set null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index if not exists users_parent_idx on users(parent_id);

-- ─────────────────────────────────────────────────────────────
-- БАЛАНС, ПОДПИСКИ, ЦЕНЫ (§5.4 / §10.1 / §10.4)
-- ─────────────────────────────────────────────────────────────

-- Монеты у каждого свои (кошелёк на человека).
create table if not exists coin_balance (
  user_id    text primary key references users(id) on delete cascade,
  coins      numeric(14,3) not null default 0,
  updated_at timestamptz not null default now()
);

-- Подписка на модули. scope='user' — личная (перекрывает общую), 'workspace' — общая.
-- modules: 'all' (json "all") или массив ключей.
create table if not exists subscriptions (
  scope       text not null,               -- 'user' | 'workspace'
  user_id     text references users(id) on delete cascade, -- null для workspace
  modules     jsonb not null default '"all"',
  expires_at  timestamptz,                 -- null = бессрочно (демо)
  updated_at  timestamptz not null default now(),
  primary key (scope, user_id)
);

-- Переопределения цен из админки (§10.4): пусто = коды-дефолты в pricing.js.
-- Одна строка на всё пространство (id='default').
create table if not exists price_overrides (
  id                 text primary key default 'default',
  modules            jsonb not null default '{}', -- { key: { month?, action? } }
  annual_discount    numeric,
  coins_per_1k_tokens numeric,
  token_usd          numeric,               -- §10.1: цена токена в $ (ждёт Николая)
  image_multiplier   numeric,               -- §10.5: картинка дороже текста, ×N
  coin_packs         jsonb,                 -- [{coins, price, best}]
  updated_at         timestamptz not null default now()
);

-- Наборы модулей, собранные админом под клиента (§10.4).
create table if not exists bundles (
  id         text primary key,             -- bun_…
  name       text not null,
  hint       text not null default '',
  modules    text[] not null default '{}',
  price      numeric(12,2) not null,
  created_at timestamptz not null default now()
);

-- ─────────────────────────────────────────────────────────────
-- ЖУРНАЛЫ ДЕНЕГ (append-only) (§5.1 / §5.3)
-- ─────────────────────────────────────────────────────────────

-- Операции по кошельку — «за что списали».
create table if not exists wallet_log (
  id         bigint generated always as identity primary key,
  ts         timestamptz not null default now(),
  user_id    text,
  amount     numeric(14,3) not null,        -- +пополнение / −списание
  before_val numeric(14,3),
  after_val  numeric(14,3),
  reason     text
);
create index if not exists wallet_log_user_idx on wallet_log(user_id, ts desc);

-- Расход токенов ИИ.
create table if not exists token_ledger (
  id                bigint generated always as identity primary key,
  ts                timestamptz not null default now(),
  user_id           text,
  module            text,
  account_id        text,
  task_id           text,
  campaign_id       text,
  model             text,
  tokens            integer not null default 0,
  prompt_tokens     integer not null default 0,
  completion_tokens integer not null default 0,
  coins             numeric(14,3) not null default 0
);
create index if not exists token_ledger_ts_idx on token_ledger(ts desc);
create index if not exists token_ledger_module_idx on token_ledger(module, ts desc);

-- ─────────────────────────────────────────────────────────────
-- API-КЛЮЧИ «МОЗГОВ» (§10.3)
-- ─────────────────────────────────────────────────────────────

create table if not exists api_keys (
  id           text primary key,            -- key_…
  name         text not null,
  key_hash     text not null,               -- ХЭШ значения (не само значение)
  prefix       text not null,               -- для узнавания в списке
  owner_id     text references users(id) on delete set null,
  created_at   timestamptz not null default now(),
  last_used_at timestamptz,
  revoked      boolean not null default false
);

-- ─────────────────────────────────────────────────────────────
-- ЯДРО: ЦЕЛИ → КАМПАНИИ → ЛИДЫ, АККАУНТЫ (§9)
-- ─────────────────────────────────────────────────────────────

create table if not exists goals (
  id         text primary key,
  name       text not null,
  data       jsonb not null default '{}',   -- метрика/цель/срок и пр. (гибко на переходный период)
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists campaigns (
  id         text primary key,
  name       text not null,
  goal_id    text references goals(id) on delete set null,
  modules    text[] not null default '{}',
  data       jsonb not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists leads (
  id         text primary key,
  goal_id    text references goals(id) on delete set null,
  account_id text,
  peer       text,
  status     text not null default 'cold',
  is_hot     boolean not null default false,
  result     text default '',
  note       text default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists leads_status_idx on leads(status);

-- Метаданные Telegram-аккаунтов (боты). Сессии/файлы — в Storage, не тут.
create table if not exists accounts_meta (
  id          text primary key,            -- acc_…
  name        text,
  username    text,
  phone       text,
  status      text,
  proxy       text,
  country     text,
  in_trash    boolean not null default false,
  data        jsonb not null default '{}',
  updated_at  timestamptz not null default now()
);

-- Результаты парсеров (§10.2: собранные аккаунты/каналы → в БД).
create table if not exists parsed_channels (
  id          bigint generated always as identity primary key,
  task_id     text,
  username    text,
  title       text,
  members     integer,
  kind        text,
  link        text,
  data        jsonb not null default '{}',
  created_at  timestamptz not null default now()
);
create index if not exists parsed_channels_task_idx on parsed_channels(task_id);

-- ─────────────────────────────────────────────────────────────
-- RLS: включаем на всех таблицах (доступ — только service_role из бэкенда)
-- ─────────────────────────────────────────────────────────────
do $$
declare t text;
begin
  foreach t in array array[
    'roles','users','coin_balance','subscriptions','price_overrides','bundles',
    'wallet_log','token_ledger','api_keys','goals','campaigns','leads',
    'accounts_meta','parsed_channels'
  ] loop
    execute format('alter table %I enable row level security', t);
  end loop;
end $$;

-- Готово. Дальше: скрипт миграции JSON → эти таблицы (server-side) + переключение
-- сторов на Supabase через переменную окружения. Заводские цены остаются в коде
-- как дефолты; price_overrides перекрывает — та же модель, что и с prices.json.
