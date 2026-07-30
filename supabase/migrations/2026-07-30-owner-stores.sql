-- §11.3 (добивка аудита): владелец на перенесённых сторах.
--
-- Финальная сверка со звонком показала: у channels, account_groups и campaign_schedules
-- нет user_id, хотя это «данные, которые кто-то создал». account_activity намеренно без
-- владельца — это состояние усталости по аккаунту, а не созданный юзером объект.
--
-- Про channels отдельно: это дедуплицированный каталог результатов парсинга, и один
-- канал могут найти парсеры РАЗНЫХ юзеров. Поэтому user_id тут — «кто первым добавил»,
-- а не единоличный владелец; для каталога это нормально, полноценной приватности по
-- каналам не подразумевается.
--
-- Как применить: Supabase → SQL Editor → выполнить этот файл.

alter table channels            add column if not exists user_id text references users(id) on delete set null;
alter table account_groups      add column if not exists user_id text references users(id) on delete set null;
alter table campaign_schedules  add column if not exists user_id text references users(id) on delete set null;

create index if not exists channels_user_id_idx           on channels(user_id);
create index if not exists account_groups_user_id_idx     on account_groups(user_id);
create index if not exists campaign_schedules_user_id_idx on campaign_schedules(user_id);

comment on column channels.user_id           is 'Кто первым добавил канал (каталог дедуплицируется — не единоличный владелец).';
comment on column account_groups.user_id     is 'Кто создал группу аккаунтов.';
comment on column campaign_schedules.user_id is 'Кто создал расписание.';
