# Supabase — подключение и миграция (§10.2)

## Что уже сделано

- Проект `murmex` создан (West Europe / London, Free).
- URL проекта: `https://okrdzgwvckrnmhzkxerw.supabase.co`
- Схема БД: [`schema.sql`](./schema.sql) — таблицы под наши данные + RLS.

## Шаги (по порядку)

### 1. Применить схему

Supabase → слева **SQL Editor** → **New query** → вставить весь `schema.sql` → **Run**.
Скрипт идемпотентный (`IF NOT EXISTS`), можно прогонять повторно без вреда.

Проверить: слева **Table Editor** — должны появиться таблицы `users`, `coin_balance`,
`subscriptions`, `price_overrides`, `bundles`, `wallet_log`, `token_ledger`,
`api_keys`, `goals`, `campaigns`, `leads`, `accounts_meta`, `parsed_channels`.

### 2. Дать бэкенду доступ (креденшлы — ЛОКАЛЬНО, не в git и не в чат)

Supabase → **Project Settings → API**:

- **Project URL** — можно прислать в чат (полупубличный).
- **anon public** — можно прислать (для клиента).
- **service_role** — ⚠️ СЕКРЕТ, полный доступ. НЕ в чат, НЕ в git.
- Supabase → **Project Settings → Database** → **Connection string** (пароль БД) —
  тоже секрет.

Положить в файл `.env` в корне проекта (он в `.gitignore`):

```
SUPABASE_URL=https://okrdzgwvckrnmhzkxerw.supabase.co
SUPABASE_SERVICE_ROLE=eyJ...          # секрет
DATA_BACKEND=supabase                 # переключатель: файлы → БД
```

### 3. Мигрировать данные

Когда `.env` заполнен — запустить (скрипт напишу следующим шагом):

```
npm run migrate:supabase
```

Он зальёт текущие `server/data/*.json` в таблицы (users, balance, prices, bundles,
журналы, goals/campaigns/leads, accounts). Идемпотентно (upsert по id).

### 4. Переключить сторы

`DATA_BACKEND=supabase` — сторы (`priceStore`, `balance`, `bundles`, `apiKeys`,
журналы) читают/пишут в Supabase вместо файлов. Без переменной — как сейчас, файлы.
Тесты гоняются на файлах (изоляция), поэтому не ломаются.

## Не забыть

- **Оплатить** проект после запуска: Free встаёт на паузу через 2 недели неактивности.
- **Storage**: bucket только под файлы (сессии аккаунтов, картинки/видео), текст — в
  таблицы. Настроим при переносе сессий.
- **Auth/OTP/капча** (§10.2) — отдельный этап после переноса данных.

## Решения, которые ждут (§10.2)

- **Как ходит бэкенд:** через `@supabase/supabase-js` (service_role, REST/Data API)
  или напрямую Postgres (`pg` + connection string). По умолчанию возьму supabase-js —
  проще, ретраи и пулинг из коробки; на прямой Postgres перейдём, если упрёмся в
  лимиты Data API.
- **Supabase MCP** — если хотите, чтобы я управлял базой напрямую из чата (миграции,
  правки схемы). Даёт мне доступ к БД; включается отдельно, для старта не нужно.
