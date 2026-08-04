-- §10.2/§11.1: аудит-журнал в БД (раньше файл data/audit.log.jsonl). Из него читается
-- «журнал действий юзера» в админке — теперь он queryable в Supabase, а не в файле.
--
-- Код (server/lib/auditLog.js) уже пишет/читает эту таблицу в supabase-режиме, а при
-- её отсутствии безопасно падает на файл — поэтому выкат кода и применение миграции
-- не обязаны совпадать по времени, аудит не теряется.
--
-- Как применить: Supabase → SQL Editor → выполнить этот файл.

create table if not exists audit_log (
  id        text,
  ts        timestamptz not null default now(),
  action    text,
  module    text,
  initiator text,
  code      text,
  reason    text,
  scope     jsonb not null default '{}'::jsonb,
  account   text,
  meta      jsonb
);

create index if not exists audit_log_ts_idx        on audit_log (ts desc);
create index if not exists audit_log_initiator_idx on audit_log (initiator);
create index if not exists audit_log_action_idx    on audit_log (action);

comment on table audit_log is 'Единый аудит-лог (§11.1): входы/IP, статусы, баланс, роли, задачи. Источник «журнала действий юзера» в админке.';
