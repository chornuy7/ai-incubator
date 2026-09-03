-- §11.9 / безопасность (31.07): включаем Row Level Security на ВСЕХ таблицах public.
--
-- ЗАЧЕМ. У проекта есть публикуемый (anon) ключ. Пока RLS выключен, любой, кто знает
-- этот ключ и адрес проекта, может читать/писать таблицы напрямую через PostgREST в
-- обход нашего Node-слоя (роли §8.1, владелец §11.3 — всё мимо). Это открытая дверь.
--
-- ПОЧЕМУ БЕЗ ПОЛИТИК = DENY-ALL. Мы намеренно НЕ добавляем policy: весь доступ к данным
-- идёт через бэкенд с SERVICE-ключом (service_role), а он RLS ОБХОДИТ. Триггер
-- handle_new_auth_user — security definer, тоже обходит. Фронт в Supabase напрямую не
-- ходит (клиентского supabase-клиента нет). Значит anon/authenticated получают ноль —
-- ровно то, что нужно: снаружи закрыто, бэкенд работает как раньше.
--
-- БЕЗОПАСНО и обратимо: если позже понадобится прямой доступ (напр. клиентская
-- set-password страница), добавим точечные policy. Пока — глухая стена.
--
-- Как применить: Supabase → SQL Editor → выполнить этот файл. Идемпотентно.

alter table users               enable row level security;
alter table profiles            enable row level security;
alter table coin_balance        enable row level security;
alter table wallet_log          enable row level security;
alter table token_ledger        enable row level security;
alter table subscriptions       enable row level security;
alter table api_keys            enable row level security;
alter table roles               enable row level security;
alter table bundles             enable row level security;
alter table goals               enable row level security;
alter table campaigns           enable row level security;
alter table leads               enable row level security;
alter table parsed_channels     enable row level security;
alter table accounts_meta       enable row level security;
alter table messages            enable row level security;
alter table user_types          enable row level security;
alter table modules             enable row level security;
alter table user_type_modules   enable row level security;
alter table module_prices       enable row level security;
alter table subscription_modules enable row level security;
alter table bundle_modules      enable row level security;
alter table campaign_modules    enable row level security;
alter table channels            enable row level security;
alter table account_groups      enable row level security;
alter table account_activity    enable row level security;
alter table campaign_schedules  enable row level security;
alter table agents              enable row level security;
alter table app_settings        enable row level security;
alter table price_overrides     enable row level security;
