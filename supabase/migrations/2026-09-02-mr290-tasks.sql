-- MR-290, шаг 12: задачи модулей — в базу.
--
-- Самый большой пробел во всей схеме: ЯДРО ПЛАТФОРМЫ ХРАНИТСЯ ФАЙЛАМИ. Задача — это
-- `server/data/modules/<модуль>/tasks/<id>.json`, и внутри одного файла лежит всё сразу:
-- настройки запуска, прогресс, до 500 строк журнала, история, результаты, статистика по
-- аккаунтам и ключи выполненных действий. Таблицы задач не существует вовсе.
--
-- Чем это плохо, по порядку тяжести:
--
--   1. Второй экземпляр сервера видит ДРУГИЕ задачи. Правило владельца «другого способа
--      хранения быть не должно» нарушается ровно там, где цена ошибки выше всего: две
--      копии воркеров начнут выполнять одну и ту же работу дважды.
--   2. Дашборд читает ВСЕ файлы целиком на каждый запрос — включая журналы и результаты,
--      из которых показывается только счётчик ошибок. Отсюда и MR-254 про пагинацию:
--      страница задач не медленная, она читает мегабайты, чтобы показать десяток строк.
--   3. Каждая строка журнала — это перезапись всего файла (appendLog зовёт saveTask).
--      На задаче с сотней действий файл переписывается сотни раз.
--   4. Ни одного вопроса к задачам нельзя задать запросом: «сколько задач упало вчера»,
--      «на каких аккаунтах больше всего флудвейтов», «чьи задачи съели монеты» —
--      всё это сегодня решается чтением каталога и разбором json в памяти.
--
-- Разложение по таблицам следует форме данных, а не желанию всё нормализовать:
--
--   • `settings` остаётся jsonb ОСОЗНАННО. Набор полей свой у каждого из пятнадцати
--     модулей и осмыслен только целиком — раскладывать его по колонкам значило бы
--     завести таблицу с сотней всегда-пустых полей. Ровно тот же довод, что у
--     module_presets.settings и automation_rules.settings.
--   • Журнал, история, результаты и ключи действий — СТРОКАМИ. Их считают, фильтруют,
--     показывают постранично и дедуплицируют; это данные, а не снимок.
--   • Прогресс — колонками: три числа, по которым строят полосу и считают проценты.

create table if not exists tasks (
  id           text primary key,
  -- Модуль обязателен и обязан существовать: задача без модуля не запускается ничем.
  -- RESTRICT: пока есть задачи модуля, убрать его из справочника нельзя.
  module_key   text not null references modules(key) on delete restrict,
  status       text not null default 'queued',
  -- Кто запустил. `initiator` — подпись для журнала (может быть 'system'), `user_id` —
  -- владелец, по которому режется дашборд «свои задачи» (§8.1).
  initiator    text,
  user_id      text references profiles(legacy_id) on update cascade on delete set null,
  goal_id      text references goals(id) on delete set null,
  campaign_id  text references campaigns(id) on delete set null,
  settings     jsonb not null default '{}'::jsonb,
  progress_done    integer not null default 0,
  progress_total   integer not null default 0,
  progress_actions integer not null default 0,
  spent_coins  numeric(14,3) not null default 0,
  -- Флаги управления. Их выставляют ИЗВНЕ (кнопкой «Стоп», «Пауза»), и обычное сохранение
  -- воркера не должно их затирать — см. saveTask в server/lib/taskStore.js.
  stop_requested  boolean not null default false,
  pause_requested boolean not null default false,
  -- Задачу прервал перезапуск процесса: reconcileStaleTasksOnBoot ставит паузу с этой
  -- пометкой, resumeMarkedTasks поднимает её после согласования блокировок.
  resume_on_boot  boolean not null default false,
  -- Причина ПАДЕНИЯ, отдельно от последней строки журнала с ошибкой: у задачи бывают
  -- рабочие ошибки по отдельным аккаунтам, а в карточке нужно то, из-за чего она встала.
  fatal_error  text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  constraint tasks_status_chk check (status in ('queued', 'running', 'paused', 'done', 'error', 'stopped'))
);

create index if not exists tasks_module_created_idx on tasks (module_key, created_at desc);
create index if not exists tasks_status_idx         on tasks (status);
-- Дашборд показывает только активные — частичный индекс дешевле полного.
create index if not exists tasks_active_idx         on tasks (created_at desc) where status in ('queued', 'running', 'paused');
create index if not exists tasks_owner_idx          on tasks (user_id, created_at desc);
create index if not exists tasks_goal_idx           on tasks (goal_id);
create index if not exists tasks_campaign_idx       on tasks (campaign_id);

comment on table tasks is
  'Задачи модулей. Переехали из файлов server/data/modules/*/tasks/*.json (MR-290): ядро платформы хранилось на диске, второй инстанс видел другой набор задач, а дашборд читал все файлы целиком, чтобы показать десяток строк.';
comment on column tasks.settings is
  'Снимок настроек запуска целиком. jsonb осознанно: набор полей свой у каждого из пятнадцати модулей и осмыслен только целиком.';
comment on column tasks.resume_on_boot is
  'Задачу прервал перезапуск процесса (а не человек). Только такие поднимаются после старта: остановленные руками остаются остановленными.';

-- ─────────────────────────────────────────────────────────────
-- Журнал задачи
-- ─────────────────────────────────────────────────────────────
-- Строкой на запись, а не массивом в задаче: по журналу считают ошибки, ищут причину
-- остановки и показывают постранично. Раньше каждая строка означала перезапись всего
-- файла задачи целиком.
create table if not exists task_logs (
  task_id    text not null references tasks(id) on delete cascade,
  -- Идентификатор записи из кода. Пара с задачей делает вставку идемпотентной: повторное
  -- сохранение той же строки (перезапуск воркера, повтор миграции) ничего не дублирует.
  entry_id   text not null,
  -- Сквозной номер. У времени записи миллисекундная точность, и две строки в одну
  -- миллисекунду — обычное дело для быстрого цикла. Без номера «последняя строка
  -- журнала» становилась бы случайной, а по ней определяется «ждёт пополнения».
  seq        bigint generated always as identity,
  ts         timestamptz not null default now(),
  level      text not null,
  message    text not null default '',
  account_id text,
  module_key text,
  initiator  text,
  code       text,
  reason     text,
  primary key (task_id, entry_id),
  constraint task_logs_level_chk check (level in ('info', 'success', 'warning', 'error'))
);
create index if not exists task_logs_task_seq_idx on task_logs (task_id, seq desc);
-- «Где болит»: ошибки по задачам за период — теперь запрос, а не обход каталога.
create index if not exists task_logs_errors_idx on task_logs (task_id, seq desc) where level = 'error';

-- ─────────────────────────────────────────────────────────────
-- История и результаты
-- ─────────────────────────────────────────────────────────────
-- Форма payload своя у каждого модуля (у парсера это найденный канал, у комментинга —
-- отправленный комментарий), поэтому payload — jsonb. Но КАЖДАЯ ЗАПИСЬ — своя строка:
-- их считают, показывают постранично и выгружают. Это принципиально не то же самое, что
-- «сложить весь список в одно поле».
create table if not exists task_events (
  task_id  text not null references tasks(id) on delete cascade,
  -- Какой список: 'history' (что делала задача) или 'result' (что получилось).
  -- Имя поля приходит из кода: appendHistory(task, item, field).
  field    text not null,
  position integer not null,
  ts       timestamptz not null default now(),
  payload  jsonb not null default '{}'::jsonb,
  primary key (task_id, field, position)
);
create index if not exists task_events_task_idx on task_events (task_id, field, position desc);

-- ─────────────────────────────────────────────────────────────
-- Статистика по аккаунтам внутри задачи
-- ─────────────────────────────────────────────────────────────
-- Было `accountStats: { acc_1: { actions, floodWaits } }` внутри json. Вопрос «на каких
-- аккаунтах чаще всего ловим флудвейт» — прямой сигнал «упираемся в лимиты» — требовал
-- разбора всех файлов. Теперь это обычный запрос с группировкой.
create table if not exists task_account_stats (
  task_id     text not null references tasks(id) on delete cascade,
  account_id  text not null references accounts_meta(id) on delete cascade,
  actions     integer not null default 0,
  flood_waits integer not null default 0,
  data        jsonb not null default '{}'::jsonb,
  primary key (task_id, account_id)
);
create index if not exists task_account_stats_account_idx on task_account_stats (account_id);

-- ─────────────────────────────────────────────────────────────
-- Ключи выполненных действий (защита от повтора)
-- ─────────────────────────────────────────────────────────────
-- `task.actionKeys` — список того, что уже сделано, чтобы не сделать дважды. Хранился
-- массивом в json и рос вместе с задачей: файл переписывался целиком на каждое действие.
-- Первичный ключ даёт то же свойство «не дважды» уже на уровне базы.
create table if not exists task_action_keys (
  task_id text not null references tasks(id) on delete cascade,
  key     text not null,
  done_at timestamptz not null default now(),
  primary key (task_id, key)
);

comment on table task_action_keys is
  'Что задача уже сделала — чтобы не сделать повторно. Первичный ключ (задача, ключ) переносит защиту от дубля из памяти процесса в базу: переживает и перезапуск, и второй инстанс.';

-- ─────────────────────────────────────────────────────────────
-- Витрина списка задач
-- ─────────────────────────────────────────────────────────────
-- Дашборду на строку нужны четыре производные величины: сколько ошибок, последняя из них,
-- сколько поймали флудвейтов и не остановилась ли задача из-за монет. Раньше ради них
-- читались ВСЕ файлы задач целиком — со всеми журналами и результатами.
--
-- Считает база, а не приложение: иначе список снова превратился бы в запрос на задачу
-- (N+1), только теперь по сети. Представление, а не колонки-счётчики: счётчик пришлось бы
-- поддерживать при каждой записи, и он однажды разошёлся бы с журналом.
create or replace view task_list as
select
  t.*,
  coalesce(l.errors, 0)              as error_count,
  l.last_error,
  l.last_message,
  coalesce(s.flood_waits, 0)         as flood_waits
from tasks t
left join lateral (
  select
    count(*) filter (where level = 'error') as errors,
    (select message from task_logs e
      where e.task_id = t.id and e.level = 'error' order by e.seq desc limit 1) as last_error,
    -- Пауза «закончились монеты» отличается от паузы рукой: первую чинит пополнение.
    -- Смотрим ПОСЛЕДНЮЮ строку журнала, а не ищем фразу по всему — иначе строка возврата
    -- монет тоже считалась бы причиной остановки (так уже было).
    (select message from task_logs m
      where m.task_id = t.id order by m.seq desc limit 1) as last_message
  from task_logs where task_id = t.id
) l on true
left join lateral (
  select sum(flood_waits)::int as flood_waits from task_account_stats where task_id = t.id
) s on true;

comment on view task_list is
  'Список задач со счётчиками для дашборда: ошибки, последняя ошибка, последняя строка журнала (по ней видно «ждёт пополнения»), сумма флудвейтов. Считает база — иначе список снова стал бы чтением всех задач целиком.';

-- Представления не наследуют права таблиц: без явного гранта бэкенд получит отказ,
-- и выглядеть это будет как «нет такой таблицы».
grant select on task_list to service_role;
