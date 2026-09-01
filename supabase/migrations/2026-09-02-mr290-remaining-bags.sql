-- MR-290, шаг 18: последние мешки — агент, расписание, кампания.
--
-- В проде эти три таблицы пусты, и соблазн отложить их велик. Откладывать нельзя ровно
-- поэтому: мешок, в котором пока нет данных, — это мешок, который наполнится уже после
-- задачи «привести базу в порядок», и разбирать его придётся с боевыми данными вместо
-- пустой таблицы. Дешевле сейчас.
--
-- ГДЕ JSON ОСТАЁТСЯ И ПОЧЕМУ. Не всякий json — ошибка. Настройки модуля, тело
-- отложенной кампании, ответ внешней системы — это данные, форма которых принадлежит не
-- базе: у каждого модуля свой набор параметров, и он меняется с каждой версией модуля.
-- Разложить их по колонкам значит менять схему при каждой правке настроек модуля.
-- Такие поля остаются jsonb сознательно — как `tasks.settings`, `module_presets.settings`
-- и `automation_rules.settings` до них. Разбираются только те мешки, где структура
-- ФИКСИРОВАНА и известна: они и есть записи, притворившиеся значениями.

-- ═════════════════════════════════════════════════════════════
-- 1. Агент: семь текстовых полей
-- ═════════════════════════════════════════════════════════════
-- Персона, от лица которой пишут модули. Все семь полей заданы в `normalizeAgent` с
-- конкретными пределами длины — то есть структура известна заранее и целиком.
alter table agents add column if not exists tone_of_voice       text;
alter table agents add column if not exists restrictions        text;
alter table agents add column if not exists character           text;
alter table agents add column if not exists language            text;
alter table agents add column if not exists audience            text;
alter table agents add column if not exists completion_criteria text;
alter table agents add column if not exists first_message       text;

comment on column agents.first_message is
  'Заготовки первого сообщения для холодного контакта; варианты разделены пустой строкой — воркер чередует их по кругу, чтобы Telegram не видел повтор.';
comment on column agents.completion_criteria is
  'По какому признаку разговор считается доведённым до конца — по нему классификатор решает, что человек «выполнил».';

update agents set
  tone_of_voice       = coalesce(nullif(data->>'toneOfVoice', ''), tone_of_voice),
  restrictions        = coalesce(nullif(data->>'restrictions', ''), restrictions),
  character           = coalesce(nullif(data->>'character', ''), character),
  language            = coalesce(nullif(data->>'language', ''), language),
  audience            = coalesce(nullif(data->>'audience', ''), audience),
  completion_criteria = coalesce(nullif(data->>'completionCriteria', ''), completion_criteria),
  first_message       = coalesce(nullif(data->>'firstMessage', ''), first_message)
where data is not null and jsonb_typeof(data) = 'object';

-- ═════════════════════════════════════════════════════════════
-- 2. Отложенная кампания: когда запустить и что вышло
-- ═════════════════════════════════════════════════════════════
-- `body` — параметры будущей кампании — остаётся json: это заявка, форма которой
-- принадлежит API кампаний, а не таблице расписаний. А вот «когда» и «что вышло» —
-- обычные поля, и по ним планировщик выбирает, что пора запускать.
alter table campaign_schedules add column if not exists run_at      timestamptz;
alter table campaign_schedules add column if not exists repeat      text;
alter table campaign_schedules add column if not exists enabled     boolean not null default true;
alter table campaign_schedules add column if not exists last_run_at timestamptz;
alter table campaign_schedules add column if not exists body        jsonb;
alter table campaign_schedules add column if not exists last_result jsonb;

comment on column campaign_schedules.body is
  'Параметры будущей кампании — заявка в том виде, в каком её принимает API кампаний. Остаётся json намеренно: её форма принадлежит API, а не этой таблице.';

update campaign_schedules set
  run_at      = coalesce(case when jsonb_typeof(data->'runAt') = 'number' and (data->>'runAt')::bigint > 0
                              then to_timestamp((data->>'runAt')::bigint / 1000.0) end, run_at),
  last_run_at = coalesce(case when jsonb_typeof(data->'lastRunAt') = 'number' and (data->>'lastRunAt')::bigint > 0
                              then to_timestamp((data->>'lastRunAt')::bigint / 1000.0) end, last_run_at),
  repeat      = coalesce(nullif(data->>'repeat', ''), repeat),
  enabled     = coalesce(case when jsonb_typeof(data->'enabled') = 'boolean' then (data->>'enabled')::boolean end, enabled),
  body        = coalesce(data->'body', body),
  last_result = coalesce(data->'lastResult', last_result)
where data is not null and jsonb_typeof(data) = 'object';

alter table campaign_schedules add constraint campaign_schedules_repeat_chk
  check (repeat is null or repeat in ('none', 'daily')) not valid;
alter table campaign_schedules validate constraint campaign_schedules_repeat_chk;

-- Планировщик спрашивает «что пора запускать» — это и есть его единственный запрос.
create index if not exists campaign_schedules_due_idx
  on campaign_schedules (run_at) where enabled and run_at is not null;

-- ═════════════════════════════════════════════════════════════
-- 3. Кампания: поля, аккаунты, цели, агенты по модулям
-- ═════════════════════════════════════════════════════════════
alter table campaigns add column if not exists module_key   text;
alter table campaigns add column if not exists status       text;
alter table campaigns add column if not exists pinned       boolean not null default true;
alter table campaigns add column if not exists chat_enabled boolean not null default false;

comment on column campaigns.chat_enabled is
  'Догоняющий чатинг: основной модуль приводит людей, neuro-dialogs ведёт с ответившими переписку к цели. Выключен по умолчанию.';

update campaigns set
  module_key   = coalesce(nullif(data->>'moduleKey', ''), module_key),
  status       = coalesce(nullif(data->>'status', ''), status),
  pinned       = coalesce(case when jsonb_typeof(data->'pinned') = 'boolean' then (data->>'pinned')::boolean end, pinned),
  chat_enabled = coalesce(case when jsonb_typeof(data #> '{chat,enabled}') = 'boolean' then (data #>> '{chat,enabled}')::boolean end, chat_enabled)
where data is not null and jsonb_typeof(data) = 'object';

alter table campaigns add constraint campaigns_status_chk
  check (status is null or status in ('draft', 'active', 'paused', 'done')) not valid;
alter table campaigns validate constraint campaigns_status_chk;

-- Закреплённые аккаунты. Это НАСТОЯЩАЯ связь: аккаунт удалили — он должен уйти и из
-- кампании, а не остаться идентификатором, который ничего не находит. Раньше держался
-- массивом в мешке, и удаление аккаунта такие закрепления не трогало вовсе.
create table if not exists campaign_accounts (
  campaign_id text not null references campaigns(id)     on delete cascade,
  account_id  text not null references accounts_meta(id) on delete cascade,
  position    int  not null default 0,
  primary key (campaign_id, account_id)
);

comment on table campaign_accounts is
  'MR-290: аккаунты, закреплённые за кампанией (было campaigns.data.accountIds). Удаление аккаунта снимает закрепление само.';

create index if not exists campaign_accounts_account_idx on campaign_accounts (account_id);

insert into campaign_accounts (campaign_id, account_id, position)
select c.id, k.value #>> '{}', k.ord - 1
  from campaigns c, lateral jsonb_array_elements(coalesce(c.data->'accountIds', '[]'::jsonb)) with ordinality as k(value, ord)
 where k.value #>> '{}' in (select id from accounts_meta)
on conflict do nothing;

-- Целевые каналы кампании. Внешнего ключа на `channels` тут НЕТ и быть не может: цель
-- задают именем (`@durov`), и канала может ещё не быть в базе — его туда приносит
-- парсер уже во время работы. Ключ означал бы «нельзя задать цель, которую мы ещё не
-- видели», то есть запрет на обычный сценарий.
create table if not exists campaign_targets (
  campaign_id text not null references campaigns(id) on delete cascade,
  target      text not null check (target <> ''),
  position    int  not null default 0,
  primary key (campaign_id, target)
);

comment on table campaign_targets is
  'MR-290: целевые каналы кампании по имени (было campaigns.data.targets). Имя, а не ссылка на channels: канала может ещё не быть в базе.';

insert into campaign_targets (campaign_id, target, position)
select c.id, k.value #>> '{}', k.ord - 1
  from campaigns c, lateral jsonb_array_elements(coalesce(c.data->'targets', '[]'::jsonb)) with ordinality as k(value, ord)
 where nullif(k.value #>> '{}', '') is not null
on conflict do nothing;

-- Какой агент ведёт какой модуль. Две настоящие ссылки в одной строке: и модуль, и
-- агент существуют в своих таблицах, а раньше это была карта «строка → строка», где
-- удалённый агент оставался закреплён за модулем и молча не находился при запуске.
create table if not exists campaign_module_agents (
  campaign_id text   not null references campaigns(id) on delete cascade,
  module_id   bigint not null references modules(id)   on delete cascade,
  agent_id    text   not null references agents(id)    on delete cascade,
  primary key (campaign_id, module_id)
);

comment on table campaign_module_agents is
  'MR-290: какой агент ведёт какой модуль кампании (было campaigns.data.moduleAgents). Удаление агента снимает закрепление — до этого оно оставалось и молча не находилось при запуске.';

create index if not exists campaign_module_agents_agent_idx on campaign_module_agents (agent_id);

insert into campaign_module_agents (campaign_id, module_id, agent_id)
select c.id, m.id, v.value #>> '{}'
  from campaigns c, lateral jsonb_each(coalesce(c.data->'moduleAgents', '{}'::jsonb)) v
  join modules m on m.key = v.key
 where jsonb_typeof(v.value) = 'string'
   and v.value #>> '{}' in (select id from agents)
on conflict do nothing;

alter table campaign_accounts      enable row level security;
alter table campaign_targets       enable row level security;
alter table campaign_module_agents enable row level security;

grant select, insert, update, delete on campaign_accounts      to service_role;
grant select, insert, update, delete on campaign_targets       to service_role;
grant select, insert, update, delete on campaign_module_agents to service_role;
