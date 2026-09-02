-- MR-290, шаг 15: карточка канала — колонками, а не мешком json.
--
-- `channels.data` называлась «всё остальное», но остального там не было: тринадцать полей,
-- и каждое лежит у ВСЕХ 85 каналов. Это не открытый набор, это обычная запись, случайно
-- записанная в одну ячейку.
--
-- Чем это стоило:
--   • «покажи каналы на русском с ER выше 3%» — это фильтр по двум полям, но по json он
--     не индексируется и считается перебором всей таблицы;
--   • тип не проверяется: `avgViews` мог оказаться строкой, и никто бы не заметил, пока
--     сортировка не выдала бы «10» больше «9»;
--   • имена ключей — camelCase из JavaScript посреди SQL-базы, где всё остальное
--     snake_case; любой отчёт мимо приложения писался с оглядкой на это.
--
-- Колонка `data` НЕ УДАЛЯЕТСЯ: миграции применяются до выката кода, и в промежутке
-- карточку читает предыдущая версия. Снимем следующим выпуском.

alter table channels add column if not exists category       text;
alter table channels add column if not exists language       text;
alter table channels add column if not exists region         text;
alter table channels add column if not exists activity       text;
alter table channels add column if not exists activity_label text;
alter table channels add column if not exists avg_views      numeric;
alter table channels add column if not exists er             numeric;
alter table channels add column if not exists bot_in_group   boolean not null default false;
alter table channels add column if not exists stats_by       text;
alter table channels add column if not exists last_post_at   timestamptz;
alter table channels add column if not exists last_stats_at  timestamptz;

comment on column channels.er is
  'Вовлечённость: доля от числа подписчиков. NULL — не считали (постов не было или статистика не снималась), это не то же самое, что ноль.';
comment on column channels.bot_in_group is
  'Бот состоит в группе обсуждения: тогда статистика снимается примерно раз в час, иначе раз в день (решение 14.07).';
comment on column channels.last_stats_at is
  'Когда последний раз снимали статистику. NULL — ни разу.';

-- Диапазонные фильтры («на русском с ER выше 3%») по json считались перебором.
create index if not exists channels_language_idx on channels (language) where language is not null;
create index if not exists channels_category_idx on channels (category) where category is not null;
create index if not exists channels_er_idx       on channels (er)       where er is not null;

-- ─────────────────────────────────────────────────────────────
-- Откуда канал взялся
-- ─────────────────────────────────────────────────────────────
-- `data.sources` — массив вида `parse:<id задачи>`: какие запуски парсера принесли этот
-- канал. Это НЕ справочная мелочь: по нему режется доступ. `channelsForRequest` показывает
-- оператору только те каналы, которые нашли ЕГО задачи, — то есть пустой список источников
-- означает «канала не видно никому».
--
-- Внешнего ключа на `tasks` здесь СОЗНАТЕЛЬНО НЕТ, хотя напрашивается. Задачи переезжают
-- в базу отдельным скриптом при выкате, и до его прогона половина идентификаторов ни на
-- что не сошлётся. Внешний ключ в этот момент выбросил бы такие строки — и каналы просто
-- исчезли бы из интерфейса у своих владельцев, а выглядело бы это как потеря данных.
-- Ключ добавляется отдельной миграцией ПОСЛЕ того, как задачи окажутся в базе целиком.
create table if not exists channel_sources (
  channel_id text not null references channels(id) on delete cascade,
  task_id    text not null,
  primary key (channel_id, task_id)
);

comment on table channel_sources is
  'MR-290: какие запуски парсера принесли канал (было channels.data.sources). По этой связи режется доступ к каналам, см. channelsForRequest.';

-- Обратный вопрос — «какие каналы принёс этот запуск» — раньше требовал перебора всех
-- каналов с разворотом массива. Теперь это чтение по индексу.
create index if not exists channel_sources_task_idx on channel_sources (task_id);

insert into channel_sources (channel_id, task_id)
select c.id, replace(s.value #>> '{}', 'parse:', '')
  from channels c, lateral jsonb_array_elements(coalesce(c.data->'sources', '[]'::jsonb)) s
 where nullif(replace(s.value #>> '{}', 'parse:', ''), '') is not null
on conflict do nothing;

-- ─────────────────────────────────────────────────────────────
-- Дополнительные категории
-- ─────────────────────────────────────────────────────────────
-- У канала одна основная категория (колонка выше) и произвольный список дополнительных.
-- Список — значит строки, а не массив: иначе «сколько у нас каналов про крипту» опять
-- считается перебором.
create table if not exists channel_categories (
  channel_id text not null references channels(id) on delete cascade,
  category   text not null,
  position   int  not null default 0,
  primary key (channel_id, category)
);

comment on table channel_categories is
  'MR-290: дополнительные категории канала (было channels.data.categoriesExtra). Основная категория — колонка channels.category.';

create index if not exists channel_categories_category_idx on channel_categories (category);

insert into channel_categories (channel_id, category, position)
select c.id, k.value #>> '{}', k.ord - 1
  from channels c, lateral jsonb_array_elements(coalesce(c.data->'categoriesExtra', '[]'::jsonb)) with ordinality as k(value, ord)
 where nullif(k.value #>> '{}', '') is not null
on conflict do nothing;

-- ─────────────────────────────────────────────────────────────
-- Перенос полей из мешка
-- ─────────────────────────────────────────────────────────────
-- `jsonb_typeof(...) = 'null'` проверяется отдельно от `is null`: в json ноль, пустая
-- строка и null — разные значения, и `(data->>'er')::numeric` на json-овом null дал бы
-- не NULL, а ошибку приведения.
update channels set
  category       = coalesce(nullif(data->>'category', ''), category),
  language       = coalesce(nullif(data->>'language', ''), language),
  region         = coalesce(nullif(data->>'region', ''), region),
  activity       = coalesce(nullif(data->>'activity', ''), activity),
  activity_label = coalesce(nullif(data->>'activityLabel', ''), activity_label),
  stats_by       = coalesce(nullif(data->>'statsBy', ''), stats_by),
  avg_views      = coalesce(case when jsonb_typeof(data->'avgViews') = 'number' then (data->>'avgViews')::numeric end, avg_views),
  er             = coalesce(case when jsonb_typeof(data->'er')       = 'number' then (data->>'er')::numeric end, er),
  bot_in_group   = coalesce(case when jsonb_typeof(data->'botInGroup') = 'boolean' then (data->>'botInGroup')::boolean end, bot_in_group),
  -- Время в мешке лежало миллисекундами; ноль там означал «никогда», а не 1970 год.
  last_post_at   = coalesce(case when jsonb_typeof(data->'lastPostAt')  = 'number' and (data->>'lastPostAt')::bigint  > 0 then to_timestamp((data->>'lastPostAt')::bigint  / 1000.0) end, last_post_at),
  last_stats_at  = coalesce(case when jsonb_typeof(data->'lastStatsAt') = 'number' and (data->>'lastStatsAt')::bigint > 0 then to_timestamp((data->>'lastStatsAt')::bigint / 1000.0) end, last_stats_at)
where data is not null and jsonb_typeof(data) = 'object';

alter table channel_sources    enable row level security;
alter table channel_categories enable row level security;
grant select, insert, update, delete on channel_sources    to service_role;
grant select, insert, update, delete on channel_categories to service_role;
