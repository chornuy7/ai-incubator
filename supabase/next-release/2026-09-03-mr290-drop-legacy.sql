-- MR-290, выпуск N+1: снос колонок, которые заменены строками и колонками.
--
-- ⚠️ ЭТОТ ФАЙЛ НЕ ПРИМЕНЯЕТСЯ АВТОМАТИЧЕСКИ. Он лежит в supabase/next-release/, куда
-- раннер миграций не заходит. Условия и порядок — в README рядом.
--
-- Каждая колонка ниже уже перенесена и проверена на живой базе в выпуске MR-290. Здесь
-- только снос, никаких переносов: если данные не переехали, снос их потеряет, а
-- «перенести заодно» в одном файле со сносом означает, что ошибка в переносе станет
-- необратимой в ту же секунду.

-- ─────────────────────────────────────────────────────────────
-- Массивы, заменённые таблицами связей
-- ─────────────────────────────────────────────────────────────
-- Проверка перед сносом: строк в таблице связей не меньше, чем элементов в массивах.
-- Не равно, а «не меньше»: в массиве могли лежать битые идентификаторы, которые внешний
-- ключ не пропустил, — их потеря и есть смысл переезда.
do $$
declare было bigint; стало bigint;
begin
  select count(*) into было from profiles, lateral unnest(coalesce(role_ids, '{}')) where legacy_id is not null;
  select count(*) into стало from profile_roles;
  if стало < было then
    raise exception 'MR-290: ролей профилей в связях % при % в массивах — переезд не завершён, снос отменён', стало, было;
  end if;
end $$;

alter table profiles  drop column if exists role_ids;
alter table profiles  drop column if exists account_ids;
alter table profiles  drop column if exists account_group_ids;
alter table users     drop column if exists role_ids;
alter table campaigns drop column if exists modules;

-- Состав подписки в журнале кошелька. Его пишет функция wallet_log_append — она же
-- перестаёт заполнять колонку: подправить её нужно ТЕМ ЖЕ выпуском, см. ниже.
alter table wallet_log drop column if exists modules;

create or replace function wallet_log_append(entry jsonb, module_keys text[] default null)
returns bigint
language plpgsql
as $$
declare
  new_id bigint;
  k text;
  mid bigint;
  pos int := 0;
begin
  insert into wallet_log (ts, user_id, actor_id, amount, before_val, after_val, reason, currency, kind)
  values (
    coalesce((entry->>'ts')::timestamptz, now()),
    entry->>'user_id', entry->>'actor_id',
    (entry->>'amount')::numeric, (entry->>'before_val')::numeric, (entry->>'after_val')::numeric,
    coalesce(entry->>'reason', ''), entry->>'currency', entry->>'kind')
  returning id into new_id;

  foreach k in array coalesce(module_keys, '{}'::text[]) loop
    select id into mid from modules where key = k;
    if mid is null then
      raise exception 'MR-290: модуль % не найден в справочнике — запись журнала отменена', k;
    end if;
    insert into wallet_log_modules (log_id, module_id, position) values (new_id, mid, pos)
    on conflict do nothing;
    pos := pos + 1;
  end loop;

  return new_id;
end $$;

-- ─────────────────────────────────────────────────────────────
-- Мешки json, разложенные по колонкам
-- ─────────────────────────────────────────────────────────────
-- `channels.data`, `goals.data`, `account_activity.data` и `agents.data` держали
-- фиксированные наборы полей — все они теперь колонки и строки связанных таблиц.
--
-- `campaigns.data` и `campaign_schedules.data` НЕ СНОСЯТСЯ: в них остаются настройки
-- модулей и тело отложенной кампании, форма которых принадлежит не базе. Это не
-- недоделка, а граница, проведённая сознательно (см. миграцию remaining-bags).
alter table channels          drop column if exists data;
alter table goals             drop column if exists data;
alter table account_activity  drop column if exists data;
alter table agents            drop column if exists data;

-- Права роли: дерево заменено строками role_permissions.
alter table roles drop column if exists permissions;

-- Каталоги цен: три ячейки заменены тремя таблицами.
alter table price_overrides drop column if exists modules;
alter table price_overrides drop column if exists coin_packs;
alter table price_overrides drop column if exists periods;

-- Состав групп аккаунтов и прокси текстом — заменены связями ещё в основном выпуске.
alter table account_groups drop column if exists account_ids;
alter table accounts_meta  drop column if exists proxy;

-- ─────────────────────────────────────────────────────────────
-- Отметка о завершении
-- ─────────────────────────────────────────────────────────────
comment on schema public is
  'MR-290 завершён: json-мешки и массивы-идентификаторы заменены колонками и связями; время — timestamptz; секреты шифруются ключом из окружения.';
