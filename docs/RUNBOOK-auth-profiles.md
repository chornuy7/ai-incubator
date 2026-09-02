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

## Что уже готово (подготовка 30.07)

- ☑ миграция `2026-07-30-profiles.sql` — создаёт пустую `profiles`. Безопасна: ничего не
  переключает, вход продолжает идти через `users`;
- ☑ скрипт `scripts/fill-profiles.mjs` — наполняет `profiles` из `users`, сопоставляя по
  e-mail с `auth.users`. Идемпотентный, ничего не удаляет. Пока в Auth пусто — честно
  сообщает об этом и не трогает данные (проверено);
- ☑ переключение чтения профиля на `profiles` и вход через `supabase.auth` — СДЕЛАНО
  (`users.js`: операторы читаются из `profiles`, `authenticateSupabase`; вход двухрежимный,
  legacy-пароль пока как fallback);
- ☑ FK 11 таблиц переведены на `profiles(legacy_id)` (этап 3/4, 2026-07-31, применено на бою).

## Готовность к этапу 4 (drop users) — проверено 03.08

- ☑ **Данные согласованы** (read-only проверка 03.08): `users=2, profiles=2, auth.users=2`,
  **0 юзеров без профиля, 0 без учётки в Auth**. Предусловие drop выполнено: ни один FK
  больше не ссылается на `public.users`.
- ☑ **Черновик миграции готов:** `supabase/migrations/2026-08-03-drop-users-stage4.sql`
  (с guard'ом — НЕ применять до окна; вариант А — обратимая переименовка на неделю).
- ☑ **Код этапа 4 сделан (03.08):** dual-write в `users` снят (create/update/deleteUser),
  вход — только через Supabase Auth. Legacy scrypt-вход оставался под аварийным флагом
  env `AUTH_ALLOW_LEGACY=1`. Полный сет тестов — 566/566, tsc чисто.
- ☑ **Этап 5 закрыт (02.09, MR-290): таблицы `users` и `user_roles` СНЕСЕНЫ.**

  Дроп от 03.08 до боевой базы не доехал — таблица там осталась и была замечена аудитом
  MR-290. На момент сноса в ней было 2 строки (`usr_admin`, `usr_test`) против 89 в
  `profiles`; в `user_roles` — 2 против 66 в `profile_roles`, и её не читал никто.

  Вместе с таблицей убран **аварийный рычаг `AUTH_ALLOW_LEGACY`**: он читал
  `users.password_hash` и страховал ровно эти два аккаунта, оба e-mail которых есть в
  Supabase Auth. Рычага больше нет — если кто-то не может войти, чинить надо пароль в
  Auth, других путей не осталось.

  Миграция: `supabase/migrations/2026-09-02-mr290-drop-users.sql`.

Из-за этого окно сократилось: остаётся завести людей в Auth, прогнать скрипт и переключить
код, а не проектировать всё с нуля.

## Порядок работ (окно ~20–30 минут)

1. **Бэкап.** Supabase → Database → Backups: убедиться, что свежий бэкап есть.
2. **Завести людей в Supabase Auth** (Authentication → Users → Add user): владелец, Илья,
   тестовые аккаунты. Пароли задаются здесь же — старые не переносятся.
   *Это единственный шаг, который делает человек: создание учётных записей и ввод паролей.*
3. **Наполнить `profiles`**: `node --env-file=.env scripts/fill-profiles.mjs`
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
