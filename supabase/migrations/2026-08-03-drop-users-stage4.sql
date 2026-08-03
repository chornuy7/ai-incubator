-- §11.3 (переезд на profiles, ЭТАП 4/4 — ФИНАЛ): удалить старую таблицу public.users.
--
-- ⛔ НЕ ПРИМЕНЯТЬ, пока НЕ выполнено В КОДЕ (в окне обслуживания, с бэкапом):
--   1) все операторы заведены в Supabase Auth с паролями
--      (проверено read-only 03.08: users=2, profiles=2, auth=2, 0 без профиля, 0 без Auth);
--   2) снят legacy-вход (server/users.js authenticate по users.password_hash) —
--      вход остаётся ТОЛЬКО через Supabase Auth (authenticateSupabase);
--   3) снят dual-write в users (createUser/updateUser/deleteUser больше НЕ пишут в users);
--   4) сделан свежий бэкап БД (Supabase → Database → Backups).
-- До выполнения 1–4 таблица users — точка отката; дропать нельзя.
--
-- Предусловие уже выполнено: ни один внешний ключ больше не ссылается на public.users
-- (этап 3/4, 2026-07-31-profiles-stage3-fk.sql перевёл все owner-FK на profiles(legacy_id)).
-- Поэтому drop не заблокируется зависимостями.
--
-- Как применить (в окне): Supabase → SQL Editor → выполнить этот файл.

-- Вариант А (рекомендую) — обратимо неделю: переименовать, а не удалять.
-- Через неделю без инцидентов удалить `users_legacy_2026_08` отдельным запросом.
-- alter table if exists users rename to users_legacy_2026_08;

-- Вариант Б — окончательное удаление (после недели-двух на варианте А):
drop table if exists users;
