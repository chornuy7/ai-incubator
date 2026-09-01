-- MR-290, шаг 9: мета аккаунта — колонками, а не одной jsonb-свалкой.
--
-- В `accounts_meta.data` лежало 39 ключей, и семь из них ДУБЛИРОВАЛИ типизированные
-- колонки той же таблицы (name, username, phone, status, country, inTrash, proxy).
-- Причём читался только jsonb: `loadAllMeta` делает `select id, data`, а колонки
-- заполнялись «для запросов» и не читались никем. То есть типы стояли, но не работали:
-- статус мог быть каким угодно, дата — числом, строкой или отсутствовать.
--
-- Что это стоило на практике:
--   • `data.userId` (id аккаунта в Telegram) хранился ТО ЧИСЛОМ, ТО СТРОКОЙ — это видно
--     прямо в боевых данных. Числа за пределами безопасного диапазона JS теряют точность
--     молча, а Telegram-id к этому диапазону уже подбирается;
--   • все девять моментов времени (statusSince, statusUntil, healthCheckedAt, spamblockAt
--     и прочие) лежали числом epoch-ms внутри json: ни сравнить в запросе, ни построить
--     индекс, ни увидеть в Table Editor человеческую дату;
--   • `data.ownerId` дублировал колонку `user_id` — два поля про одно и то же, и ничто
--     не мешало им разойтись;
--   • у таблицы не было `created_at` вовсе: дата создания жила только внутри json.
--
-- Здесь заводятся 25 колонок и наполняются из jsonb. Ключи `fingerprint` (снимок
-- устройства — набор полей свой у каждого аккаунта) и прокси-поля остаются в `data`:
-- первое осознанно, второе — территория MR-262, чтобы не сделать одно и то же дважды
-- по-разному.
--
-- ⚠️ ДУБЛИ ИЗ `data` ЗДЕСЬ НЕ УДАЛЯЮТСЯ. Миграции применяются до выката кода, и в
-- промежутке работает предыдущая версия, которая читает именно json. Код после выката
-- пишет и колонки, и (временно) те же ключи в json — снимем это одной строкой следующим
-- релизом, вместе с очисткой `data`.

alter table accounts_meta
  add column if not exists created_at        timestamptz,
  add column if not exists tg_user_id        text,
  add column if not exists role              text,
  add column if not exists project           text,
  add column if not exists note              text,
  add column if not exists avatar_color      text,
  add column if not exists is_service        boolean not null default false,
  add column if not exists is_platform       boolean not null default false,
  add column if not exists status_since      timestamptz,
  add column if not exists status_until      timestamptz,
  add column if not exists status_reason     text,
  add column if not exists status_code       text,
  add column if not exists status_by         text,
  add column if not exists prev_status       text,
  add column if not exists status_before     text,
  add column if not exists health_checked_at timestamptz,
  add column if not exists health_error      text,
  add column if not exists last_valid        boolean,
  add column if not exists last_valid_at     timestamptz,
  add column if not exists last_checked_at   timestamptz,
  add column if not exists last_check_ok     boolean,
  add column if not exists spamblock         text,
  add column if not exists spamblock_at      timestamptz,
  add column if not exists spamblock_text    text,
  add column if not exists ggr_score         numeric;

comment on column accounts_meta.tg_user_id is
  'Идентификатор аккаунта в Telegram. Текстом намеренно: в json он лежал то числом, то строкой, а числа такой величины JS уже теряет в точности.';
comment on column accounts_meta.is_service is
  'Служебный аккаунт платформы: им идёт ревизия общей базы каналов. Не роль — от этого флага зависит, чьи аккаунты и чьи деньги тратятся.';
comment on column accounts_meta.is_platform is
  'Аккаунт ПЛАТФОРМЫ, а не клиента. Ставится только администратором при импорте; исполнителей ревизии берут только отсюда.';
comment on column accounts_meta.status_until is
  'До какого момента держится временный статус (флудвейт, карантин, спамблок). Раньше — epoch-ms внутри json, из-за чего «у кого истекло» нельзя было спросить запросом.';

-- ─────────────────────────────────────────────────────────────
-- Наполнение из jsonb
-- ─────────────────────────────────────────────────────────────
-- Время в json — epoch в миллисекундах. `nullif(...,'')` нужен, потому что пустая строка
-- в json встречается наравне с отсутствием ключа, а `to_timestamp('')` падает.
update accounts_meta set
  created_at        = coalesce(created_at,        to_timestamp((nullif(data->>'createdAt',''))::bigint        / 1000.0)),
  tg_user_id        = coalesce(tg_user_id,        nullif(data->>'userId','')),
  role              = coalesce(role,              nullif(data->>'role','')),
  project           = coalesce(project,           nullif(data->>'project','')),
  note              = coalesce(note,              nullif(data->>'note','')),
  avatar_color      = coalesce(avatar_color,      nullif(data->>'avatarColor','')),
  is_service        = coalesce((data->>'service')::boolean,  is_service),
  is_platform       = coalesce((data->>'platform')::boolean, is_platform),
  status_since      = coalesce(status_since,      to_timestamp((nullif(data->>'statusSince',''))::bigint      / 1000.0)),
  status_until      = coalesce(status_until,      to_timestamp((nullif(data->>'statusUntil',''))::bigint      / 1000.0)),
  status_reason     = coalesce(status_reason,     nullif(data->>'statusReason','')),
  status_code       = coalesce(status_code,       nullif(data->>'statusCode','')),
  status_by         = coalesce(status_by,         nullif(data->>'statusBy','')),
  prev_status       = coalesce(prev_status,       nullif(data->>'prevStatus','')),
  status_before     = coalesce(status_before,     nullif(data->>'statusBefore','')),
  health_checked_at = coalesce(health_checked_at, to_timestamp((nullif(data->>'healthCheckedAt',''))::bigint  / 1000.0)),
  health_error      = coalesce(health_error,      nullif(data->>'healthError','')),
  last_valid        = coalesce(last_valid,        (data->>'lastValid')::boolean),
  last_valid_at     = coalesce(last_valid_at,     to_timestamp((nullif(data->>'lastValidAt',''))::bigint      / 1000.0)),
  last_checked_at   = coalesce(last_checked_at,   to_timestamp((nullif(data->>'lastCheckedAt',''))::bigint    / 1000.0)),
  last_check_ok     = coalesce(last_check_ok,     (data->>'lastCheckOk')::boolean),
  spamblock         = coalesce(spamblock,         nullif(data->>'spamblock','')),
  spamblock_at      = coalesce(spamblock_at,      to_timestamp((nullif(data->>'spamblockAt',''))::bigint      / 1000.0)),
  spamblock_text    = coalesce(spamblock_text,    nullif(data->>'spamblockText','')),
  ggr_score         = coalesce(ggr_score,         (nullif(data->>'ggrScore',''))::numeric);

-- Дата создания есть не у всех (часть аккаунтов заведена до того, как её начали писать).
-- Подставляем дату последнего изменения: она заведомо не раньше создания, а NULL в
-- «когда появился» мешает сортировке списка.
update accounts_meta set created_at = updated_at where created_at is null;
alter table accounts_meta alter column created_at set default now();

-- ─────────────────────────────────────────────────────────────
-- Владелец аккаунта: из json — в колонку, у которой уже есть внешний ключ
-- ─────────────────────────────────────────────────────────────
-- Самый показательный случай во всей задаче. Колонка `user_id` со ссылкой на профиль
-- (accounts_meta_user_profile_fkey) существует с июля — и ПУСТА на всех 63 строках.
-- Владелец всё это время живёт в `data.ownerId`, и по нему же режется доступ:
-- accountBelongsTo в tgAccounts.js сравнивает строки из json.
--
-- То есть связь была объявлена, но не использовалась ни разу: база не могла проверить,
-- что владелец существует, а «покажи аккаунты этого человека» означало вычитать все
-- строки и разобрать json. Заполняем колонку — и ключ наконец начинает работать.
--
-- Все 42 владельца в json указывают на существующие профили (проверено), поэтому перенос
-- проходит целиком и внешний ключ ничего не отвергает.
update accounts_meta
   set user_id = nullif(data->>'ownerId','')
 where user_id is null
   and nullif(data->>'ownerId','') is not null;

comment on column accounts_meta.user_id is
  'Владелец аккаунта — профиль оператора. С MR-290 колонка наконец заполняется: до этого владелец жил в data.ownerId, и внешний ключ рядом не проверял ничего.';

-- ─────────────────────────────────────────────────────────────
-- Индексы под запросы, ради которых колонки и заводились
-- ─────────────────────────────────────────────────────────────
-- Админка «проблемы» ищет по статусу, автоматика — по истёкшему временному статусу,
-- ревизия общей базы каналов — по служебным аккаунтам платформы. Раньше каждый такой
-- вопрос означал вычитать все строки и разобрать json в памяти.
create index if not exists accounts_meta_status_idx  on accounts_meta (status);
create index if not exists accounts_meta_until_idx   on accounts_meta (status_until) where status_until is not null;
create index if not exists accounts_meta_service_idx on accounts_meta (is_service) where is_service;
create index if not exists accounts_meta_tg_user_idx on accounts_meta (tg_user_id);
