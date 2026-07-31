-- §10.2 (оптимизация 31.07): индексы под ГОРЯЧИЕ запросы. Postgres НЕ индексирует
-- внешние ключи автоматически, а мы часто фильтруем/сортируем по ним — без индекса
-- это full-scan, который растёт вместе с данными.
--
-- Аддитивно и идемпотентно (if not exists). Только чтение ускоряется, схема не меняется.
-- Как применить: Supabase → SQL Editor → выполнить этот файл.

-- ── Журнал кошелька: walletHistory сортирует по ts и фильтрует по user_id ─────────
-- Читается отчётами «Покупки», историей кошелька и ПЕРЕСБОРКОЙ «Базы оплат» (до 100k строк).
create index if not exists wallet_log_ts_idx      on wallet_log (ts desc);
create index if not exists wallet_log_user_ts_idx on wallet_log (user_id, ts desc);

-- ── Журнал токенов ИИ: readLedger сортирует по ts, фильтрует по account/task/module/since ─
create index if not exists token_ledger_ts_idx      on token_ledger (ts desc);
create index if not exists token_ledger_account_idx on token_ledger (account_id);
create index if not exists token_ledger_task_idx    on token_ledger (task_id);
create index if not exists token_ledger_module_idx  on token_ledger (module);

-- ── Вложенность юзеров (кто чей суб-юзер): показ иерархии и осиротение при удалении ──
create index if not exists users_parent_id_idx    on users (parent_id);
create index if not exists profiles_parent_id_idx on profiles (parent_id);

-- ── Обратные ссылки в join-таблицах (по module_id) ──────────────────────────────
-- Composite PK покрывает только ЛЕВЫЙ столбец; выборка «в какие подписки/наборы/
-- кампании/типы входит модуль X» без этих индексов шла бы full-scan.
create index if not exists user_type_modules_module_idx   on user_type_modules (module_id);
create index if not exists subscription_modules_module_idx on subscription_modules (module_id);
create index if not exists bundle_modules_module_idx       on bundle_modules (module_id);
create index if not exists campaign_modules_module_idx     on campaign_modules (module_id);

-- ── Подписки по владельцу (личные наборы клиента) ───────────────────────────────
create index if not exists subscriptions_user_id_idx on subscriptions (user_id);
