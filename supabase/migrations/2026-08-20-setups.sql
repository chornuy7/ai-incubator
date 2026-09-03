-- MR-149 (созвон 19.08): готовые сетапы (скидочные наборы модулей) — ИЗ БД, а не из кода.
-- Требование: «экономики в коде быть не должно», редактируется из админки. Храним РЕЛЯЦИОННО
-- (без JSON): setups — сам набор со скидкой, setup_modules — его состав (одна строка на модуль).
--
-- Скидка — доля (0.2 = −20 %) от суммы входящих модулей, а НЕ фикс-цена (это отличает сетап
-- от bundles, где цена явная): при изменении цен модулей сетап пересчитывается сам.
--
-- all_modules=true — «Всё включено»: состав = все известные модули, автоматически включает
-- новые (в setup_modules его не перечисляем, иначе новый модуль пришлось бы дописывать вручную).

create table if not exists setups (
  id text primary key,
  name text not null,
  hint text not null default '',
  discount numeric not null default 0,          -- доля скидки 0..0.9
  all_modules boolean not null default false,   -- true = состав = все модули платформы
  sort integer not null default 0,              -- порядок показа на витрине
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists setup_modules (
  setup_id text not null references setups(id) on delete cascade,
  module_key text not null,
  primary key (setup_id, module_key)
);
create index if not exists setup_modules_setup_idx on setup_modules(setup_id);

-- Сид: ровно те три сетапа, что были захардкожены в server/pricing.js (SETUPS).
insert into setups (id, name, hint, discount, all_modules, sort) values
  ('setup-outreach', 'Аутрич',      'Найти аудиторию, написать в личку и довести до цели',   0.2,  false, 1),
  ('setup-engage',   'Вовлечение',  'Присутствие в чужих каналах: комментарии, ответы, реакции', 0.2, false, 2),
  ('setup-all',      'Всё включено','Все модули платформы без ограничений',                   0.35, true,  3)
on conflict (id) do nothing;

insert into setup_modules (setup_id, module_key) values
  ('setup-outreach', 'parsing-users'),
  ('setup-outreach', 'parsing-groups'),
  ('setup-outreach', 'mailing'),
  ('setup-outreach', 'neuro-dialogs'),
  ('setup-outreach', 'neuro-chatting'),
  ('setup-engage',   'parsing'),
  ('setup-engage',   'parsing-comments'),
  ('setup-engage',   'neuro-commenting'),
  ('setup-engage',   'neuro-chatting'),
  ('setup-engage',   'mass-react'),
  ('setup-engage',   'mass-looking')
on conflict do nothing;

-- RLS: читают все (витрина), меняет только сервисная роль (админский эндпоинт под service key).
alter table setups enable row level security;
alter table setup_modules enable row level security;
drop policy if exists setups_read on setups;
create policy setups_read on setups for select using (true);
drop policy if exists setup_modules_read on setup_modules;
create policy setup_modules_read on setup_modules for select using (true);
