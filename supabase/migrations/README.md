# Миграции Supabase

Порядок применения на **чистой** базе (в SQL Editor выполнять сверху вниз). На боевой
`murmex/main` все они уже применены 30.07.2026 — этот список нужен для нового окружения
или пересборки.

Все миграции **аддитивные и идемпотентные** (`if not exists`): повтор не ломает данные.

| # | Файл | Что добавляет | Требование |
|---|------|---------------|-----------|
| 1 | `price-periods.sql` | `price_overrides.periods` | §11.2 периоды подписки |
| 2 | `owner-and-types.sql` | `user_id` в goals/campaigns/leads/parsed_channels/accounts_meta; `user_types`, `modules`, `user_type_modules`; `users.user_type_id` | §11.3 владелец + типы + права |
| 3 | `usd-wallet.sql` | `coin_balance.usd` | §11.4 деньги отдельно от токенов |
| 4 | `messages.sql` | `messages` | §11.1 переписка целиком |
| 5 | `owner-rest.sql` | `user_id` в bundles, roles | §11.3 (добивка) |
| 6 | `module-links.sql` | `module_prices`, `subscription_modules`, `bundle_modules`, `campaign_modules` | §11.3 модули ссылками |
| 7 | `remaining-stores.sql` | `channels`, `account_groups`, `account_activity`, `campaign_schedules`, `agents`, `app_settings` | §10.2 всё из БД |
| 8 | `owner-stores.sql` | `user_id` в channels, account_groups, campaign_schedules | §11.3 (финальный аудит) |
| 9 | `profiles.sql` | `profiles` (пустая) | §11.3 auth/profile |
| 10 | `profiles-trigger.sql` | триггер `on_auth_user_created` | §11.3 профиль создаётся сам |

## После миграций — наполнение данными

На новом окружении, после SQL:

```bash
# 1. Данные сторов из файлов → Supabase (идемпотентно; журналы заливает только в пустую таблицу)
node --env-file=.env scripts/migrate-to-supabase.mjs

# 2. Типы, модули, права и связи модулей из ролей и прайса
#    (в приложении — кнопкой POST /api/admin/sync-types; либо ниже вручную)

# 3. profiles из users — ПОСЛЕ того, как люди заведены в Supabase Auth
node --env-file=.env scripts/fill-profiles.mjs
```

## Что НЕ автоматизируется (действие человека)

- Завести пользователей в **Supabase Auth** (Authentication → Users, или приглашением
  через `POST /api/admin/provision-auth`). Пароли задаёт человек — через нас и логи они
  не проходят.
- Переключение входа на `supabase.auth` — по окну (см. `docs/RUNBOOK-auth-profiles.md`).
