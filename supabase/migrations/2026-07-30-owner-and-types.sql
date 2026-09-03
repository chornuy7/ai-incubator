-- §11.3: правильная схема — данные привязаны к юзеру, типы и права ссылками.
--
-- Со звонка 29.07 (заказчик открыл базу и разобрал ошибки):
--   1. «Цель должна быть завязана за юзером, который её создал. Она сейчас ни за что
--      не завязана и просто висит в пустоте» → user_id + foreign key во всех данных.
--   2. «Ты никогда не держишь типизацию в тексте» → отдельная таблица типов, имя
--      UNIQUE + проверки длины и паттерна НА УРОВНЕ БД, а не фильтром снаружи.
--   3. «Права — либо в таблице типов, либо отдельной таблицей связей» → join-таблица
--      из двух референсов, чтобы таблицы-сущности оставались чистыми.
--
-- Всё ДОБАВЛЯЕТСЯ и nullable: приложение работает и до, и после применения, поэтому
-- миграцию можно катить без простоя. Разделение auth.users / profiles сюда НЕ входит —
-- оно ломает вход и требует окна обслуживания (см. TASKS-2026-07-29, БЛОК A).
--
-- Как применить: Supabase → SQL Editor → выполнить этот файл.

-- ── 1. Владелец записи ───────────────────────────────────────────────────────
-- on delete set null: удаление юзера не должно уносить его данные и статистику —
-- запись остаётся, владелец обнуляется (как уже сделано для users.parent_id).

alter table goals            add column if not exists user_id text references users(id) on delete set null;
alter table campaigns        add column if not exists user_id text references users(id) on delete set null;
alter table leads            add column if not exists user_id text references users(id) on delete set null;
alter table parsed_channels  add column if not exists user_id text references users(id) on delete set null;
alter table accounts_meta    add column if not exists user_id text references users(id) on delete set null;

-- Выборка «всё по юзеру» — основной запрос админки (§11.1), поэтому индексы.
create index if not exists goals_user_id_idx           on goals(user_id);
create index if not exists campaigns_user_id_idx       on campaigns(user_id);
create index if not exists leads_user_id_idx           on leads(user_id);
create index if not exists parsed_channels_user_id_idx on parsed_channels(user_id);
create index if not exists accounts_meta_user_id_idx   on accounts_meta(user_id);

comment on column goals.user_id is 'Кто создал цель. NULL — запись до §11.3 либо владелец удалён.';

-- ── 2. Типы пользователей отдельной таблицей ────────────────────────────────
-- Имя уникальное (нельзя завести два «administrator»), длина ограничена, паттерн
-- запрещает точки и постороннее — чтобы в таблицу нельзя было заслать произвольное.

create table if not exists user_types (
  id         bigserial primary key,
  name       text not null unique
             check (char_length(name) between 2 and 40)
             check (name ~ '^[a-z][a-z0-9_-]*$'),
  title      text not null default '',   -- человеческое название для UI
  created_at timestamptz not null default now()
);

comment on table user_types is '§11.3: типы пользователей. Хранятся ссылкой (profiles.user_type_id), а не текстом в строке юзера.';

insert into user_types (name, title) values
  ('administrator', 'Администратор'),
  ('operator',      'Оператор'),
  ('viewer',        'Наблюдатель')
on conflict (name) do nothing;

-- Ссылка на тип у пользователя. Пока живём на своей таблице users; при переезде на
-- auth.users/profiles колонка переедет вместе с остальным профилем.
alter table users add column if not exists user_type_id bigint references user_types(id) on delete set null;
create index if not exists users_user_type_id_idx on users(user_type_id);

-- ── 3. Права: тип ↔ модуль отдельной таблицей связей ────────────────────────
-- Две ссылки в строке. Таблица модулей (и типов) остаётся «чистой как стёклышко»,
-- связи живут снаружи — это и просил заказчик.

create table if not exists modules (
  id    bigserial primary key,
  key   text not null unique check (key ~ '^[a-z][a-z0-9_-]*$'),
  title text not null default ''
);

create table if not exists user_type_modules (
  user_type_id bigint not null references user_types(id) on delete cascade,
  module_id    bigint not null references modules(id)    on delete cascade,
  primary key (user_type_id, module_id)
);

comment on table user_type_modules is '§11.3: какие модули разрешены типу пользователя. Только две ссылки — никакого текста.';
