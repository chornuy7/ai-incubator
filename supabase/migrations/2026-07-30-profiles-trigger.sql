-- §11.3: профиль создаётся САМ при появлении пользователя в Supabase Auth.
--
-- Отвечает на вопрос «как юзеры потом будут попадать в БД»: не руками через панель, а
-- двумя обычными путями — регистрация на сайте (`auth.signUp`) и заведение из админки
-- (`auth.admin.createUser`). Оба пишут в `auth.users`, и этот триггер подхватывает.
--
-- Почему триггером, а не кодом приложения: путей появления auth-пользователя несколько
-- (сайт, админка, OAuth в будущем, ручное добавление в панели Supabase). Если создавать
-- профиль в коде, любой путь мимо него даст юзера БЕЗ профиля — и он не будет виден в
-- админке, не получит роль и баланс. Триггер закрывает все пути разом.
--
-- Имя берём из метаданных регистрации (`raw_user_meta_data.name`), если его передали;
-- иначе — часть e-mail до собаки, чтобы в списке не было пустых строк.
--
-- Как применить: Supabase → SQL Editor → выполнить этот файл (после 2026-07-30-profiles.sql).

create or replace function public.handle_new_auth_user()
returns trigger
language plpgsql
security definer            -- нужен доступ к public.profiles из схемы auth
set search_path = public
as $$
begin
  insert into public.profiles (id, name, active)
  values (
    new.id,
    coalesce(
      nullif(new.raw_user_meta_data ->> 'name', ''),
      split_part(new.email, '@', 1)
    ),
    true
  )
  on conflict (id) do nothing;   -- повторный вызов не должен ломать регистрацию
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_auth_user();

comment on function public.handle_new_auth_user is
  '§11.3: создаёт profiles при появлении пользователя в auth.users — любым путём (сайт, админка, OAuth).';
