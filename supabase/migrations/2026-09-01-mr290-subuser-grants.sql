-- MR-290, шаг 6: выдачи суб-пользователю — строками со ссылками, а не массивами text[].
--
-- `profiles.account_ids` и `profiles.account_group_ids` — это ВЫДАННЫЕ ПРАВА: какие
-- аккаунты и какие группы владелец открыл своему сотруднику. Хранились массивами строк,
-- и база не могла проверить, что за идентификатором вообще что-то стоит.
--
-- Чем это кончилось, видно прямо в боевых данных. У профиля usr_3947b0add427 (gsub@x.y)
-- выдан аккаунт `acc_9` и группа `grp_1` — ни того, ни другого не существует. Право
-- есть, ведёт в никуда, и никто об этом не знает: интерфейс показывает выдачу, проверка
-- доступа молча её не находит. Найти такое можно было только запросом вроде того, что
-- написан ниже, — то есть никогда.
--
-- После переезда завести право на несуществующий объект нельзя: откажет внешний ключ.
-- А удалённый аккаунт или группа уносят выданные на них права с собой, без отдельного
-- прохода в коде — сегодня такого прохода нет вовсе, и права остаются висеть.
--
-- ⚠️ КОЛОНКИ ЗДЕСЬ НЕ УДАЛЯЮТСЯ. Миграции применяются до выката кода, и в промежутке
-- работает предыдущая версия, которая читает именно их. Снимем следующим релизом.

create table if not exists profile_account_grants (
  profile_id text not null references profiles(legacy_id) on update cascade on delete cascade,
  account_id text not null references accounts_meta(id)   on delete cascade,
  granted_at timestamptz not null default now(),
  primary key (profile_id, account_id)
);
create index if not exists profile_account_grants_account_idx on profile_account_grants (account_id);

create table if not exists profile_group_grants (
  profile_id text not null references profiles(legacy_id)  on update cascade on delete cascade,
  group_id   text not null references account_groups(id)   on delete cascade,
  granted_at timestamptz not null default now(),
  primary key (profile_id, group_id)
);
create index if not exists profile_group_grants_group_idx on profile_group_grants (group_id);

comment on table profile_account_grants is
  'Аккаунты, выданные суб-пользователю из пула владельца. Переехали из массива profiles.account_ids (MR-290): массив не давал базе проверить, что аккаунт существует, и в боевых данных нашлось право на несуществующий acc_9.';
comment on table profile_group_grants is
  'Группы аккаунтов, выданные суб-пользователю. Переехали из массива profiles.account_group_ids (MR-290) по той же причине: право на удалённую группу молча переставало работать.';

-- Перенос. Фильтр «только существующие» здесь НУЖЕН и отличается от переноса состава
-- групп: там сирот не было и падение означало бы новую беду, здесь сироты есть и заранее
-- известны поимённо (acc_9 и grp_1 у usr_3947b0add427). Такое право уже не действует —
-- проверка доступа его не находит, — поэтому перенести его некуда и незачем. Пропуск
-- ничего не отнимает: отнято оно было в тот момент, когда объект удалили.
insert into profile_account_grants (profile_id, account_id)
select p.legacy_id, v
from profiles p, unnest(p.account_ids) as v
where p.legacy_id is not null
  and exists (select 1 from accounts_meta a where a.id = v)
on conflict (profile_id, account_id) do nothing;

insert into profile_group_grants (profile_id, group_id)
select p.legacy_id, v
from profiles p, unnest(p.account_group_ids) as v
where p.legacy_id is not null
  and exists (select 1 from account_groups g where g.id = v)
on conflict (profile_id, group_id) do nothing;

comment on column profiles.account_ids is
  'УСТАРЕЛО (MR-290): выдачи живут в profile_account_grants. Колонка снимается следующим релизом — её ещё читает код, работающий на сервере в момент накатки миграции.';
comment on column profiles.account_group_ids is
  'УСТАРЕЛО (MR-290): выдачи живут в profile_group_grants. Снимается следующим релизом.';
