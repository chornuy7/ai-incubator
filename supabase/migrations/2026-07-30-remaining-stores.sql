-- §10.2 «Всё из БД, не из кода»: последние сторы, которые ещё жили в JSON-файлах.
--
-- Аудит 30.07: адаптер Supabase закрывал balance/prices/bundles/apiKeys/users/roles/
-- tokenLedger/goals/campaigns/leads/accounts_meta, но девять сторов остались файловыми.
-- Правило со звонка 27.07 — «внутри самого кода этого вообще быть не должно», и хранение
-- в файлах рядом с процессом это ровно то же: на нескольких инстансах данные разъедутся,
-- а при переезде на хостинг просто исчезнут.
--
-- Что переносим и почему именно так:
--   • channels — результаты парсера (71 запись). Заказчик прямо просил «результаты
--     парсера / найденные аккаунты → в Supabase». Ключевые поля колонками (по ним ищут
--     и сортируют), остальное — в data jsonb, как уже сделано для goals/campaigns;
--   • account_groups — используются в RBAC (доступ по группам аккаунтов), потерять нельзя;
--   • account_activity — усталость и отдых, влияет на поведение модулей;
--   • campaign_schedules, agents — сущности со своим жизненным циклом;
--   • app_settings — общий KV для мелких конфигов (общие настройки, настройки ИИ,
--     safety-лимиты, чёрный список). Плодить пять таблиц под пять объектов настроек
--     смысла нет: у них нет отношений, только «ключ → значение».
--
-- Как применить: Supabase → SQL Editor → выполнить этот файл.

-- ── Каналы (результаты парсера) ──────────────────────────────────────────────
create table if not exists channels (
  id            text primary key,
  title         text not null default '',
  username      text not null default '',
  link          text not null default '',
  subscribers   integer not null default 0,
  has_comments  boolean not null default false,
  tg_peer_id    text not null default '',
  rating        numeric(6,2),
  data          jsonb not null default '{}',   -- категории, язык, ER, статистика, sources
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

-- Ищут по username/названию, сортируют по подписчикам и рейтингу.
create index if not exists channels_username_idx    on channels(lower(username));
create index if not exists channels_subscribers_idx on channels(subscribers desc);
create index if not exists channels_rating_idx      on channels(rating desc nulls last);

comment on table channels is 'База каналов (результаты парсера). Ключевые поля — колонками, остальное в data.';

-- ── Группы аккаунтов (RBAC) ──────────────────────────────────────────────────
create table if not exists account_groups (
  id          text primary key,
  name        text not null default '',
  account_ids jsonb not null default '[]',
  color       text not null default '',
  note        text not null default '',
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

comment on table account_groups is 'Группы аккаунтов. На них выдаются права в ролях — терять нельзя.';

-- ── Усталость аккаунтов ──────────────────────────────────────────────────────
create table if not exists account_activity (
  account_id    text primary key,
  fatigue       numeric(10,2) not null default 0,
  rest_until    bigint not null default 0,
  last_action_at bigint not null default 0,
  actions_total integer not null default 0,
  data          jsonb not null default '{}',   -- profile: threshold/recovery/restMinutes
  updated_at    timestamptz not null default now()
);

comment on table account_activity is 'Усталость и отдых аккаунтов — общие для всех модулей.';

-- ── Расписания кампаний ──────────────────────────────────────────────────────
create table if not exists campaign_schedules (
  id         text primary key,
  name       text not null default '',
  data       jsonb not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ── Агенты ───────────────────────────────────────────────────────────────────
create table if not exists agents (
  id         text primary key,
  name       text not null default '',
  data       jsonb not null default '{}',
  user_id    text references users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists agents_user_id_idx on agents(user_id);

-- ── Общий KV для настроек ────────────────────────────────────────────────────
-- key: 'settings' | 'ai-settings' | 'ai-safety' | 'target-blacklist'
create table if not exists app_settings (
  key        text primary key,
  value      jsonb not null default '{}',
  updated_at timestamptz not null default now()
);

comment on table app_settings is
  'Мелкие конфиги одним KV: общие настройки, настройки ИИ, safety-лимиты, чёрный список.';
