-- §11.3: `profiles` — профиль человека отдельно от аутентификации.
--
-- Со звонка 29.07: «не создавай таблицу users — есть auth user, они будут путаться.
-- Тебе нужно создать таблицу profile. И в profile ты НЕ держишь email — email держится
-- в аутентификационной таблице auth.users».
--
-- Эта миграция БЕЗОПАСНА и ничего не переключает: таблица создаётся пустой и стоит, пока
-- в Supabase Auth не появятся пользователи. Вход продолжает работать через нашу `users`.
-- Наполнение и переключение — отдельный шаг по окну (см. docs/RUNBOOK-auth-profiles.md).
--
-- `legacy_id` — прежний `usr_…`. Он позволяет НЕ переписывать user_id в тринадцати
-- таблицах данных: связи остаются как есть, а сопоставление идёт через эту колонку.
-- Полный переезд на uuid можно сделать позже и отдельно.
--
-- Как применить: Supabase → SQL Editor → выполнить этот файл.

create table if not exists profiles (
  id           uuid primary key references auth.users(id) on delete cascade,
  legacy_id    text unique,
  name         text not null default '',
  active       boolean not null default true,
  parent_id    uuid references profiles(id) on delete set null,
  user_type_id bigint references user_types(id) on delete set null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create index if not exists profiles_legacy_id_idx    on profiles(legacy_id);
create index if not exists profiles_user_type_id_idx on profiles(user_type_id);

comment on table profiles is
  '§11.3: профиль пользователя. E-mail и пароль живут в auth.users — здесь их быть не должно.';
comment on column profiles.legacy_id is
  'Прежний usr_… из таблицы users. Через него связаны данные, чтобы не переписывать FK 13 таблиц.';
