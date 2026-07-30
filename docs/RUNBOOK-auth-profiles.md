# Runbook: переезд на Supabase Auth (`auth.users` + `profiles`)

> §11.3, пункт со звонка 29.07, который **нельзя выкатить без окна обслуживания**.
> Всё остальное из «правильной схемы» уже сделано и работает (см. TASKS-2026-07-29).

## Что просил заказчик

Дословно с созвона:

- «Не создавай папку users, потому что есть auth user, они будут путаться — тебе нужно
  создать таблицу **profile** вместо таблицы user».
- «Таблица profile ты **не держишь email** — email держится в аутентификационной таблице,
  которая называется **auth.users**».
- «User в этой базе данных — это именно аутентификационный user: email, пароль,
  двухфакторка. По сути четыре-пять строк».
- В Supabase Authentication **нет ни одного юзера** — «косяк», надо зарегистрировать себя
  и Илью заново.

## Почему это не выкатили вместе с остальным

Наша таблица `users` сейчас держит **и аутентификацию, и профиль**:

| Поле | Куда переедет |
|---|---|
| `email`, `password_hash` | `auth.users` (Supabase Auth) |
| `name`, `role_ids`, `active`, `parent_id`, `user_type_id` | `profiles` |

На `users.id` завязаны внешними ключами **все** данные: goals, campaigns, leads,
accounts_meta, parsed_channels, messages, coin_balance, subscriptions, wallet_log,
token_ledger, api_keys, bundles, roles. Смена типа/значения id — это перезапись всех FK.

Плюс вход перестаёт работать в момент переключения: пароли в `auth.users` не переносятся
из нашего `password_hash` (у Supabase свой формат) — людям надо **завести пароль заново**.

Поэтому: только по согласованному окну, а не «между делом».

## Порядок работ (окно ~1–2 часа)

1. **Бэкап.** Supabase → Database → Backups: убедиться, что свежий бэкап есть.
   Отдельно выгрузить `users` (email, name, role_ids, active, parent_id, user_type_id).
2. **Завести людей в Supabase Auth** (Authentication → Users → Add user): владелец, Илья,
   тестовые аккаунты. Пароли задаются здесь же — старые не переносятся.
3. **Создать `profiles`** (SQL ниже) и наполнить из текущей `users`, сопоставив по e-mail:
   `profiles.id` = `auth.users.id` (uuid), `profiles.legacy_id` = наш прежний `usr_…`.
4. **Перевести FK.** Два варианта:
   - **мягкий** (рекомендую): оставить в данных прежний текстовый `user_id`, а в `profiles`
     держать `legacy_id` — тогда ничего перекладывать не надо, а новые записи пишутся уже
     с новым id. Данные остаются связными через `profiles.legacy_id`;
   - **полный**: переписать `user_id` во всех 13 таблицах на новый uuid. Дольше и рискованнее.
5. **Переключить код** на Supabase Auth: вход/сессия через `supabase.auth`, `users.js`
   читает профиль из `profiles`, `password_hash` больше не используется.
6. **Проверить**: вход владельца, вход Ильи, доступ по ролям, баланс, журнал активности,
   что данные видны у своих владельцев.
7. **Откат**: вернуть прежнюю сборку (вход по `users.password_hash` продолжает работать,
   пока таблицу `users` не удалили). Поэтому `users` **не дропаем** минимум неделю.

## SQL заготовки (НЕ выполнять до окна)

```sql
-- profiles: профиль человека. Аутентификация — в auth.users, здесь её нет.
create table if not exists profiles (
  id           uuid primary key references auth.users(id) on delete cascade,
  legacy_id    text unique,                -- прежний usr_… чтобы не переписывать все FK
  name         text not null default '',
  active       boolean not null default true,
  parent_id    uuid references profiles(id) on delete set null,
  user_type_id bigint references user_types(id) on delete set null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

comment on table profiles is
  'Профиль пользователя. E-mail и пароль живут в auth.users — здесь их быть не должно.';

-- Наполнение из текущей users по совпадению e-mail с заведённым auth-юзером.
insert into profiles (id, legacy_id, name, active, created_at)
select a.id, u.id, u.name, u.active, u.created_at
from users u
join auth.users a on lower(a.email) = lower(u.email)
on conflict (id) do nothing;
```

## Что уже готово и не требует этого окна

- владелец записей (`user_id` + FK) во всех таблицах данных;
- `user_types` с UNIQUE + CHECK длины и паттерна на уровне БД;
- `users.user_type_id` — тип хранится **ссылкой**, а не текстом;
- `modules` + `user_type_modules` — права двумя референсами, пересобираются автоматически.
