-- §11.3 (добивка): «кто создал» на оставшихся таблицах.
--
-- Аудит схемы 30.07 после основной миграции показал, что владелец проставлен не везде:
-- goals/campaigns/leads/accounts_meta/parsed_channels/messages — есть, api_keys — есть
-- (owner_id), а вот наборы и роли создаются «ничьими». По правилу со звонка 29.07
-- («данные должны быть завязаны за юзером, который их создал») это тот же пробел.
--
-- Наборы и роли создаёт админ, поэтому колонка nullable: у уже созданных записей
-- владельца нет, и приписывать его задним числом нечему.
--
-- Как применить: Supabase → SQL Editor → выполнить этот файл.

alter table bundles add column if not exists user_id text references users(id) on delete set null;
alter table roles   add column if not exists user_id text references users(id) on delete set null;

create index if not exists bundles_user_id_idx on bundles(user_id);
create index if not exists roles_user_id_idx   on roles(user_id);

comment on column bundles.user_id is 'Кто собрал набор. NULL — создан до §11.3.';
comment on column roles.user_id   is 'Кто создал роль. NULL — создана до §11.3.';
