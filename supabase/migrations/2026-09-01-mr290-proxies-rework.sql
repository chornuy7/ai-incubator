-- MR-290 (вбирает MR-262), шаг 11: прокси — таблица со связями, а не список рядом.
--
-- ─── ЧТО БЫЛО НАЙДЕНО ───
--
-- Таблица `proxies` появилась на боевой базе 01.09 миграцией `2026-09-01-mr262-proxies.sql`
-- и залита данными (101 строка). При этом:
--   • файла этой миграции НЕТ НИ В ОДНОЙ ВЕТКЕ репозитория — схема существует только на
--     проде, и собрать окружение с нуля по-прежнему нельзя;
--   • кода, который бы ею пользовался, тоже нет: `server/proxies.js` читает и пишет
--     `server/data/proxies.json`, как и раньше.
--
-- И главное. Связь аккаунта с прокси на боевой базе СЕЙЧАС НЕ РАБОТАЕТ:
--
--   · `data.proxyId` заполнен у 55 аккаунтов и указывает на существующие строки `proxies`;
--   · колонка `accounts_meta.proxy` (URL, по которому и происходит подключение) пуста —
--     три строки со значением «—», то есть «без прокси», и больше ничего;
--   · ни одна строка кода не превращает `proxyId` в URL: `createClient(session, meta.proxy)`
--     получает пустое значение, `parseProxy` возвращает null.
--
-- То есть 55 аккаунтов, которым прокси НАЗНАЧЕН, ходят в Telegram напрямую с адреса
-- сервера. В интерфейсе назначение видно, в работе его нет. Это ровно та потерянная
-- связь, которую нужно восстановить, и восстанавливать её строкой-URL нельзя — она уже
-- один раз потерялась именно потому, что была строкой.
--
-- ─── ЧТО ДЕЛАЕТСЯ ───
--
-- 1. Определение `proxies` попадает в репозиторий целиком (`create table if not exists`),
--    чтобы чистое окружение собиралось. На проде таблица уже есть — создание пропускается,
--    применяются только доработки ниже.
-- 2. Тип связи: `accounts_meta.proxy_id` с внешним ключом. URL больше не хранится вовсе —
--    он собирается из строки прокси в момент подключения. Хранить и ссылку, и собранную
--    из неё строку значит завести два источника, которые разойдутся при первой же смене
--    пароля прокси (именно так и вышло).
-- 3. Пароль прокси переезжает в шифрованную колонку — сейчас все 101 лежат открытым
--    текстом. Механизм тот же, что у облачных паролей и сессий.
-- 4. Типы приводятся к принятым в остальной базе: время — timestamptz, наборы значений —
--    ограничениями (виды, схемы, статусы у прокси перечислены в коде и до сих пор ничем
--    не проверялись).

-- ─────────────────────────────────────────────────────────────
-- 1. Таблица целиком — для чистого окружения
-- ─────────────────────────────────────────────────────────────
create table if not exists proxies (
  id            text primary key,
  label         text not null default '',
  kind          text not null default 'static',
  scheme        text not null default 'socks5',
  host          text not null,
  port          integer not null,
  username      text,
  password      text,           -- УСТАРЕЛО: переезжает в password_enc, снимается следующим релизом
  password_enc  text,
  country       text,
  geo_source    text,
  rotate_url    text,
  status        text not null default 'unknown',
  reason        text,
  note          text,
  user_id       text,
  last_check_at timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

-- ─────────────────────────────────────────────────────────────
-- 2. Доработки для боевой, где таблица уже создана прежней миграцией
-- ─────────────────────────────────────────────────────────────
alter table proxies add column if not exists password_enc text;

-- Время: на проде три колонки заведены как bigint (epoch-мс) — та же болезнь, что и в
-- остальной базе. Приводим к timestamptz. Проверка типа нужна, чтобы миграция была
-- идемпотентной: на чистой базе колонки уже правильные, и `using to_timestamp(...)`
-- по timestamptz упал бы.
do $$
declare c record;
begin
  for c in select column_name from information_schema.columns
            where table_schema = 'public' and table_name = 'proxies'
              and column_name in ('last_check_at', 'created_at', 'updated_at')
              and data_type = 'bigint'
  loop
    execute format(
      'alter table proxies alter column %I type timestamptz using case when %I is null or %I = 0 then null else to_timestamp(%I / 1000.0) end',
      c.column_name, c.column_name, c.column_name, c.column_name);
  end loop;
end $$;

update proxies set created_at = coalesce(created_at, now()), updated_at = coalesce(updated_at, now());
alter table proxies alter column created_at set not null;
alter table proxies alter column updated_at set not null;
alter table proxies alter column created_at set default now();
alter table proxies alter column updated_at set default now();
alter table proxies alter column label set default '';
update proxies set label = coalesce(label, '');
alter table proxies alter column label set not null;

-- ─────────────────────────────────────────────────────────────
-- 3. Наборы значений — ограничениями, а не только в коде
-- ─────────────────────────────────────────────────────────────
-- Виды, схемы и статусы перечислены в server/proxies.js (PROXY_KINDS, PROXY_SCHEMES,
-- PROXY_STATUSES) и до сих пор ничем не проверялись: опечатка в статусе означала прокси,
-- который не попадает ни в один фильтр и потому не выдаётся никому — молча.
-- Проверено на боевой: все 101 строка укладывается в эти наборы.
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'proxies_kind_chk') then
    alter table proxies add constraint proxies_kind_chk check (kind in ('static', 'mobile', 'farm'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'proxies_scheme_chk') then
    alter table proxies add constraint proxies_scheme_chk check (scheme in ('socks5', 'http'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'proxies_status_chk') then
    alter table proxies add constraint proxies_status_chk check (status in ('ok', 'bad', 'dead', 'unknown'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'proxies_geo_chk') then
    alter table proxies add constraint proxies_geo_chk check (geo_source is null or geo_source in ('exit', 'gateway'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'proxies_port_chk') then
    alter table proxies add constraint proxies_port_chk check (port between 1 and 65535);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'proxies_owner_fkey') then
    alter table proxies add constraint proxies_owner_fkey
      foreign key (user_id) references profiles(legacy_id) on update cascade on delete set null;
  end if;
end $$;

create index if not exists proxies_user_idx   on proxies (user_id);
create index if not exists proxies_status_idx on proxies (status);

-- Уникальность точки входа: прежний индекс включал ПАРОЛЬ, поэтому смена пароля у того же
-- host:port:login заводила ВТОРУЮ строку — то есть дубль прокси, который выглядит как
-- новый и которому можно выдать те же аккаунты. Пароль из ключа убираем: точку входа
-- определяют адрес, порт и логин. Проверено — дублей по этой тройке нет.
drop index if exists proxies_unique_endpoint;
create unique index if not exists proxies_unique_endpoint
  on proxies (host, port, coalesce(username, ''));

comment on table proxies is
  'Каталог прокси. Заведён MR-262, доработан MR-290: пароль шифруется, время в timestamptz, наборы значений ограничениями, владелец — внешним ключом.';
comment on column proxies.password is
  'УСТАРЕЛО (MR-290): пароль переезжает в password_enc. Колонка снимается следующим релизом, после прогона server/scripts/encrypt-proxy-passwords.mjs.';
comment on column proxies.password_enc is
  'СЕКРЕТ. Пароль прокси в шифрованном виде (конверт enc.v1.…, AES-256-GCM). Ключ — SECRETS_KEY в окружении, в базе его нет.';

-- ─────────────────────────────────────────────────────────────
-- 4. Связь аккаунта с прокси — внешним ключом
-- ─────────────────────────────────────────────────────────────
-- Здесь и восстанавливается потерянное. `data.proxyId` есть у 55 аккаунтов и весь
-- указывает на существующие прокси (проверено, битых нет), поэтому перенос проходит
-- целиком, а внешний ключ сразу начинает работать.
--
-- ON DELETE SET NULL: удалили прокси — аккаунт остаётся, но остаётся и БЕЗ прокси, и это
-- видно. Прежняя связь строкой при удалении прокси не менялась вовсе: аккаунт продолжал
-- ссылаться на несуществующий адрес.
alter table accounts_meta add column if not exists proxy_id text;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'accounts_meta_proxy_fkey') then
    alter table accounts_meta add constraint accounts_meta_proxy_fkey
      foreign key (proxy_id) references proxies(id) on delete set null;
  end if;
end $$;

create index if not exists accounts_meta_proxy_idx on accounts_meta (proxy_id);

update accounts_meta
   set proxy_id = nullif(data->>'proxyId','')
 where proxy_id is null
   and nullif(data->>'proxyId','') is not null;

comment on column accounts_meta.proxy_id is
  'Прокси аккаунта — ссылка на строку proxies. URL для подключения собирается из неё в момент коннекта и НЕ хранится: хранить и ссылку, и собранную строку значит завести два источника, которые разойдутся при первой смене пароля прокси.';
comment on column accounts_meta.proxy is
  'УСТАРЕЛО (MR-290): подключение идёт по proxy_id. Колонка снимается следующим релизом — её ещё читает код, работающий на сервере в момент накатки миграции.';
