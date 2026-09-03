-- LOG-002 (MR-121): журнал действий модулей. Реализует docs/CONTRACT-action-log.md.
-- Единый queryable след действий бота в Telegram (пост/коммент/реакция/чат/ЛС/вступление):
-- что за аккаунт, над каким объектом, по какой задаче, когда — и как отреагировала аудитория.
--
-- Код (server/actionLog.js) уже пишет/читает эту таблицу в supabase-режиме, а при её
-- отсутствии безопасно падает на файл data/module-actions.jsonl — выкат кода и применение
-- миграции не обязаны совпадать по времени, действия не теряются.
--
-- Как применить: Supabase → SQL Editor → выполнить этот файл.

create table if not exists module_actions (
  id           text primary key,
  ts           timestamptz not null default now(),
  type         text not null,
  status       text not null default 'sent',
  account_id   text,
  account_name text,
  target       text,
  target_title text,
  object_ref   jsonb not null default '{}'::jsonb,
  value        jsonb not null default '{}'::jsonb,
  module_key   text,
  task_id      text,
  launch_id    text,
  goal_id      text,
  initiator    text,
  audience     jsonb not null default '{}'::jsonb,
  meta         jsonb not null default '{}'::jsonb,
  created_at   timestamptz not null default now()
);

create index if not exists module_actions_ts_idx      on module_actions (ts desc);
create index if not exists module_actions_task_idx    on module_actions (task_id);
create index if not exists module_actions_account_idx on module_actions (account_id);
create index if not exists module_actions_type_idx    on module_actions (type);

comment on table module_actions is 'Журнал действий модулей (LOG-002): пост/коммент/реакция/чат/ЛС/вступление — что бот сделал в Telegram, над каким объектом и как отреагировала аудитория.';
