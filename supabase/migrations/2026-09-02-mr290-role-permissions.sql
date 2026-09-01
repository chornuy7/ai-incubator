-- MR-290, шаг 17: права роли — строками, а не деревом json.
--
-- `roles.permissions` — это матрица доступа, свёрнутая в одну ячейку:
--
--   { freeAccess: false, personalFor: 'usr_…',
--     modules:   { 'mailing': 'allow' },
--     blocks:    { 'mailing:results': 'deny' },
--     sections:  { 'billing': 'allow' },
--     resources: { 'timers': 'deny', 'accounts': { 'acc_99a4…': 'deny' } } }
--
-- Структура на самом деле РЕГУЛЯРНАЯ: в боевых данных 555 правил, и у каждого ровно два
-- значения — `allow` или `deny`. Это не открытый набор, это таблица, которую записали
-- деревом.
--
-- Что этим потеряно — не абстракция, а конкретные вопросы, на которые нельзя ответить:
--
--   • «у кого есть доступ к аккаунту acc_99a4…» — сегодня это перебор всех 46 ролей с
--     разворотом дерева на каждой. Для системы доступа такой вопрос задают при разборе
--     инцидента, то есть тогда, когда ответ нужен сразу;
--   • «где ещё осталось право на удалённую папку» — так же, никак;
--   • опечатка в значении. `'alow'` вместо `'allow'` записалась бы молча, а прочиталась
--     бы как «не allow», то есть как запрет. Право пропадает, ошибки нет.
--
-- Наружу форма прав НЕ меняется: код собирает то же дерево из строк. Менять и хранение,
-- и формат проверки доступа одной правкой нельзя — это единственное место, где ошибка
-- означает не потерянные данные, а открытый чужому человеку кабинет.
--
-- Колонка `permissions` НЕ УДАЛЯЕТСЯ: миграции применяются до выката кода, и в промежутке
-- доступ считает предыдущая версия — по ней. Снос следующим выпуском.

alter table roles add column if not exists free_access  boolean not null default false;
alter table roles add column if not exists personal_for text;

-- Личная роль заводится под конкретного человека. `on delete set null`, а не каскад:
-- роль может быть уже выдана, и удаление человека не должно молча снимать права у тех,
-- кому её успели назначить. Такая же связь, как у roles.user_id рядом.
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'roles_personal_for_fkey') then
    alter table roles add constraint roles_personal_for_fkey
      foreign key (personal_for) references profiles(legacy_id) on update cascade on delete set null;
  end if;
end $$;

comment on column roles.free_access is
  'Роль работает без подписки: модули открыты, платить не нужно.';
comment on column roles.personal_for is
  'Роль заведена под конкретного человека и в общем списке не предлагается. NULL — обычная роль.';

update roles set
  free_access  = coalesce((permissions->>'freeAccess')::boolean, free_access),
  personal_for = coalesce(nullif(permissions->>'personalFor', ''), personal_for)
where permissions is not null and jsonb_typeof(permissions) = 'object';

-- Владелец личной роли мог быть удалён раньше, чем появился внешний ключ. Такую ссылку
-- снимаем: иначе ключ не создастся и не применится вся миграция.
update roles set personal_for = null
where personal_for is not null and personal_for not in (select legacy_id from profiles where legacy_id is not null);

-- ─────────────────────────────────────────────────────────────
-- Сама матрица
-- ─────────────────────────────────────────────────────────────
-- Одна таблица на все четыре разреза, а не четыре похожих: правило везде устроено
-- одинаково — «на что» и «разрешено или запрещено». Четыре таблицы означали бы четыре
-- места, где надо не забыть про новый разрез.
create table if not exists role_permissions (
  role_id text not null references roles(id) on delete cascade,
  -- Разрез: модуль целиком, блок внутри модуля, раздел панели или ресурс.
  scope   text not null check (scope in ('module', 'block', 'section', 'resource')),
  -- На что правило: ключ модуля (`mailing`), блок (`mailing:results`), раздел или вид
  -- ресурса (`accounts`, `folders`).
  subject text not null check (subject <> ''),
  -- Конкретный элемент внутри вида ресурса: аккаунт, группа, папка. Пустая строка —
  -- правило на весь вид. Именно пустая строка, а не NULL: это часть первичного ключа, а
  -- в ключе NULL не сравнивается сам с собой, и дубли перестали бы отсекаться.
  item_id text not null default '',
  effect  text not null check (effect in ('allow', 'deny')),
  primary key (role_id, scope, subject, item_id)
);

comment on table role_permissions is
  'MR-290: права роли строками вместо дерева roles.permissions. Позволяет спросить «у кого доступ к этому аккаунту» — до этого такой вопрос требовал перебора всех ролей.';
comment on column role_permissions.effect is
  'allow или deny. Третьего значения нет: опечатка вроде ''alow'' раньше записывалась молча и читалась как запрет — право пропадало без ошибки.';

-- Ради того самого вопроса «у кого есть доступ к этому объекту».
create index if not exists role_permissions_subject_idx on role_permissions (scope, subject, item_id);

-- Модули, блоки и разделы: ключ → allow/deny.
insert into role_permissions (role_id, scope, subject, item_id, effect)
select r.id, s.scope, v.key, '', v.value #>> '{}'
  from roles r
  cross join lateral (values ('module', 'modules'), ('block', 'blocks'), ('section', 'sections')) as s(scope, field)
  cross join lateral jsonb_each(coalesce(r.permissions->s.field, '{}'::jsonb)) v
 where jsonb_typeof(v.value) = 'string' and v.value #>> '{}' in ('allow', 'deny')
on conflict do nothing;

-- Ресурсы: правило либо на весь вид (`timers: deny`), либо поэлементно
-- (`accounts: { acc_…: deny }`). Разбираем оба случая.
insert into role_permissions (role_id, scope, subject, item_id, effect)
select r.id, 'resource', v.key, '', v.value #>> '{}'
  from roles r, lateral jsonb_each(coalesce(r.permissions->'resources', '{}'::jsonb)) v
 where jsonb_typeof(v.value) = 'string' and v.value #>> '{}' in ('allow', 'deny')
on conflict do nothing;

insert into role_permissions (role_id, scope, subject, item_id, effect)
select r.id, 'resource', v.key, i.key, i.value #>> '{}'
  from roles r,
       lateral jsonb_each(coalesce(r.permissions->'resources', '{}'::jsonb)) v,
       lateral jsonb_each(v.value) i
 where jsonb_typeof(v.value) = 'object'
   and jsonb_typeof(i.value) = 'string' and i.value #>> '{}' in ('allow', 'deny')
   and i.key <> ''
on conflict do nothing;

alter table role_permissions enable row level security;
grant select, insert, update, delete on role_permissions to service_role;
