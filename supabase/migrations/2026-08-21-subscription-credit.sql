-- MR-150 (Шаг 2) на модели владельца от 21.08: подписка ОДНА и с одной датой, поэтому
-- ежемесячное начисление токенов вешаем на неё же, а не на помодульные строки.
--   billing_day       — день месяца, в который оплатили (по нему начисляем каждый месяц);
--   last_credit_month — 'YYYY-MM' последнего начисления (идемпотентность крона).
alter table subscriptions add column if not exists billing_day smallint;
alter table subscriptions add column if not exists last_credit_month text;
create index if not exists subscriptions_billing_idx on subscriptions(billing_day, last_credit_month);

-- Помодульные подписки (user_subscriptions) больше не нужны: у подписки одна дата на всех.
drop table if exists user_subscriptions;
