-- §11.3 (переезд на profiles, ЭТАП 1/4): profiles становится ПОЛНОЙ записью оператора.
--
-- Замовник (кол 29.07): «profile ВМЕСТО user». Делаем поэтапно, additive-first — `users`
-- НЕ трогаем до финала (она — точка отката). Здесь только дополняем profiles данными,
-- которые раньше жили в users (роли, имя, активность, тип, вложенность). E-mail сюда НЕ
-- кладём — он в auth.users (как и просил замовник).
--
-- Безопасно и идемпотентно: ничего не переключает, вход продолжает работать через users.
-- Как применить: Supabase → SQL Editor → выполнить этот файл.

-- 1. Роли внутри профиля (раньше users.role_ids).
alter table profiles add column if not exists role_ids text[] not null default '{}';

-- 2. Переносим данные из users в profiles по legacy_id (у нас все реальные операторы
--    уже слинкованы). name перезаписываем только если в профиле пусто.
update profiles p set
  role_ids     = coalesce(u.role_ids, '{}'),
  name         = case when coalesce(p.name, '') = '' then coalesce(u.name, '') else p.name end,
  active       = u.active,
  user_type_id = coalesce(p.user_type_id, u.user_type_id),
  updated_at   = now()
from users u
where u.id = p.legacy_id;

-- 3. Вложенность: users.parent_id хранит usr_… (legacy), а profiles.parent_id — uuid.
--    Сопоставляем: родитель по legacy_id → его profiles.id.
update profiles p set parent_id = parent.id
from users u
join profiles parent on parent.legacy_id = u.parent_id
where u.id = p.legacy_id and u.parent_id is not null;

-- 4. Триггер выдаёт legacy_id КАЖДОМУ новому профилю (usr_ + 12 hex из uuid) — чтобы
--    приложение продолжало работать на usr_… id и после отказа от таблицы users, а
--    новые операторы (из auth.signUp / admin.createUser) сразу получали такой id.
create or replace function public.handle_new_auth_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, legacy_id, name, active)
  values (
    new.id,
    'usr_' || substr(replace(new.id::text, '-', ''), 1, 12),
    coalesce(nullif(new.raw_user_meta_data ->> 'name', ''), split_part(new.email, '@', 1)),
    true
  )
  on conflict (id) do nothing;
  return new;
end;
$$;
