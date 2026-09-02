-- MR-290, шаг 14: список аккаунтов — один запрос вместо двухсот, и ни одного текста
-- там, где должен быть код.
--
-- ЗАЧЕМ. Страница «Менеджер аккаунтов» открывалась 20–24 секунды. Причина не в базе:
-- сервер обходил парк в цикле и на каждом аккаунте заново читал всю таблицу меты, весь
-- каталог прокси и отдельной строкой сессию — 254 запроса на одну страницу. Внешние ключи
-- для того и заведены (`accounts_meta.proxy_id → proxies.id`, `trust_cache.account_id`,
-- `account_sessions.account_id`), чтобы связанное приезжало ОДНИМ запросом.
--
-- ЧТО ЗДЕСЬ.
--
--   1. Представление `account_list` — готовая строка списка: аккаунт, его прокси, его
--      доверие, признак наличия сессии. Дедупликация (одна личность — одна строка)
--      делается тут же через DISTINCT ON, а не сборкой на стороне Node: постранично
--      дедуплицировать на клиенте нельзя в принципе — вторая страница не знает, кого
--      выкинула первая.
--
--   2. Функция `account_status_counts` — счётчики плиток над всем парком. Раньше ради
--      этих чисел фронт получал ВЕСЬ парк и считал длины массивов у себя.
--
--   3. Колонки `status_params`, `origin_code`, `origin_params` — коды вместо текстов.
--
-- ПРО ТЕКСТЫ В БАЗЕ. Сейчас в `accounts_meta` лежит:
--
--   note          = 'Импортирован из tdata'               — 47 строк
--   status_reason = 'Спамблок — аккаунт помечен…'          — 29 строк
--   status_reason = 'trust 74 > 70 — авто-возврат…'        — а status_code при этом NULL
--
-- `note` — поле ОПЕРАТОРА, его заметка. Система записала туда свою фразу и заняла чужое
-- место: оператор не отличает своё от служебного, а смена формулировки или перевод
-- интерфейса означали бы UPDATE по боевым данным. Происхождение аккаунта — это факт
-- (`IMPORT_TDATA`), а не предложение на русском.
--
-- То же со статусом: рядом с `status_code` жил `status_reason` с той же мыслью прописью,
-- причём у двух записей код пустой, а числа (74, 70) вплавлены в текст и никаким запросом
-- оттуда не достаются. Текст — дело интерфейса; база хранит код и параметры.
--
-- Старые колонки НЕ сносятся: миграции применяются до выката кода, и предыдущая версия
-- ещё читает `status_reason`. Снос — в supabase/next-release/.

begin;

-- ── 1. Коды вместо текстов ───────────────────────────────────────────────────────────

alter table public.accounts_meta
  add column if not exists status_params jsonb not null default '{}'::jsonb,
  add column if not exists origin_code   text,
  add column if not exists origin_params jsonb not null default '{}'::jsonb;

comment on column public.accounts_meta.status_params is
  'Числа и подробности к status_code: {"trust":74,"threshold":70}. Текст собирает интерфейс.';
comment on column public.accounts_meta.origin_code is
  'Откуда аккаунт взялся: IMPORT_TDATA, IMPORT_SESSION, MANUAL. Раньше лежало фразой в note.';
comment on column public.accounts_meta.note is
  'Заметка ОПЕРАТОРА и только его. Служебным сообщениям здесь не место — для них origin_code.';

-- Пустая строка кода — это отсутствие кода, а не код с пустым именем.
update public.accounts_meta set status_code = null where status_code = '';

-- Происхождение из заметки. Заметку при этом чистим: она снова принадлежит оператору.
update public.accounts_meta
   set origin_code = 'IMPORT_TDATA', note = ''
 where note = 'Импортирован из tdata';

-- «trust 74 > 70 — авто-возврат из прогрева»: числа достаём в параметры, текст выкидываем.
update public.accounts_meta
   set status_code = 'TRUST_RECOVERED',
       status_params = jsonb_build_object(
         'trust',     (regexp_match(status_reason, 'trust\s+(\d+)'))[1]::int,
         'threshold', (regexp_match(status_reason, '>\s*(\d+)'))[1]::int)
 where status_code is null
   and status_reason ~ 'trust\s+\d+\s*>\s*\d+';

-- ── 2. Индексы под постраничную выдачу ───────────────────────────────────────────────
--
-- Список сортируется по дате заведения и режется по владельцу, статусу и корзине.
-- Без индексов каждая страница — полный проход по таблице; на 63 строках это незаметно,
-- на 6300 будет заметно сразу.

create index if not exists accounts_meta_created_at_idx on public.accounts_meta (created_at desc);
create index if not exists accounts_meta_owner_idx      on public.accounts_meta (user_id);
create index if not exists accounts_meta_status_idx     on public.accounts_meta (status);
create index if not exists accounts_meta_trash_idx      on public.accounts_meta (in_trash);

-- ── 3. Представление списка ──────────────────────────────────────────────────────────
--
-- Права даются ТОЛЬКО service_role. Представление создаётся без security_invoker, то есть
-- выполняется с правами владельца и проходит мимо RLS нижележащих таблиц. Нашему бэкенду
-- это и нужно (он ходит service_role и режет доступ у себя), но именно поэтому отдавать
-- его anon/authenticated нельзя: это отдало бы весь парк любому, у кого есть ключ.

drop view if exists public.account_list;

create view public.account_list as
with ranked as (
  select
    a.*,
    -- Одна личность — одна строка. Ключ: telegram-id, иначе телефон, иначе осмысленный
    -- username (сгенерированные `user_xxxxxx` личностью не являются), иначе сам id.
    coalesce(
      nullif(a.tg_user_id, ''),
      'tel:' || nullif(regexp_replace(coalesce(a.phone, ''), '\D', '', 'g'), ''),
      case when a.username is not null and a.username <> '' and a.username !~ '^user_'
           then 'usr:' || lower(a.username) end,
      'id:' || a.id
    ) as identity_key,
    -- Какая из копий «лучше»: не в корзине > рабочий статус > есть прокси.
    (case when a.in_trash then 0 else 4 end)
      + (case when coalesce(a.status, 'active') not in ('reauth', 'invalid') then 2 else 0 end)
      + (case when a.proxy_id is not null then 1 else 0 end) as pick_score
  from public.accounts_meta a
),
picked as (
  select distinct on (identity_key) *
    from ranked
   order by identity_key, pick_score desc, created_at desc nulls last
)
select
  p.id,
  p.user_id                                 as owner_id,
  p.name,
  p.username,
  p.phone,
  p.tg_user_id,
  p.country,
  p.avatar_color,
  p.role,
  coalesce(p.status, 'active')              as status,
  p.status_code,
  p.status_params,
  p.status_since,
  p.status_until,
  p.prev_status,
  p.spamblock,
  p.spamblock_at,
  p.in_trash,
  p.is_service,
  p.is_platform,
  p.note,
  p.origin_code,
  p.origin_params,
  p.ggr_score,
  p.created_at,
  p.updated_at,
  p.last_checked_at,
  p.last_check_ok,
  p.health_checked_at,
  -- Наружу идёт ПРИЗНАК наличия облачного пароля, а не он сам.
  (p.two_fa_enc is not null or (p.data ? 'twoFA')) as has_two_fa,
  -- Прокси: ссылка и то, что показывают. Ни логина, ни пароля — строку подключения
  -- собирает воркер в момент коннекта, браузеру она не нужна и не отдаётся.
  p.proxy_id,
  px.label                                  as proxy_label,
  px.scheme                                 as proxy_scheme,
  px.host                                   as proxy_host,
  px.port                                   as proxy_port,
  px.country                                as proxy_country,
  px.status                                 as proxy_status,
  px.last_check_at                          as proxy_checked_at,
  t.score                                   as trust_score,
  t.band                                    as trust_band,
  (s.account_id is not null)                as has_session
from picked p
left join public.proxies          px on px.id = p.proxy_id
left join public.trust_cache      t  on t.account_id = p.id
left join public.account_sessions s  on s.account_id = p.id;

comment on view public.account_list is
  'Готовая строка списка аккаунтов: прокси, доверие и наличие сессии подтянуты по внешним ключам, дубли личностей схлопнуты. Без секретов. Только service_role.';

revoke all on public.account_list from public;
grant select on public.account_list to service_role;

-- ── 4. Счётчики плиток ───────────────────────────────────────────────────────────────

create or replace function public.account_status_counts(p_owner text default null)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(jsonb_object_agg(k, n), '{}'::jsonb)
  from (
    select key as k, count(*) as n
    from (
      select case
               when in_trash then 'trash'
               when spamblock = 'blocked'
                    and coalesce(status, 'active') in ('active', 'working', 'warming', 'pause')
                 then 'spamblock'
               else coalesce(status, 'active')
             end as key
      from public.account_list
      where p_owner is null or owner_id = p_owner
    ) x
    group by key
  ) y;
$$;

comment on function public.account_status_counts(text) is
  'Счётчики плиток менеджера аккаунтов одним запросом. p_owner = null — весь парк (админ).';

revoke all on function public.account_status_counts(text) from public;
grant execute on function public.account_status_counts(text) to service_role;

commit;
