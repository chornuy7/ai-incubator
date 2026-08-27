-- Правила автоматизации переезжают из файла в общую базу.
--
-- Находка 27.08 (MR-186): `server/automation/store.js` писал в data/automation/rules.json,
-- ветки Supabase не было. Правило — это расписание, по которому платформа сама тратит
-- аккаунты и деньги клиента:
--   • пропал диск — расписания нет, кампании молча перестали запускаться, и заметить
--     это можно только по отсутствию результата;
--   • при втором инстансе у каждого сервера свой файл: правило, выключенное на одном,
--     на другом продолжает запускаться.
create table if not exists automation_rules (
  id      text primary key,
  -- Владелец пространства. NULL — правила, заведённые до владельческой модели: список
  -- тогда отдавался целиком, вместе с составом чужих аккаунтов и расписанием.
  user_id text,
  name    text not null,
  enabled boolean not null default true,
  module_key  text not null default '',
  -- §6: правило крепится к кампании; «голый» модуль — legacy. Не внешний ключ:
  -- удаление кампании не должно молча уносить правило, планировщик про это скажет.
  campaign_id text,
  -- Снимок настроек запуска. jsonb ОСОЗНАННО, как и у шаблонов модулей: набор полей
  -- свой у каждого модуля и осмыслен только целиком. Перечисления (аккаунты) вынесены
  -- строками — вот они как раз данные, которые считают и фильтруют.
  settings jsonb not null default '{}'::jsonb,
  -- Расписание разложено по колонкам, а не свалено в одно поле: типов всего три и
  -- полей у них по одному — прятать их в JSON значило бы прятать от базы проверку.
  schedule_type text not null default 'interval',
  schedule_at   bigint,                -- для 'once': когда именно
  schedule_interval_minutes integer,   -- для 'interval': шаг в минутах
  schedule_time text,                  -- для 'daily': 'ЧЧ:ММ'
  last_run    bigint,
  last_status text,
  last_task_id text,
  next_run    bigint,
  created_at  bigint not null,
  updated_at  bigint not null,
  constraint automation_rules_schedule_chk check (schedule_type in ('once','interval','daily'))
);

-- Аккаунты правила — отдельными строками. Ключ (правило, аккаунт) заодно не даёт
-- записать один аккаунт в правило дважды: он бы отработал по двойной норме.
create table if not exists automation_rule_accounts (
  rule_id    text not null references automation_rules(id) on delete cascade,
  account_id text not null,
  position   integer not null default 0,
  primary key (rule_id, account_id)
);

-- Планировщик на каждом тике ищет, чему пора запускаться.
create index if not exists automation_rules_due_idx   on automation_rules (next_run) where enabled;
create index if not exists automation_rules_owner_idx on automation_rules (user_id);
create index if not exists automation_rule_accounts_idx on automation_rule_accounts (rule_id, position);

-- Доступ только у бэкенда (сервисный ключ обходит RLS). Публичной политики нет намеренно:
-- по правилу видно состав аккаунтов клиента и его расписание.
alter table automation_rules         enable row level security;
alter table automation_rule_accounts enable row level security;

comment on table automation_rules is 'Правила автоматизации. Переехали из server/data/automation/rules.json (27.08, MR-186): у каждого инстанса был свой файл, и правило, выключенное на одном сервере, на другом продолжало запускаться.';
comment on column automation_rules.settings is 'Снимок настроек запуска целиком. jsonb осознанно: набор полей свой у каждого модуля. Аккаунты вынесены отдельной таблицей — их считают и фильтруют.';
