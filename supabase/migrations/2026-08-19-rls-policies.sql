-- MR-94 / AUTH-002: защита Supabase API — RLS-политики «только активный профиль».
--
-- КОНТЕКСТ. RLS уже включён на таблицах (2026-07-31-rls.sql), но БЕЗ политик = deny-all:
-- снаружи (anon/authenticated) закрыто всё, backend ходит service-ключом (обходит RLS).
-- Эта миграция добавляет ПОЛИТИКИ доступа для роли `authenticated`: строку из таблицы,
-- используемой авторизованным пользователем панели, можно читать/писать ТОЛЬКО если его
-- профиль активен (profiles.active = true). Отключили профиль (active=false) → доступ
-- через Supabase API пропадает (проверка задачи).
--
-- ⚠️ АРХИТЕКТУРА. Политики действуют на роль `authenticated` — прямой доступ клиент→Supabase.
-- Node-backend на service_role их ОБХОДИТ и остаётся основным путём. Сейчас фронт в
-- Supabase напрямую не ходит, поэтому это defense-in-depth + выполнение требования:
-- закрывает дыру «взяли anon-ключ + токен и пошли мимо бэкенда».
--
-- ⚠️ ОБЪЁМ ДОСТУПА. Базовый гейт — «активный профиль» (как в задаче/комменте): любой
-- активный authenticated-пользователь видит строки этих таблиц. Порядно по владельцу
-- (user видит только своё) — ОТДЕЛЬНОЕ решение (owner-scoping), здесь намеренно НЕ вводим,
-- чтобы не сломать легитимный доступ без согласования. До включения прямого доступа
-- клиента к Supabase — добавить owner-scoping отдельной миграцией.
--
-- Идемпотентно: DROP POLICY IF EXISTS + пропуск отсутствующих таблиц (to_regclass).
-- Как применить: Supabase → SQL Editor → выполнить файл.

-- 1) Таблицы, к которым обращается АВТОРИЗОВАННЫЙ пользователь панели → политика
--    «только активный профиль».
do $$
declare
  t text;
  gated text[] := array[
    'profiles', 'coin_balance', 'wallet_log', 'token_ledger', 'subscriptions', 'api_keys',
    'roles', 'bundles', 'goals', 'campaigns', 'leads', 'parsed_channels', 'accounts_meta',
    'messages', 'user_types', 'modules', 'user_type_modules', 'module_prices',
    'subscription_modules', 'bundle_modules', 'campaign_modules', 'channels',
    'account_groups', 'account_activity', 'campaign_schedules', 'agents'
  ];
  pol text;
begin
  foreach t in array gated loop
    if to_regclass('public.' || t) is null then
      continue; -- таблицы нет в этой БД — пропускаем
    end if;
    pol := t || ': active profiles only';
    execute format('alter table public.%I enable row level security', t);
    -- Имя политики — ИДЕНТИФИКАТОR (%I, двойные кавычки), а не строковый литерал (%L).
    execute format('drop policy if exists %I on public.%I', pol, t);
    execute format(
      'create policy %I on public.%I for all to authenticated '
      'using (exists (select 1 from public.profiles p where p.id = auth.uid() and p.active = true)) '
      'with check (exists (select 1 from public.profiles p where p.id = auth.uid() and p.active = true))',
      pol, t
    );
  end loop;
end $$;

-- 2) Служебные/админские таблицы: RLS включаем, но политику для authenticated НЕ даём —
--    доступ только через backend (service_role). audit_log и module_actions созданы после
--    миграции 2026-07-31, RLS на них могло не быть — включаем здесь.
do $$
declare
  t text;
  service_only text[] := array['audit_log', 'module_actions', 'app_settings', 'price_overrides', 'users'];
begin
  foreach t in array service_only loop
    if to_regclass('public.' || t) is not null then
      execute format('alter table public.%I enable row level security', t);
    end if;
  end loop;
end $$;

-- 3) Проверка (выполнить ОТДЕЛЬНО после применения):
--    a) отключить тестовый профиль:
--       update public.profiles set active = false where legacy_id = 'usr_test';
--    b) под его authenticated-токеном запрос к защищённой таблице (напр. account_activity)
--       через Supabase API вернёт 0 строк / откажет;
--    c) вернуть active = true → доступ восстановится.
--    Проверить наличие политик:
--       select tablename, policyname from pg_policies where schemaname = 'public' order by 1;
