-- MR-173 (созвон 19.08, Highest): подписки РЕЛЯЦИОННО, без JSON.
--
-- Было: subscriptions.modules — JSON-массив («огромная дырка»). Баги: докупка модуля
-- затирала весь набор (модули исчезали); оплаченный модуль можно оплатить повторно.
--
-- Стало: одна строка на (пользователь, модуль). Набор = множество строк. Докупка =
-- INSERT новых строк, existing не трогаем. Повторная оплата = строка уже есть (ON CONFLICT).
--
-- MR-150 (Шаг 2, связано): месячная выдача токенов. Поля billing_day (день оплаты, по нему
-- ежемесячно начисляем) + last_credit_month ('YYYY-MM', идемпотентность — не начислить дважды).

create table if not exists user_subscriptions (
  id bigserial primary key,
  -- '__workspace__' — общий набор пространства (раньше scope='workspace', user_id=null);
  -- иначе id профиля-владельца. Держим единым текстовым ключом ради unique(user_id,module_key).
  user_id text not null,
  module_key text not null,
  started_at timestamptz not null default now(),
  expires_at timestamptz,                 -- due: когда подписка на модуль истекает (null = период не задан)
  billing_day smallint,                   -- MR-150: день месяца оплаты (1..31), по нему начисляем токены
  last_credit_month text,                 -- MR-150: 'YYYY-MM' последнего месяца начисления (идемпотентность)
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, module_key)            -- один модуль у пользователя — одна запись (повторную оплату гасит ON CONFLICT)
);

create index if not exists user_subscriptions_user_idx on user_subscriptions(user_id);
create index if not exists user_subscriptions_due_idx on user_subscriptions(expires_at);
-- Для крона начисления: быстрый выбор «сегодня день оплаты, этот месяц ещё не начислен».
create index if not exists user_subscriptions_billing_idx on user_subscriptions(billing_day, last_credit_month);

-- RLS: пользователь видит свои подписки; пишет/начисляет только сервис (эндпоинты под service key).
alter table user_subscriptions enable row level security;
drop policy if exists user_subscriptions_read on user_subscriptions;
create policy user_subscriptions_read on user_subscriptions
  for select using (true);
