-- §5.1: БАЗА ОПЛАТ переезжает из локального SQLite в общую БД.
--
-- Зачем. Это витрина для чтения (диапазоны дат, страницы) поверх источников правды —
-- журнала кошелька и аудита. На проде источник (`wallet_log`) УЖЕ лежит в этой базе,
-- поэтому выходило так: тянем сто тысяч строк из Postgres в файл на диске, чтобы делать
-- по ним запросы, которые Postgres делает сам и лучше. Плюс файл жил на диске одной
-- машины: второй инстанс — вторая копия витрины со своими цифрами.
--
-- Витрина остаётся ВИТРИНОЙ: она пересобирается из журналов (`syncPayments`), деньги
-- считаются не здесь. Правила «что считать доходом» (§3.2/MR-22: подарочные токены не
-- доход, покупка токенов — доход) остаются в одном месте, в server/payments.js, чтобы
-- они не разъехались между JS и SQL.

create table if not exists payments (
  id           text primary key,        -- синтетический ключ строки журнала (идемпотентная пересборка)
  ts           bigint not null,         -- когда (мс)
  user_id      text,
  kind         text,                    -- 'usd' | 'coins' | 'grant' | 'plan'
  coins        numeric,                 -- начислено ⚡ (для 'coins'/'grant')
  amount_fiat  numeric,                 -- сумма в валюте (для 'plan'/'usd')
  currency     text,                    -- '⚡' | '$'
  modules      integer,                 -- число модулей в плане (-1 = все)
  status       text,                    -- 'paid' | (в будущем) 'pending'|'failed'|'refunded'
  reason       text
);

create index if not exists payments_ts_idx      on payments (ts desc);
create index if not exists payments_user_idx    on payments (user_id);
create index if not exists payments_kind_ts_idx on payments (kind, ts desc);

-- Служебная витрина: ходит только бэкенд сервисным ключом (он обходит RLS).
alter table payments enable row level security;

comment on table payments is '§5.1: витрина оплат для админки (диапазоны дат + страницы). Проекция журнала кошелька и аудита, пересобирается идемпотентно через syncPayments(). Не источник правды и не второй кошелёк.';
