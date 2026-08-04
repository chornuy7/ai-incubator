-- §4.1 (MR-28): «синхронизировать зависимые статусы владельца и субпользователей
-- правилами базы данных». Блокировка (active=false) владельца каскадит на всех его
-- субпользователей вниз по дереву parent_id. Разблокировка НЕ включает субов
-- автоматически — сотрудника могли отключить индивидуально, и тихо вернуть ему доступ
-- вместе с владельцем было бы дырой. Обратное включение — вручную.
--
-- Рекурсия: обновление детей само дёргает этот триггер и каскадит глубже.
-- SECURITY DEFINER — чтобы каскад проходил вне зависимости от RLS.
--
-- Приложение дополнительно барьерит это в рантайме (users.js#isBlockedByOwner) — на
-- случай, когда триггер ещё не накатили или строки детей не успели обновиться.

create or replace function public.cascade_owner_block()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if (new.active is distinct from old.active) and new.active = false then
    update public.profiles
       set active = false, updated_at = now()
     where parent_id = new.id
       and active = true;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_cascade_owner_block on public.profiles;

create trigger trg_cascade_owner_block
  after update of active on public.profiles
  for each row
  execute function public.cascade_owner_block();
