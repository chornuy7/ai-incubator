-- MR-290, шаг 16: оставшиеся мешки json — колонками и строками.
--
-- Три разных мешка, одна и та же болезнь: структура известна и постоянна, но лежит
-- значением, которое база не проверяет. Ни типа, ни диапазона, ни ссылки — только текст,
-- который приложение договорилось понимать одинаково. Пока договорённость держится, всё
-- работает; расходится она молча.
--
-- Ни одна старая колонка здесь НЕ УДАЛЯЕТСЯ: миграции применяются до выката кода, и в
-- промежутке данные читает предыдущая версия. Снос — следующим выпуском.

-- ═════════════════════════════════════════════════════════════
-- 1. Усталость аккаунта: account_activity.data
-- ═════════════════════════════════════════════════════════════
-- В мешке лежал `profile` — три числа, которыми задан режим отдыха. И там же нашлась
-- причина завести им колонки: одно и то же поле записано ДВУМЯ способами. У шести
-- аккаунтов `recoveryPerHour` (сколько единиц уходит за час), у пяти `recoveryEveryMs`
-- (за сколько уходит одна единица) — старая и новая форма одной величины. Приложение
-- сводит их на чтении, но пока они лежат рядом, любой отчёт мимо приложения посчитает
-- неправильно, а второе поле однажды забудут обновить.

alter table account_activity add column if not exists fatigue_threshold int;
alter table account_activity add column if not exists rest_minutes      int;
alter table account_activity add column if not exists recovery_every_ms bigint;

comment on column account_activity.fatigue_threshold is
  'Сколько действий подряд аккаунт выдерживает до отдыха. NULL — режим по умолчанию.';
comment on column account_activity.recovery_every_ms is
  'За какое время простоя уходит одна единица усталости. 0 — восстановление выключено. Раньше та же величина писалась ещё и как recoveryPerHour (единиц в час) — теперь форма одна (MR-290).';

alter table account_activity
  add constraint account_activity_threshold_chk
  check (fatigue_threshold is null or fatigue_threshold between 1 and 500) not valid;
alter table account_activity
  add constraint account_activity_rest_chk
  check (rest_minutes is null or rest_minutes between 1 and 1440) not valid;
alter table account_activity
  add constraint account_activity_recovery_chk
  check (recovery_every_ms is null or recovery_every_ms between 0 and 86400000) not valid;

update account_activity set
  fatigue_threshold = coalesce(nullif(data #>> '{profile,threshold}', '')::int, fatigue_threshold),
  rest_minutes      = coalesce(nullif(data #>> '{profile,restMinutes}', '')::int, rest_minutes),
  -- Две формы сводятся к одной ЗДЕСЬ, а не при каждом чтении. Старое поле идёт первым:
  -- если заданы оба, явно выставленное «единиц в час» и есть настоящее значение, а
  -- recoveryEveryMs могло приехать из умолчаний при слиянии профиля.
  recovery_every_ms = coalesce(
    case
      when nullif(data #>> '{profile,recoveryPerHour}', '') is not null then
        case when (data #>> '{profile,recoveryPerHour}')::numeric > 0
             then round(3600000 / (data #>> '{profile,recoveryPerHour}')::numeric)
             else 0 end
      when nullif(data #>> '{profile,recoveryEveryMs}', '') is not null then
        (data #>> '{profile,recoveryEveryMs}')::bigint
    end, recovery_every_ms)
where data is not null and data ? 'profile';

alter table account_activity validate constraint account_activity_threshold_chk;
alter table account_activity validate constraint account_activity_rest_chk;
alter table account_activity validate constraint account_activity_recovery_chk;

-- Распорядок дня: вероятность привлечения по часам. Двадцать четыре числа — это таблица,
-- а не значение. В мешке ни час 25, ни вероятность 5 никто бы не отверг; здесь отвергнет
-- ограничение, и «аккаунт активен на 500%» просто не запишется.
create table if not exists account_schedules (
  account_id  text not null references accounts_meta(id) on delete cascade,
  hour        int  not null check (hour between 0 and 23),
  probability numeric not null check (probability >= 0 and probability <= 1),
  primary key (account_id, hour)
);

comment on table account_schedules is
  'MR-290: распорядок дня аккаунта по часам (было account_activity.data.schedule). Вероятность 0..1; час 0..23 — проверяет база, а не приложение.';

insert into account_schedules (account_id, hour, probability)
select a.account_id, k.key::int, k.value::numeric
  from account_activity a, lateral jsonb_each_text(coalesce(a.data->'schedule', '{}'::jsonb)) k(key, value)
 where a.account_id in (select id from accounts_meta)
   and k.key ~ '^\d{1,2}$' and k.key::int between 0 and 23
   and k.value ~ '^\d+(\.\d+)?$' and k.value::numeric between 0 and 1
on conflict do nothing;

-- ═════════════════════════════════════════════════════════════
-- 2. Цель: goals.data
-- ═════════════════════════════════════════════════════════════
-- Пять полей, все пять есть у всех целей. Два из них — вложенные объекты `metric` и
-- `period`, но и они фиксированы: вид метрики, цель, единица; режим периода и дата начала.
-- Ничего открытого здесь нет — обычная запись.
alter table goals add column if not exists description   text;
alter table goals add column if not exists status        text;
alter table goals add column if not exists priority      text;
alter table goals add column if not exists metric_kind   text;
alter table goals add column if not exists metric_target numeric;
alter table goals add column if not exists metric_unit   text;
alter table goals add column if not exists period_mode   text;
alter table goals add column if not exists period_from   date;

comment on column goals.period_from is
  'С какой даты считать результат. NULL при period_mode=''all'' — считаем за всё время.';

update goals set
  description   = coalesce(nullif(data->>'description', ''), description),
  status        = coalesce(nullif(data->>'status', ''), status),
  priority      = coalesce(nullif(data->>'priority', ''), priority),
  metric_kind   = coalesce(nullif(data #>> '{metric,kind}', ''), metric_kind),
  metric_unit   = coalesce(nullif(data #>> '{metric,unit}', ''), metric_unit),
  metric_target = coalesce(case when jsonb_typeof(data #> '{metric,target}') = 'number'
                                then (data #>> '{metric,target}')::numeric end, metric_target),
  period_mode   = coalesce(nullif(data #>> '{period,mode}', ''), period_mode),
  -- Дата приходит строкой 'YYYY-MM-DD'. Мусор в ней превращаем в NULL, а не роняем
  -- миграцию: одна кривая дата не повод оставить всю таблицу в json.
  period_from   = coalesce(case when data #>> '{period,from}' ~ '^\d{4}-\d{2}-\d{2}$'
                                then (data #>> '{period,from}')::date end, period_from)
where data is not null and jsonb_typeof(data) = 'object';

-- Ограничения ставим ПОСЛЕ переноса и только на непустые значения: цель, заведённая до
-- появления статусов, не должна мешать выкату.
alter table goals add constraint goals_status_chk
  check (status is null or status in ('active', 'paused', 'done', 'archived')) not valid;
alter table goals add constraint goals_period_mode_chk
  check (period_mode is null or period_mode in ('all', 'from')) not valid;
alter table goals validate constraint goals_status_chk;
alter table goals validate constraint goals_period_mode_chk;

-- ═════════════════════════════════════════════════════════════
-- 3. Прайс: price_overrides.modules / coin_packs / periods
-- ═════════════════════════════════════════════════════════════
-- Это КАТАЛОГИ, сложенные в три ячейки одной строки. Пакет монет, период подписки,
-- правка цены модуля — каждая из этих вещей имеет свои поля и свои допустимые значения,
-- и ни одно из них база не проверяла. Скидка 500%, пакет на минус сто монет, правка цены
-- у несуществующего модуля — всё это записалось бы молча.

create table if not exists module_price_overrides (
  module_id    bigint primary key references modules(id) on delete cascade,
  month_price  numeric check (month_price  is null or month_price  >= 0),
  action_price numeric check (action_price is null or action_price >= 0),
  gift_tokens  numeric check (gift_tokens  is null or gift_tokens  >= 0),
  updated_at   timestamptz not null default now()
);

comment on table module_price_overrides is
  'MR-290: правки цен модулей из админки (было price_overrides.modules). NULL в поле — правки нет, действует базовая цена. Не путать с module_prices — там ДЕЙСТВУЮЩАЯ цена, проекция для отчётов.';

insert into module_price_overrides (module_id, month_price, action_price, gift_tokens)
select m.id,
       case when jsonb_typeof(v.value->'month')  = 'number' then (v.value->>'month')::numeric  end,
       case when jsonb_typeof(v.value->'action') = 'number' then (v.value->>'action')::numeric end,
       case when jsonb_typeof(v.value->'gift')   = 'number' then (v.value->>'gift')::numeric   end
  from price_overrides p, lateral jsonb_each(coalesce(p.modules, '{}'::jsonb)) v(key, value)
  join modules m on m.key = v.key
 where p.id = 'default'
on conflict (module_id) do nothing;

create table if not exists coin_packs (
  position int primary key,
  coins    numeric not null check (coins > 0),
  price    numeric not null check (price >= 0),
  best     boolean not null default false
);

comment on table coin_packs is
  'MR-290: пакеты монет для покупки (было price_overrides.coin_packs). position задаёт порядок в витрине.';

insert into coin_packs (position, coins, price, best)
select k.ord - 1, (k.value->>'coins')::numeric, (k.value->>'price')::numeric,
       coalesce((k.value->>'best')::boolean, false)
  from price_overrides p, lateral jsonb_array_elements(coalesce(p.coin_packs, '[]'::jsonb)) with ordinality as k(value, ord)
 where p.id = 'default'
   and jsonb_typeof(k.value->'coins') = 'number' and (k.value->>'coins')::numeric > 0
   and jsonb_typeof(k.value->'price') = 'number'
on conflict (position) do nothing;

create table if not exists subscription_periods (
  position int primary key,
  unit     text not null check (unit in ('week', 'month', 'year')),
  count    int  not null check (count >= 1),
  discount numeric not null default 0 check (discount >= 0 and discount <= 0.9)
);

comment on table subscription_periods is
  'MR-290: периоды подписки со скидками (было price_overrides.periods). Пределы количества по единице (нед. 1–4, мес. 1–6, год 1–5) остаются в коде: они продуктовые и меняются чаще схемы.';

insert into subscription_periods (position, unit, count, discount)
select k.ord - 1, k.value->>'unit', (k.value->>'count')::int,
       coalesce((k.value->>'discount')::numeric, 0)
  from price_overrides p, lateral jsonb_array_elements(coalesce(p.periods, '[]'::jsonb)) with ordinality as k(value, ord)
 where p.id = 'default'
   and k.value->>'unit' in ('week', 'month', 'year')
   and jsonb_typeof(k.value->'count') = 'number' and (k.value->>'count')::int >= 1
   and coalesce((k.value->>'discount')::numeric, 0) between 0 and 0.9
on conflict (position) do nothing;

alter table account_schedules      enable row level security;
alter table module_price_overrides enable row level security;
alter table coin_packs             enable row level security;
alter table subscription_periods   enable row level security;

grant select, insert, update, delete on account_schedules      to service_role;
grant select, insert, update, delete on module_price_overrides to service_role;
grant select, insert, update, delete on coin_packs             to service_role;
grant select, insert, update, delete on subscription_periods   to service_role;
