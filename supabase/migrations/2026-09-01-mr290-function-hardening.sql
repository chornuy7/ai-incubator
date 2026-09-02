-- MR-290, шаг 10: функции базы перестают быть публичным API.
--
-- Найдено аудитом Supabase (database linter) на боевой базе. Схема `public` целиком
-- выставлена наружу через PostgREST, а значит КАЖДАЯ функция в ней — это ещё и HTTP-ручка
-- `/rest/v1/rpc/<имя>`. Про триггерные функции об этом обычно не думают, и зря:
--
--   • `handle_new_auth_user()` и `cascade_owner_block()` — триггеры, вызывать их напрямую
--     не должен никто. При этом обе SECURITY DEFINER и открыты для `anon`, то есть для
--     любого, кто знает адрес проекта. Прямой вызов сейчас упирается в отсутствие
--     контекста триггера, но полагаться на это — значит держать защиту на случайности;
--   • `is_active_profile()` нужна политикам RLS, поэтому у `authenticated` право
--     остаётся. А вот `anon` она не нужна никогда: все политики выданы `to authenticated`.
--     Через неё анониму видно не больше, чем «активен ли я», но открытая наружу функция
--     без надобности — лишняя ступенька;
--   • `bump_daily_action()` объявлена без `search_path`. Для функции, которая пишет в
--     таблицу, это классическая дыра: владелец схемы может подменить, куда именно идёт
--     запись. Прибиваем путь явно.
--
-- Образец уже есть в этом же репозитории: миграция 2026-08-12-access-rules.sql так и
-- сделала для `has_access()` и `current_profile_id()` — `revoke all from public`, а затем
-- точечный `grant`. Функции, добавленные позже, этого шага не прошли.
--
-- `rls_auto_enable()` НЕ трогаем: это функция самой Supabase (включает RLS на каждой новой
-- таблице). Менять права на чужие управляемые объекты — верный способ получить сюрприз
-- при следующем обновлении платформы.

-- Триггерные функции: снаружи не звать вообще.
revoke all on function public.handle_new_auth_user() from public, anon, authenticated;
revoke all on function public.cascade_owner_block()  from public, anon, authenticated;

-- Помощник RLS: нужен политикам, а политики выданы только `authenticated`.
revoke all on function public.is_active_profile() from public, anon;
grant execute on function public.is_active_profile() to authenticated;

-- Счётчик дневных действий: путь поиска прибит, снаружи не нужен.
create or replace function public.bump_daily_action(p_account text, p_day text, p_action text)
returns integer
language sql
set search_path = public
as $$
  insert into daily_actions (account_id, day, action, count, updated_at)
  values (p_account, p_day, p_action, 1, now())
  on conflict (account_id, day, action)
    do update set count = daily_actions.count + 1, updated_at = now()
  returning count;
$$;
-- `revoke ... from public` снимает и неявное право сервисной роли: у функций право
-- EXECUTE по умолчанию выдано PUBLIC, и service_role пользуется именно им. Возвращаем
-- явно — иначе бэкенд, когда до этой функции дойдёт очередь, упрётся в отказ прав, а
-- сообщение об этом выглядит как «функции нет».
revoke all on function public.bump_daily_action(text, text, text) from public, anon, authenticated;
grant execute on function public.bump_daily_action(text, text, text) to service_role;

comment on function public.bump_daily_action is
  'Инкремент дневного счётчика одним запросом — защита от потерянного обновления при параллельных воркерах. ВНИМАНИЕ: код её пока не зовёт (RPC-вызовов в server/ нет вовсе), счётчики считаются чтением-правкой-записью в JSON. Это отдельная задача: таблица daily_actions и эта функция заведены руками и не подключены.';
