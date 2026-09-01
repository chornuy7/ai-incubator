-- MR-290, шаг 13: время — везде timestamptz, а не epoch-миллисекунды в bigint.
--
-- В базе три способа записать момент времени одновременно: `timestamptz`, `bigint` с
-- миллисекундами и `text` в формате YYYY-MM. Это не вкусовщина, а вполне конкретные
-- потери:
--
--   • по bigint нельзя спросить «за прошлую неделю» — сравнение требует ручного
--     пересчёта в миллисекунды на каждой стороне запроса;
--   • в Table Editor и в любом отчёте вместо даты видно `1787588909052`, и понять, июль
--     это или сентябрь, нельзя;
--   • часовой пояс не хранится вовсе: число — это UTC по договорённости, а договорённость
--     нигде не записана;
--   • `date_trunc`, `age`, `interval` — весь инструмент работы со временем недоступен.
--
-- Здесь переводятся 26 колонок в 13 таблицах. Прокси приведены отдельной миграцией
-- (2026-09-01-mr290-proxies-rework.sql), задачи заведены сразу правильными.
--
-- ОТДЕЛЬНО ПРО НОЛЬ. В части колонок 0 означал не «полночь 1970 года», а «никогда»:
-- `rest_until = 0` — аккаунт не отдыхает, `read_user = 0` — обращение ещё не читали,
-- `last_action_at = 0` — действий не было. Ноль в этих колонках превращается в NULL, а
-- сами они становятся необязательными: «никогда» и «в начале эпохи» — разные вещи, и
-- смешивать их было ошибкой, из-за которой «отдыхает до 01.01.1970» выглядело осмысленно.

do $$
declare
  -- таблица, колонка, «ноль значит никогда»
  spec text[][] := array[
    ['account_activity', 'last_action_at', 'zero_is_null'],
    ['account_activity', 'rest_until',     'zero_is_null'],
    ['automation_rules', 'created_at',     'required'],
    ['automation_rules', 'updated_at',     'required'],
    ['automation_rules', 'last_run',       'optional'],
    ['automation_rules', 'next_run',       'optional'],
    ['automation_rules', 'schedule_at',    'optional'],
    ['kb_files',         'created_at',     'required'],
    ['knowledge_base',   'created_at',     'required'],
    ['knowledge_base',   'updated_at',     'required'],
    ['link_hits',        'ts',             'required'],
    ['module_presets',   'created_at',     'required'],
    ['parser_cache',     'updated_at',     'required'],
    ['parser_cache',     'last_run_at',    'optional'],
    ['parser_cache',     'next_run_at',    'optional'],
    ['payments',         'ts',             'required'],
    ['target_folders',   'created_at',     'required'],
    ['target_folders',   'updated_at',     'required'],
    ['ticket_messages',  'ts',             'required'],
    ['tickets',          'created_at',     'required'],
    ['tickets',          'updated_at',     'required'],
    ['tickets',          'read_user',      'zero_is_null'],
    ['tickets',          'read_support',   'zero_is_null'],
    ['tracked_links',    'created_at',     'required'],
    ['trust_cache',      'updated_at',     'required'],
    ['work_log',         'start_at',       'required'],
    ['work_log',         'end_at',         'optional']
  ];
  i int;
  t text; c text; mode text;
  current_type text;
begin
  for i in 1 .. array_length(spec, 1) loop
    t := spec[i][1]; c := spec[i][2]; mode := spec[i][3];

    -- Идемпотентность: колонка уже могла быть переведена (повторный прогон, чистая база).
    select data_type into current_type from information_schema.columns
      where table_schema = 'public' and table_name = t and column_name = c;
    if current_type is null then
      raise notice 'MR-290: нет колонки %.% — пропускаю', t, c;
      continue;
    end if;
    if current_type <> 'bigint' then continue; end if;

    -- Ноль как «никогда» должен стать NULL, а значит колонка обязана быть необязательной.
    if mode = 'zero_is_null' then
      execute format('alter table %I alter column %I drop not null', t, c);
      execute format('alter table %I alter column %I drop default', t, c);
    end if;

    execute format(
      'alter table %I alter column %I type timestamptz using (case '
      || 'when %I is null then null '
      || 'when %I = 0 then %s '
      || 'else to_timestamp(%I / 1000.0) end)',
      t, c, c, c,
      -- У обязательной колонки ноль заменяем на «сейчас»: потерять строку из-за кривого
      -- нуля хуже, чем получить приблизительную дату у единичной записи.
      case when mode = 'required' then 'now()' else 'null' end,
      c);

    if mode = 'required' then
      execute format('alter table %I alter column %I set not null', t, c);
      -- Даты создания и изменения дальше проставляет база сама.
      if c in ('created_at', 'updated_at') then
        execute format('alter table %I alter column %I set default now()', t, c);
      end if;
    end if;

    raise notice 'MR-290: %.% переведена в timestamptz (%)', t, c, mode;
  end loop;
end $$;

comment on column account_activity.rest_until is
  'До какого момента аккаунт отдыхает. NULL — не отдыхает. Раньше здесь был ноль, неотличимый от «полночь 1970 года» (MR-290).';
comment on column account_activity.last_action_at is
  'Момент последнего действия. NULL — действий ещё не было.';
comment on column tickets.read_user is
  'До какого момента переписку прочитал пользователь. NULL — не открывал ни разу.';
comment on column tickets.read_support is
  'До какого момента переписку прочитала поддержка. NULL — не открывала ни разу.';
comment on column work_log.end_at is
  'NULL — смена открыта. Незакрытую в отчёте ограничивают потолком смены (OPEN_SESSION_CAP_MS): человек не работает 98 часов подряд, это просто не нажатый выход.';

-- ─────────────────────────────────────────────────────────────
-- Месяц строкой — туда же
-- ─────────────────────────────────────────────────────────────
-- `subscriptions.last_credit_month` и `last_charge_month` хранят «YYYY-MM» текстом. Это
-- защита от повторного списания, и сравнение строк тут работает — но только пока формат
-- никто не нарушил. Ограничением закрепляем то, на что код и так полагается.
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'subscriptions_credit_month_chk') then
    alter table subscriptions add constraint subscriptions_credit_month_chk
      check (last_credit_month is null or last_credit_month ~ '^\d{4}-\d{2}$');
  end if;
  if not exists (select 1 from pg_constraint where conname = 'subscriptions_charge_month_chk') then
    alter table subscriptions add constraint subscriptions_charge_month_chk
      check (last_charge_month is null or last_charge_month ~ '^\d{4}-\d{2}$');
  end if;
end $$;
