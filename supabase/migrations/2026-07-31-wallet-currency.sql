-- §11.4 (кол 31.07): различаем в журнале кошелька ДЕНЬГИ ($) и ТОКЕНЫ (⚡).
--
-- Раньше wallet_log хранил все движения одним числом `amount` без валюты, поэтому
-- пополнение долларов на баланс попадало в отчёт «Покупки» как токены — деньги и
-- топливо смешивались. Колонка `currency` разводит их: 'usd' — деньги, 'coins' — токены.
--
-- Аддитивно и идемпотентно. Старые строки получают 'coins' по умолчанию; известные
-- $-пополнения (по тексту причины) переносим в 'usd', чтобы история не врала.

alter table wallet_log add column if not exists currency text not null default 'coins';
create index if not exists wallet_log_currency_idx on wallet_log (currency);

-- Бэкфилл: положительные ДЕНЕЖНЫЕ пополнения баланса (не покупка токенов «за $X»,
-- у той причина начинается с «Куплено за» и это как раз токены).
update wallet_log
   set currency = 'usd'
 where currency = 'coins'
   and amount > 0
   and (reason ilike 'Пополнение $%' or reason ilike 'Тестовое пополнение%$%' or reason ilike '%пополнение $ из админ%');
