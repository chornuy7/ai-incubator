-- Счётчик переходов по ссылке переезжает из файлов в общую базу.
--
-- Находка 27.08 (MR-186): `server/linkTracker.js` держал ссылки в data/links.json, а сами
-- переходы дописывал строками в data/link-hits.jsonl. Ветки Supabase не было.
-- Это измеримый результат кампании (SPEC §1.3): без него цель «200 переходов» нечем
-- закрыть, критерий завершения остаётся на честном слове оператора.
--   • пропал диск — переходы не восстановить ничем, они нигде больше не считаются;
--   • при втором инстансе половина кликов уходит в файл одного сервера, половина
--     другого, и цель не наберёт нужного числа никогда.
create table if not exists tracked_links (
  id      text primary key,
  -- Код короткой ссылки (/r/<code>). Уникален: по нему находят, куда редиректить.
  code    text not null unique,
  -- Чья ссылка. Аудит 21.08: владельца не было, и список отдавал все ссылки платформы —
  -- то есть куда каждый клиент ведёт людей и сколько переходов собрал.
  user_id text,
  url     text not null,
  title   text not null default '',
  goal_id     text,
  campaign_id text,
  -- Счётчики держим рядом со ссылкой: их читают на каждом показе цели, а считать
  -- их запросом по всей таблице переходов ради одной цифры незачем.
  hits        integer not null default 0,
  unique_hits integer not null default 0,
  created_at  bigint not null
);

-- Сами переходы. Отдельной строкой на клик — по ним считается уникальность и по ним
-- же видно, когда именно шёл трафик.
create table if not exists link_hits (
  id   text primary key,
  code text not null references tracked_links(code) on delete cascade,
  -- Отпечаток посетителя: хеш от IP и user-agent. Сырые IP не храним — ради счётчика
  -- переходов держать у себя адреса посетителей незачем.
  fp   text not null,
  ref  text not null default '',
  ts   bigint not null
);

-- Главный запрос счётчика: «был ли уже такой посетитель по этой ссылке». В файловом
-- варианте на это уходило чтение ВСЕГО журнала переходов на каждый клик.
create index if not exists link_hits_unique_idx on link_hits (code, fp);
create index if not exists tracked_links_goal_idx  on tracked_links (goal_id);
create index if not exists tracked_links_owner_idx on tracked_links (user_id);

-- Доступ только у бэкенда (сервисный ключ обходит RLS). Публичной политики нет намеренно:
-- ссылки и переходы — это воронка конкретного клиента.
alter table tracked_links enable row level security;
alter table link_hits     enable row level security;

comment on table tracked_links is 'Отслеживаемые короткие ссылки. Переехали из server/data/links.json (27.08, MR-186): при втором инстансе половина кликов уходила бы в файл одного сервера, половина другого.';
comment on table link_hits is 'Переходы по ссылкам, строка на клик. Переехали из server/data/link-hits.jsonl. Индекс (code, fp) заменил чтение всего журнала на каждый клик.';
comment on column link_hits.fp is 'Хеш от IP и user-agent. Сырые адреса посетителей не храним: для счётчика переходов они не нужны.';
