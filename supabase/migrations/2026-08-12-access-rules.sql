-- Правила доступа по статусу пользователя (12.08).
--
-- ЗАДАЧА: пользователь без доступа (`profiles.active = false`) не должен получать НИЧЕГО,
-- кроме своего профиля — ни через API, ни напрямую в таблицы.
--
-- ЧТО ВАЖНО ПОНИМАТЬ ПРО RLS ЗДЕСЬ.
--   1. RLS на всех таблицах public уже включён (2026-07-31-rls.sql) и БЕЗ политик, то есть
--      для ролей anon/authenticated это deny-all: снаружи не читается вообще ничего.
--      Строже уже некуда — «правила на все таблицы» в смысле «чужой не прочитает» стоят.
--   2. Наш бэкенд ходит СЕРВИСНЫМ ключом (service_role), а он RLS обходит по определению.
--      Поэтому правило «нет доступа → нет данных» дополнительно живёт в API:
--      server/lib/accessGate.js (403 на всё, кроме профиля, подписки и поддержки).
--   3. Эта миграция добавляет то, чего не хватало: функцию проверки доступа для политик и
--      право пользователя ЧИТАТЬ СВОЙ профиль напрямую — чтобы отключённый видел причину,
--      а клиент мог подписаться на своё состояние (в т.ч. будущий realtime).
--
-- Идемпотентно. Применение: Supabase → SQL Editor → выполнить файл.

-- ── 1. Кто я и есть ли у меня доступ ────────────────────────────────────────

/**
 * Профиль текущего пользователя = auth.uid(). Отдельная функция, чтобы политики читались
 * одинаково и правку делать в одном месте.
 */
create or replace function public.current_profile_id()
returns uuid
language sql
stable
as $$ select auth.uid() $$;

/**
 * Есть ли у текущего пользователя доступ. SECURITY DEFINER — иначе функция сама упёрлась
 * бы в RLS таблицы profiles и всегда возвращала false (классическая ловушка).
 * search_path прибит явно: без него владелец функции рискует подменой схемы.
 */
create or replace function public.has_access()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce((select p.active from public.profiles p where p.id = auth.uid()), false)
$$;

revoke all on function public.has_access() from public;
grant execute on function public.has_access() to authenticated;
grant execute on function public.current_profile_id() to authenticated;

-- ── 2. Профиль: свой виден ВСЕГДА, даже когда доступ отключён ────────────────
-- Это то самое исключение: человек обязан видеть, кто он и что доступ закрыт, иначе
-- отключение выглядит как поломка. Чужие профили не видны никому.

drop policy if exists "profiles: read own" on public.profiles;
create policy "profiles: read own"
  on public.profiles for select
  to authenticated
  using (id = auth.uid());

-- Писать в свой профиль напрямую НЕ разрешаем: имя/роли/лимиты меняются только через
-- API (там аудит и проверка прав). Право на select дано осознанно и точечно.

-- ── 3. Все остальные таблицы ────────────────────────────────────────────────
-- Политик НЕ добавляем: остаётся deny-all для anon/authenticated. Любая политика здесь
-- открыла бы прямой доступ к данным в обход ролей §8.1 и владельца §11.3, которые живут
-- в Node-слое. Когда клиенту действительно понадобится прямой доступ (realtime-чат
-- поддержки), политика добавляется ТОЧЕЧНО на конкретную таблицу и обязана проверять
-- и владельца, и public.has_access().
--
-- Шаблон такой точечной политики (пример, не применяется):
--   create policy "<table>: own rows"
--     on public.<table> for select to authenticated
--     using (profile_id = auth.uid() and public.has_access());

-- ── 4. Пояс поверх подтяжек: снять лишние гранты ─────────────────────────────
-- RLS без грантов и так закрывает, но если кто-то однажды добавит политику по ошибке,
-- отсутствие GRANT остановит запрос вторым рубежом.
do $$
declare t record;
begin
  for t in
    select tablename from pg_tables
    where schemaname = 'public' and tablename <> 'profiles'
  loop
    execute format('revoke all on public.%I from anon, authenticated', t.tablename);
  end loop;
end $$;

-- profiles: только чтение своей строки (политика выше), запись — через сервис.
revoke all on public.profiles from anon, authenticated;
grant select on public.profiles to authenticated;
