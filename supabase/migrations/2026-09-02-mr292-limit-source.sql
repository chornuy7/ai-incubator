-- MR-292: ЧТО именно с аккаунтом — вид ограничения виден списку, а не только воркеру.
--
-- Владелец 01.09: «нам нужно определять, что с аккаунтом, и давать чёткое понятие» —
-- временный спамблок, вечный, бан платформы, протухшая сессия. Отличие временного от
-- вечного держится на ОДНОМ признаке: назвал ли срок сам @SpamBot (MR-291). Наш код при
-- неизвестном сроке подставляет сутки по умолчанию, и выдавать эту догадку за обещание
-- Telegram нельзя: проверка 02.09 показала шесть аккаунтов из шести всё ещё в блоке
-- спустя пять дней после такого «срока».
--
-- Признак живёт в мете (`statusUntilSource`), но лежал только в jsonb `data`, а список
-- аккаунтов читает представление `account_list` — то есть до витрины не доезжал.
-- Заводим колонку и добавляем её в представление.
--
-- Миграция аддитивная и идемпотентная.

alter table public.accounts_meta add column if not exists status_until_source text;

comment on column public.accounts_meta.status_until_source is
  'Откуда взялся status_until: spambot — срок назвал сам @SpamBot; default — подставлен нашим кодом. Только первое считается сроком Telegram.';

-- Перенос уже накопленного из jsonb: без него у аккаунтов, прошедших через @SpamBot до
-- этой миграции, признак потерялся бы и они выглядели бы «без срока».
update public.accounts_meta
   set status_until_source = nullif(data->>'statusUntilSource', '')
 where status_until_source is null
   and nullif(data->>'statusUntilSource', '') is not null;

-- ── Представление: та же выборка плюс одна колонка в конце ────────────────────────────
-- Определение повторено целиком намеренно: `create or replace view` не умеет менять
-- список колонок иначе как дописыванием в конец, а читать «что там было» по цепочке
-- миграций тяжелее, чем видеть определение целиком.

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
  (s.account_id is not null)                as has_session,
  -- MR-292: откуда взялся срок статуса — 'spambot' (сказал бот) или 'default' (наша догадка).
  p.status_until_source
from picked p
left join public.proxies          px on px.id = p.proxy_id
left join public.trust_cache      t  on t.account_id = p.id
left join public.account_sessions s  on s.account_id = p.id;

comment on view public.account_list is
  'Готовая строка списка аккаунтов: прокси, доверие и наличие сессии подтянуты по внешним ключам, дубли личностей схлопнуты. Плюс источник срока статуса (MR-292). Без секретов. Только service_role.';

revoke all on public.account_list from public;
grant select on public.account_list to service_role;
