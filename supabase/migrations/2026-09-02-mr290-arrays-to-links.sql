-- MR-290, шаг 14: массивы text[] → таблицы связей.
--
-- Массив идентификаторов в колонке — это внешний ключ, который база не проверяет. Роль
-- удаляют, а в `profiles.role_ids` остаётся её идентификатор; прочитать «кому выдана роль
-- X» можно только развернув массивы у всех восьмидесяти шести профилей; выдать роль двум
-- профилям одной транзакцией нельзя, потому что каждый раз переписывается весь массив
-- целиком — и два одновременных изменения затирают друг друга молча (классическая гонка
-- «прочитал-изменил-записал»).
--
-- Здесь заводятся четыре таблицы связей. Массивы НЕ УДАЛЯЮТСЯ: миграции применяются ДО
-- выката кода, и между этими двумя моментами со свежей схемой работает ещё старый код.
-- Снос колонок — отдельной миграцией, следующим выпуском.
--
-- ПОРЯДОК СОХРАНЯЕТСЯ КОЛОНКОЙ `position`. В массиве он был неявным, и на него опирается
-- живой код: `roleId` пользователя — это `role_ids[1]`, «первичная» роль, которой
-- подписаны карточки в админке. Множество без порядка потеряло бы это различие, а
-- «первичная роль стала другой» — не та ошибка, которую замечают сразу.

-- ─────────────────────────────────────────────────────────────
-- Роли профиля
-- ─────────────────────────────────────────────────────────────
-- Ключ здесь ТЕКСТОВЫЙ legacy_id, а не uuid, — как в profile_account_grants и
-- profile_group_grants рядом. Профиль во всём коде адресуется `usr_…`, и вторая
-- договорённость о ключе в соседней таблице означала бы перевод туда-обратно на каждом
-- чтении: место, где однажды переведут не в ту сторону и не заметят.
create table if not exists profile_roles (
  profile_id text not null references profiles(legacy_id) on update cascade on delete cascade,
  role_id    text not null references roles(id)           on delete cascade,
  position   int  not null default 0,
  primary key (profile_id, role_id)
);

-- Про `on delete cascade` у роли. Соблазн поставить `restrict` («нельзя удалить выданную
-- роль») есть, но это изменило бы поведение: сегодня удаление роли просто перестаёт
-- действовать у всех, кому она была выдана — висячий идентификатор код отбрасывает
-- (`roleNamesOf`, `.filter(Boolean)`). Каскад воспроизводит ровно это, только честно, без
-- мусора в данных. Запрет на удаление — отдельное продуктовое решение, и принимать его
-- заодно с переносом формата хранения нельзя.
comment on table profile_roles is
  'MR-290: роли профиля связями вместо profiles.role_ids. position хранит порядок — первая роль считается первичной.';

create index if not exists profile_roles_role_idx on profile_roles (role_id);

insert into profile_roles (profile_id, role_id, position)
select p.legacy_id, r.role_id, r.ord - 1
  from profiles p, lateral unnest(p.role_ids) with ordinality as r(role_id, ord)
 where p.legacy_id is not null and r.role_id in (select id from roles)
on conflict do nothing;

-- ─────────────────────────────────────────────────────────────
-- Роли пользователя (таблица users — вход по паролю, живёт отдельно от profiles)
-- ─────────────────────────────────────────────────────────────
create table if not exists user_roles (
  user_id  text not null references users(id) on delete cascade,
  role_id  text not null references roles(id) on delete cascade,
  position int  not null default 0,
  primary key (user_id, role_id)
);

comment on table user_roles is
  'MR-290: роли учётной записи связями вместо users.role_ids.';

create index if not exists user_roles_role_idx on user_roles (role_id);

insert into user_roles (user_id, role_id, position)
select u.id, r.role_id, r.ord - 1
  from users u, lateral unnest(u.role_ids) with ordinality as r(role_id, ord)
 where r.role_id in (select id from roles)
on conflict do nothing;

-- ─────────────────────────────────────────────────────────────
-- Модули кампании
-- ─────────────────────────────────────────────────────────────
-- Таблица заведена ещё в 2026-07-30-module-links.sql, но была ПРОЕКЦИЕЙ: источником
-- оставался массив `campaigns.modules`, а связи поддерживал `typesSync.relink()` следом.
-- Проекция расходится с источником при любой записи мимо неё, и проверить это некому.
-- Здесь таблица становится источником: код читает и пишет её.
alter table campaign_modules add column if not exists position int not null default 0;

comment on table campaign_modules is
  'MR-290: модули кампании. Источник, а не проекция campaigns.modules (до MR-290 связи догонял typesSync).';

insert into campaign_modules (campaign_id, module_id, position)
select c.id, m.id, k.ord - 1
  from campaigns c,
       lateral unnest(c.modules) with ordinality as k(module_key, ord)
       join modules m on m.key = k.module_key
on conflict do nothing;

-- ─────────────────────────────────────────────────────────────
-- Состав подписки в журнале кошелька
-- ─────────────────────────────────────────────────────────────
create table if not exists wallet_log_modules (
  log_id    bigint not null references wallet_log(id) on delete cascade,
  module_id bigint not null references modules(id)    on delete restrict,
  position  int    not null default 0,
  primary key (log_id, module_id)
);

-- Здесь `restrict`, а не `cascade`, и это не разнобой с profile_roles. Журнал кошелька —
-- деньги: запись обязана объяснять, за что списали, спустя год. Каскад стёр бы состав
-- подписки при удалении модуля, и в отчёте осталась бы сумма без основания. Пусть лучше
-- удаление модуля упрётся в журнал: модулей пятнадцать, они справочник платформы, а не
-- пользовательские данные, и удаляют их примерно никогда.
comment on table wallet_log_modules is
  'MR-290: состав подписки в записи журнала связями вместо wallet_log.modules. Снимок на момент операции — удалить модуль, за который списывали, база не даст.';

create index if not exists wallet_log_modules_module_idx on wallet_log_modules (module_id);

insert into wallet_log_modules (log_id, module_id, position)
select w.id, m.id, k.ord - 1
  from wallet_log w,
       lateral unnest(w.modules) with ordinality as k(module_key, ord)
       join modules m on m.key = k.module_key
on conflict do nothing;

-- ─────────────────────────────────────────────────────────────
-- Права доступа
-- ─────────────────────────────────────────────────────────────
-- Через PostgREST ходит только service_role; RLS включаем как на остальных таблицах,
-- чтобы случайный анонимный ключ не увидел, у кого какие роли.
alter table profile_roles      enable row level security;
alter table user_roles         enable row level security;
alter table wallet_log_modules enable row level security;

grant select, insert, update, delete on profile_roles      to service_role;
grant select, insert, update, delete on user_roles         to service_role;
grant select, insert, update, delete on wallet_log_modules to service_role;

-- ─────────────────────────────────────────────────────────────
-- Запись в журнал кошелька — одной транзакцией
-- ─────────────────────────────────────────────────────────────
-- Строка журнала и её состав подписки должны появляться вместе или не появляться вовсе.
-- Через PostgREST это два отдельных запроса: между ними процесс может умереть, и в базе
-- останется списание без основания — ровно та половинчатая запись, ради устранения
-- которой затевался переезд с массива. Для денег это неприемлемо, поэтому вставка
-- уезжает в базу целиком.
--
-- Ключи модулей на входе, а не идентификаторы: код оперирует ключами, и перевод в id —
-- забота той стороны, где лежит справочник. Неизвестный ключ здесь ОТКАЗ, а не пропуск:
-- «списали за модуль, которого нет» — это повод разобраться, а не молча потерять строку
-- состава.
create or replace function wallet_log_append(entry jsonb, module_keys text[] default null)
returns bigint
language plpgsql
as $$
declare
  new_id bigint;
  k text;
  mid bigint;
  pos int := 0;
begin
  insert into wallet_log (ts, user_id, actor_id, amount, before_val, after_val, reason, currency, kind, modules)
  values (
    coalesce((entry->>'ts')::timestamptz, now()),
    entry->>'user_id',
    entry->>'actor_id',
    (entry->>'amount')::numeric,
    (entry->>'before_val')::numeric,
    (entry->>'after_val')::numeric,
    coalesce(entry->>'reason', ''),
    entry->>'currency',
    entry->>'kind',
    -- Колонка пока пишется тоже: до выката кода журнал читает предыдущая версия, и
    -- пустой состав выглядел бы у неё как «подписка ни на что». Снимем следующим
    -- выпуском вместе с остальными массивами.
    module_keys
  )
  returning id into new_id;

  foreach k in array coalesce(module_keys, '{}'::text[]) loop
    select id into mid from modules where key = k;
    if mid is null then
      raise exception 'MR-290: модуль % не найден в справочнике — запись журнала отменена', k;
    end if;
    insert into wallet_log_modules (log_id, module_id, position) values (new_id, mid, pos)
    on conflict do nothing;
    pos := pos + 1;
  end loop;

  return new_id;
end $$;

comment on function wallet_log_append(jsonb, text[]) is
  'MR-290: строка журнала кошелька вместе с составом подписки, одной транзакцией. Через PostgREST это были два запроса, между которыми оставалось списание без основания.';

revoke all on function wallet_log_append(jsonb, text[]) from public;
grant execute on function wallet_log_append(jsonb, text[]) to service_role;
