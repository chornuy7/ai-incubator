-- §11.3 (добивка): модули — ссылками, а не текстовыми ключами в jsonb.
--
-- Аудит 30.07 показал: справочник `modules` есть, но подписки, наборы, кампании и цены
-- ссылаются на модули СТРОКАМИ внутри jsonb. Это тот же приём, который заказчик
-- критиковал у типов: «ты всё делаешь ссылками, а не текстом».
--
-- Плюс `module_prices` заказчик прямо называл в списке ожидаемых таблиц ещё 27.07.
--
-- ВАЖНО про роль этих таблиц. Источник правды остаётся прежним (jsonb в subscriptions/
-- bundles/campaigns/price_overrides) — переписывать на них биллинг и подписки значит
-- рисковать деньгами клиентов ради формы хранения. Здесь — НОРМАЛЬНАЯ ПРОЕКЦИЯ: связи
-- видны и читаемы в БД, пересобираются автоматически при каждом изменении (как уже
-- сделано для user_type_modules). Переключать источник правды — отдельная работа с
-- тестами, а не побочный эффект миграции.
--
-- Как применить: Supabase → SQL Editor → выполнить этот файл.

-- ── Цены модулей отдельной таблицей ──────────────────────────────────────────
-- Две цены на модуль, как на созвоне 27.07: доступ ($/мес) и действие (токены).
create table if not exists module_prices (
  module_id    bigint primary key references modules(id) on delete cascade,
  month_price  numeric(12,2) not null default 0,   -- подписка, $/мес
  action_price numeric(12,4) not null default 0,   -- цена одного действия, токены
  updated_at   timestamptz not null default now()
);

comment on table module_prices is
  '§11.3: цены модулей ссылкой на modules. Проекция price_overrides — источник правды там.';

-- ── Что входит в подписку ────────────────────────────────────────────────────
-- `subscriptions.modules` бывает и списком ключей, и строкой 'all'. Случай «все модули»
-- в связях не выражается, поэтому он остаётся флагом в исходной таблице, а сюда
-- попадают только явно перечисленные модули.
create table if not exists subscription_modules (
  subscription_id text   not null references subscriptions(id) on delete cascade,
  module_id       bigint not null references modules(id) on delete cascade,
  primary key (subscription_id, module_id)
);

-- ── Что входит в готовый набор ───────────────────────────────────────────────
create table if not exists bundle_modules (
  bundle_id text   not null references bundles(id) on delete cascade,
  module_id bigint not null references modules(id) on delete cascade,
  primary key (bundle_id, module_id)
);

-- ── Какие модули поднимает кампания ──────────────────────────────────────────
create table if not exists campaign_modules (
  campaign_id text   not null references campaigns(id) on delete cascade,
  module_id   bigint not null references modules(id) on delete cascade,
  primary key (campaign_id, module_id)
);

comment on table subscription_modules is '§11.3: модули подписки ссылками (проекция subscriptions.modules).';
comment on table bundle_modules       is '§11.3: модули набора ссылками (проекция bundles.modules).';
comment on table campaign_modules     is '§11.3: модули кампании ссылками (проекция campaigns.modules).';
