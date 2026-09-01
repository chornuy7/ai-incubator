-- MR-290, шаг 1: свести цепочку миграций с тем, что реально стоит на проде.
--
-- Снимок живой базы (supabase/schema.sql) показал четыре объекта, которых нет НИ В ОДНОЙ
-- миграции: таблицы users, daily_actions, trust_cache, индекс channels_peer_uniq и функция
-- bump_daily_action. Их завели руками через SQL Editor, и в git они не попали.
--
-- Чем это плохо, кроме неаккуратности: цепочка миграций перестала воспроизводить прод.
-- Собрать чистое окружение (новый регион, стенд, разбор аварии) из репозитория нельзя —
-- получится база, в которой вход по паролю падает на отсутствующей таблице, а счётчик
-- дневных лимитов не считает. Заметить это можно только запустив приложение.
--
-- Всё здесь идемпотентно (if not exists) и на боевой базе НИЧЕГО не меняет: объекты уже
-- есть. Смысл миграции — в чистом окружении, а не на проде.

-- ─────────────────────────────────────────────────────────────
-- 1. users — хранилище пароля для legacy-входа
-- ─────────────────────────────────────────────────────────────
-- Таблицу дропнула миграция 2026-08-03-drop-users-stage4.sql: предполагалось, что вход
-- целиком уедет в Supabase Auth. Не уехал — server/users.js по-прежнему читает отсюда
-- password_hash (см. authenticateLegacy). Таблицу вернули руками, и с тех пор она живёт
-- вне git. Сейчас в ней две строки.
--
-- Здесь она восстанавливается ровно в том виде, в каком стоит на проде. Убрать её можно
-- будет только вместе с legacy-входом — это отдельный шаг MR-290 (доступы), а не побочный
-- эффект наведения порядка в схеме.
create table if not exists users (
  id            text not null,
  email         text not null,
  name          text not null default '',
  password_hash text,
  role_ids      text[] not null default '{}',
  active        boolean not null default true,
  parent_id     text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  user_type_id  bigint
);

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'users_pkey' and conrelid = 'users'::regclass) then
    alter table users add constraint users_pkey primary key (id);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'users_email_key' and conrelid = 'users'::regclass) then
    alter table users add constraint users_email_key unique (email);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'users_parent_id_fkey' and conrelid = 'users'::regclass) then
    alter table users add constraint users_parent_id_fkey
      foreign key (parent_id) references users(id) on delete set null;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'users_user_type_id_fkey' and conrelid = 'users'::regclass) then
    alter table users add constraint users_user_type_id_fkey
      foreign key (user_type_id) references user_types(id) on delete set null;
  end if;
end $$;

create index if not exists users_parent_idx       on users (parent_id);
create index if not exists users_user_type_id_idx on users (user_type_id);
alter table users enable row level security;

comment on table users is
  'Хранилище пароля для входа (password_hash). Профили людей — в profiles; здесь только учётные данные. Не удалять, пока вход по паролю читает эту таблицу.';

-- ─────────────────────────────────────────────────────────────
-- 2. daily_actions — дневные лимиты действий аккаунта
-- ─────────────────────────────────────────────────────────────
-- Читает и пишет server/lib/dailyActions.js. Ключ (аккаунт, день, действие) — счётчик
-- одного вида действий за сутки; на нём держатся суточные потолки, то есть защита
-- аккаунта от бана. Без таблицы стор молча уходит в файл, и потолок считается «у каждого
-- инстанса свой» — ровно то, от чего уходили в MR-186.
create table if not exists daily_actions (
  account_id text not null,
  day        text not null,          -- YYYY-MM-DD, локальный день аккаунта
  action     text not null,
  count      integer not null default 0,
  updated_at timestamptz not null default now(),
  primary key (account_id, day, action)
);
create index if not exists daily_actions_day_idx on daily_actions (day);
alter table daily_actions enable row level security;

comment on table daily_actions is
  'Счётчики действий аккаунта за сутки. На них держатся дневные потолки — защита от бана.';

-- Инкремент одним запросом: два параллельных воркера иначе прочитали бы одно значение и
-- записали каждый своё, и потолок был бы пробит незаметно (классическое потерянное
-- обновление). Возвращает НОВОЕ значение — вызывающий сразу знает, упёрся он в лимит или нет.
create or replace function bump_daily_action(p_account text, p_day text, p_action text)
returns integer
language sql
as $$
  insert into daily_actions (account_id, day, action, count, updated_at)
  values (p_account, p_day, p_action, 1, now())
  on conflict (account_id, day, action)
    do update set count = daily_actions.count + 1, updated_at = now()
  returning count;
$$;

-- ─────────────────────────────────────────────────────────────
-- 3. trust_cache — кэш доверия к аккаунту
-- ─────────────────────────────────────────────────────────────
-- Читает server/lib/trustCache.js. Порог trust<40 закрывает боевые модули (§6), поэтому
-- значение влияет на то, будет ли аккаунт работать вообще.
create table if not exists trust_cache (
  account_id text primary key,
  score      integer not null,
  band       text,
  updated_at bigint not null          -- epoch-ms; приводится к timestamptz на шаге «типы»
);
alter table trust_cache enable row level security;

comment on table trust_cache is
  'Кэш оценки доверия к аккаунту. Порог закрывает боевые модули, поэтому значение влияет на работу, а не только на показ.';

-- ─────────────────────────────────────────────────────────────
-- 4. channels_peer_uniq — «один канал Telegram — одна строка»
-- ─────────────────────────────────────────────────────────────
-- Индекс завели руками, и в нём ошибка: условие `tg_peer_id is not null` на колонке,
-- объявленной `not null default ''`. Условие истинно ВСЕГДА, поэтому в уникальность
-- попадает и пустая строка. Пока каналов без peer-id нет (проверено: 0 из 85) это не
-- проявляется, но первый же канал, добавленный без peer-id, займёт «пустое» место, и
-- второй такой вставиться не сможет — с ошибкой уникальности вместо понятного отказа.
--
-- Правим условие на `<> ''`: дедуплицируем реальные peer-id, а каналы без него не мешают
-- друг другу. Индекс пересоздаём под ТЕМ ЖЕ именем — старый снимаем явно.
drop index if exists channels_peer_uniq;
create unique index if not exists channels_peer_uniq
  on channels (tg_peer_id) where tg_peer_id <> '';

comment on index channels_peer_uniq is
  'Один канал Telegram — одна строка. Каналы без peer-id из индекса исключены: пустая строка не идентификатор.';
