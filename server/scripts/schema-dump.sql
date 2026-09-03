-- ИСТОЧНИК ФОРМАТА СНИМКА СХЕМЫ (MR-290).
--
-- Один запрос, возвращающий ОДНУ строку — текст файла supabase/schema.sql целиком.
-- Формат живёт здесь, а не в JS: снимок собирает сама база из своих каталогов, поэтому
-- расхождение «в файле одно, в базе другое» физически невозможно.
--
-- Запускается из server/scripts/schema-dump.mjs (npm run db:schema).
-- Вывод детерминирован: всё отсортировано по имени, иначе diff шумел бы на каждом прогоне.
with
tables as (
  select c.oid, c.relname
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relkind = 'r'
),
cols as (
  select t.relname,
         string_agg(
           '  ' || a.attname || ' ' || format_type(a.atttypid, a.atttypmod)
           || case when a.attidentity <> '' then ' generated always as identity' else '' end
           || case when d.adbin is not null and a.attidentity = ''
                   then ' default ' || pg_get_expr(d.adbin, d.adrelid) else '' end
           || case when a.attnotnull then ' not null' else '' end,
           E',\n' order by a.attnum) as body
  from tables t
  join pg_attribute a on a.attrelid = t.oid and a.attnum > 0 and not a.attisdropped
  left join pg_attrdef d on d.adrelid = t.oid and d.adnum = a.attnum
  group by t.relname
),
table_ddl as (
  select string_agg('create table ' || relname || E' (\n' || body || E'\n);', E'\n\n' order by relname) as s
  from cols
),
cons as (
  select string_agg('alter table ' || k.conrelid::regclass::text
                    || ' add constraint ' || k.conname || ' ' || pg_get_constraintdef(k.oid) || ';',
                    E'\n' order by
                      case k.contype when 'p' then 1 when 'u' then 2 when 'c' then 3 else 4 end,
                      k.conrelid::regclass::text, k.conname) as s
  from pg_constraint k
  where k.connamespace = 'public'::regnamespace and k.contype in ('p','u','c','f')
),
idx as (
  select string_agg(i.indexdef || ';', E'\n' order by i.tablename, i.indexname) as s
  from pg_indexes i
  where i.schemaname = 'public'
    and not exists (select 1 from pg_constraint k
                    where k.connamespace = 'public'::regnamespace
                      and k.conname = i.indexname and k.contype in ('p','u'))
),
rls as (
  select string_agg('alter table ' || relname || ' enable row level security;', E'\n' order by relname) as s
  from tables t join pg_class c on c.oid = t.oid
  where c.relrowsecurity
),
pol as (
  select string_agg(
    'create policy ' || quote_ident(p.polname) || ' on ' || p.polrelid::regclass::text
    || ' for ' || case p.polcmd when 'r' then 'select' when 'a' then 'insert'
                                when 'w' then 'update' when 'd' then 'delete' else 'all' end
    || coalesce(' to ' || nullif(array_to_string(array(
         select r.rolname from pg_roles r where r.oid = any(p.polroles) order by r.rolname), ', '), ''), '')
    || coalesce(E'\n  using (' || pg_get_expr(p.polqual, p.polrelid) || ')', '')
    || coalesce(E'\n  with check (' || pg_get_expr(p.polwithcheck, p.polrelid) || ')', '')
    || ';',
    E'\n' order by p.polrelid::regclass::text, p.polname) as s
  from pg_policy p
  where p.polrelid in (select oid from tables)
),
fns as (
  select string_agg(pg_get_functiondef(p.oid) || ';', E'\n\n' order by p.proname) as s
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.prokind = 'f'
),
trg as (
  select string_agg(stmt, E'\n' order by stmt) as s from (
    select pg_get_triggerdef(g.oid) || ';' as stmt
    from pg_trigger g
    where not g.tgisinternal
      and (g.tgrelid in (select oid from tables) or g.tgrelid = 'auth.users'::regclass)
    union all
    -- Событийные триггеры лежат не в pg_trigger, а забыть их нельзя: rls_auto_enable
    -- включает RLS на КАЖДОЙ новой таблице. Пропустишь его в снимке — при пересборке
    -- окружения свежая таблица окажется открытой, и заметят это не сразу.
    select 'create event trigger ' || e.evtname || ' on ' || e.evtevent
           || ' execute function ' || e.evtfoid::regproc::text || ';'
    from pg_event_trigger e
  ) y
),
cmts as (
  select string_agg(stmt, E'\n' order by stmt) as s from (
    select 'comment on table ' || t.relname || ' is ' || quote_literal(obj_description(t.oid, 'pg_class')) || ';' as stmt
    from tables t where obj_description(t.oid, 'pg_class') is not null
    union all
    select 'comment on column ' || t.relname || '.' || a.attname || ' is '
           || quote_literal(col_description(t.oid, a.attnum)) || ';'
    from tables t join pg_attribute a on a.attrelid = t.oid and a.attnum > 0 and not a.attisdropped
    where col_description(t.oid, a.attnum) is not null
  ) x
)
select
  '-- СНИМОК СХЕМЫ БАЗЫ. ФАЙЛ СГЕНЕРИРОВАН — РУКАМИ НЕ ПРАВИТЬ.' || E'\n' ||
  '--' || E'\n' ||
  '-- Собирается из каталогов самой базы: npm run db:schema (server/scripts/schema-dump.mjs).' || E'\n' ||
  '-- Формат — server/scripts/schema-dump.sql. Проверка расхождения — npm run db:schema -- --check.' || E'\n' ||
  '--' || E'\n' ||
  '-- Это СПРАВКА и ЭТАЛОН ДЛЯ СВЕРКИ, а не способ применения. Схему меняют миграции из' || E'\n' ||
  '-- supabase/migrations (npm run migrate); файл пересобирается после них и едет тем же PR.' || E'\n' ||
  '-- Прежний рукописный schema.sql описывал 14 таблиц из 52 и содержал давно удалённую' || E'\n' ||
  '-- parsed_channels — расхождение замечали по странным ошибкам, а не по файлу (MR-290).' || E'\n' ||
  E'\n' ||
  '-- ─── ТАБЛИЦЫ ───' || E'\n\n' || coalesce((select s from table_ddl), '') || E'\n\n' ||
  '-- ─── ОГРАНИЧЕНИЯ: ключи, уникальность, проверки, внешние ключи ───' || E'\n\n' || coalesce((select s from cons), '') || E'\n\n' ||
  '-- ─── ИНДЕКСЫ (кроме тех, что стоят за ограничениями) ───' || E'\n\n' || coalesce((select s from idx), '') || E'\n\n' ||
  '-- ─── ФУНКЦИИ ───' || E'\n\n' || coalesce((select s from fns), '') || E'\n\n' ||
  '-- ─── ТРИГГЕРЫ ───' || E'\n\n' || coalesce((select s from trg), '') || E'\n\n' ||
  '-- ─── RLS ───' || E'\n\n' || coalesce((select s from rls), '') || E'\n\n' ||
  '-- ─── ПОЛИТИКИ ───' || E'\n\n' || coalesce((select s from pol), '') || E'\n\n' ||
  '-- ─── КОММЕНТАРИИ ───' || E'\n\n' || coalesce((select s from cmts), '') || E'\n'
  as schema_text;
