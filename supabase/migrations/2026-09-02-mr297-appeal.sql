-- MR-297: помним подачу жалобы через @SpamBot, а не только её результат.
--
-- Живой прогон на проде 02.09: модуль подал жалобы, в журнале задачи это видно, а на самих
-- аккаунтах — ничего. Закрыли задачу — и уже не сказать, у кого обращение висит, а кого не
-- трогали. При трёх десятках спамблоков это подача по второму разу вслепую, а частые
-- обращения к @SpamBot антиспам считает поведением.
--
-- Миграция аддитивная и идемпотентная.

alter table public.accounts_meta add column if not exists appeal_at    timestamptz;
alter table public.accounts_meta add column if not exists appeal_state text;

comment on column public.accounts_meta.appeal_at is
  'Когда через @SpamBot подавали жалобу. Ставится по факту нажатий, а не по успеху: брошенный на полпути диалог — тоже след.';
comment on column public.accounts_meta.appeal_state is
  'sent — бот принял жалобу; stalled — нажали, подтверждения не дождались; cleared — ограничение снято; unknown — ответ не разобран.';

-- Выбор «у кого жалоба висит» — частый: по нему идёт и показ в списке, и перепроверка.
create index if not exists accounts_meta_appeal_idx
  on public.accounts_meta (appeal_state) where appeal_state is not null;

-- ── Представление: те же колонки плюс две новые в конце ───────────────────────────────
-- Определение повторено целиком: `create or replace view` не умеет менять список колонок
-- иначе как дописыванием в конец.

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
  p.status_until_source,
  -- MR-297: когда подавали жалобу и чем она пока кончилась.
  p.appeal_at,
  p.appeal_state
from picked p
left join public.proxies          px on px.id = p.proxy_id
left join public.trust_cache      t  on t.account_id = p.id
left join public.account_sessions s  on s.account_id = p.id;

comment on view public.account_list is
  'Готовая строка списка аккаунтов: прокси, доверие и наличие сессии подтянуты по внешним ключам, дубли личностей схлопнуты. Плюс источник срока статуса (MR-292) и состояние жалобы (MR-297). Без секретов. Только service_role.';

revoke all on public.account_list from public;
grant select on public.account_list to service_role;
