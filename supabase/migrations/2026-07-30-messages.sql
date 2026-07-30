-- §11.1: тексты переписки — «нам нужно всё, чтобы был доступ ко всему».
--
-- Решение владельца (30.07) по открытому вопросу со звонка 29.07: переписку храним
-- ЦЕЛИКОМ. Обоснование то же, что и у журнала активности: внутри нашей экосистемы
-- чужие люди работают нашими Telegram-аккаунтами, и за то, что они пишут, отвечаем мы.
--
-- Что здесь важно понимать про приватность и объём:
--   • это персональные данные третьих лиц (собеседников), а не только наших юзеров —
--     доступ к таблице только у админа, наружу она не отдаётся;
--   • таблица растёт быстрее всех остальных: индексы по аккаунту/собеседнику/времени
--     обязательны, иначе выборка «переписка с этим человеком» ляжет уже на сотнях тысяч;
--   • ретеншн (сколько храним) осознанно НЕ задан — владелец просил «всё». Когда объём
--     станет заметен, добавить чистку старше N месяцев отдельной миграцией.
--
-- Как применить: Supabase → SQL Editor → выполнить этот файл.

create table if not exists messages (
  id          bigserial primary key,
  -- Кто вёл переписку: аккаунт-бот и владелец-юзер (FK — как в §11.3).
  account_id  text not null,
  user_id     text references users(id) on delete set null,
  -- С кем: @username или id собеседника в Telegram.
  peer        text not null default '',
  -- 'in' — написали нам, 'out' — написали мы.
  direction   text not null check (direction in ('in', 'out')),
  text        text not null default '',
  module_key  text not null default '',
  task_id     text not null default '',
  campaign_id text not null default '',
  created_at  timestamptz not null default now()
);

-- Основные запросы: «вся переписка этого аккаунта», «переписка с этим человеком»,
-- «что писал этот юзер». Везде — свежее сверху.
create index if not exists messages_account_created_idx on messages(account_id, created_at desc);
create index if not exists messages_peer_created_idx    on messages(peer, created_at desc);
create index if not exists messages_user_created_idx    on messages(user_id, created_at desc);

comment on table messages is
  '§11.1: полная переписка аккаунтов. Персональные данные третьих лиц — доступ только админу.';
