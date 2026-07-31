-- §11.3 (переезд на profiles, ЭТАП 3/4): все FK с users → снять; owner 11 таблиц → profiles.
--
-- Замовник: «profile вместо user». Готовим удаление таблицы users: снимаем ВСЕ внешние
-- ключи, ссылающиеся на неё, и там, где это владелец-оператор (usr_…), переводим ссылку
-- на profiles(legacy_id). Значения (usr_admin/usr_test) есть в profiles — переезд без потерь.
--
-- ОСОБЫЙ СЛУЧАЙ. coin_balance / subscriptions содержат СЛУЖЕБНЫЕ ключи (`__default`,
-- `workspace`), которых нет и не должно быть в profiles. Поэтому их FK просто СНИМАЕМ
-- (не переводим на profiles) — целостность этих кошельков/подписок ведёт код. api_keys
-- (пустая, ключи per-user убираются по §11.8) — тоже без нового FK.
--
-- Применять ПОСЛЕ этапов 1–2. После него users — НЕ цель ни одного FK; удалит этап 4.
-- Как применить: Supabase → SQL Editor → выполнить этот файл.

-- 1. Снять ВСЕ внешние ключи, ссылающиеся на users (кроме self-ref внутри самой users —
--    он уйдёт вместе с таблицей на этапе 4). Имена авто-сгенерированы — берём из каталога.
do $$
declare r record;
begin
  for r in
    select con.conname as cname, rel.relname as tname
    from pg_constraint con
    join pg_class rel  on rel.oid  = con.conrelid
    join pg_class fref on fref.oid = con.confrelid
    where con.contype = 'f' and fref.relname = 'users' and rel.relname <> 'users'
  loop
    execute format('alter table %I drop constraint %I', r.tname, r.cname);
  end loop;
end $$;

-- 2. Owner-таблицы оператора → profiles(legacy_id), тот же on delete set null.
alter table goals               add constraint goals_user_profile_fkey               foreign key (user_id) references profiles(legacy_id) on delete set null;
alter table campaigns           add constraint campaigns_user_profile_fkey           foreign key (user_id) references profiles(legacy_id) on delete set null;
alter table leads               add constraint leads_user_profile_fkey               foreign key (user_id) references profiles(legacy_id) on delete set null;
alter table parsed_channels     add constraint parsed_channels_user_profile_fkey     foreign key (user_id) references profiles(legacy_id) on delete set null;
alter table accounts_meta       add constraint accounts_meta_user_profile_fkey       foreign key (user_id) references profiles(legacy_id) on delete set null;
alter table bundles             add constraint bundles_user_profile_fkey             foreign key (user_id) references profiles(legacy_id) on delete set null;
alter table roles               add constraint roles_user_profile_fkey               foreign key (user_id) references profiles(legacy_id) on delete set null;
alter table channels            add constraint channels_user_profile_fkey            foreign key (user_id) references profiles(legacy_id) on delete set null;
alter table account_groups      add constraint account_groups_user_profile_fkey      foreign key (user_id) references profiles(legacy_id) on delete set null;
alter table campaign_schedules  add constraint campaign_schedules_user_profile_fkey  foreign key (user_id) references profiles(legacy_id) on delete set null;
alter table messages            add constraint messages_user_profile_fkey            foreign key (user_id) references profiles(legacy_id) on delete set null;

-- 3. coin_balance / subscriptions / api_keys — БЕЗ нового FK (см. шапку). FK сняты в шаге 1.
