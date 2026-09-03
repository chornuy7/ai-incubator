-- База знаний цели и файлы к ней переезжают из файлов в общую базу.
--
-- Находка 27.08 (MR-186): `server/knowledgeBase.js` писал записи в data/knowledge.json,
-- а `server/kbFiles.js` складывал сами файлы в каталог data/kb-files/. Ветки Supabase
-- не было ни у того, ни у другого. Это контент кампании, введённый руками:
--   • пропал диск — пропала вся база знаний вместе с вложениями;
--   • при втором инстансе запись добавили на одном сервере, а кампания читает с другого:
--     в промпт уйдут неполные факты, и заметить это по результату почти невозможно;
--   • ссылка на файл (`fileRef`) жила бы в базе, а сам файл — на чужом диске: запись
--     есть, вложение не открывается.
create table if not exists knowledge_base (
  id        text primary key,
  -- К какой цели относится запись. Отдельной колонкой: по ней собирают контекст кампании.
  goal_id   text not null,
  kind      text not null default 'text',
  title     text not null default '',
  content   text not null default '',
  -- Ссылка на вложение в kb_files. Не внешний ключ: у текстовых записей вложения нет,
  -- а удаление файла не должно уносить с собой саму запись базы знаний.
  file_ref  text,
  -- Исходный URL — чтобы страницу можно было открыть и перечитать руками.
  url       text,
  scope     text not null default 'all',
  version   integer not null default 1,
  created_at bigint not null,
  updated_at bigint not null,
  constraint knowledge_base_kind_chk check (kind in ('text','file','image','link'))
);

-- Файлы храним ПРЯМО В БАЗЕ (bytea), а не на диске рядом с сервером.
--
-- Это и есть суть переезда: файл на диске одного инстанса для второго не существует.
-- Потолок на файл — 3 МБ, он уже проверяется в kbFiles.js до записи, а вложений к целям
-- единицы: для отдельного файлового хранилища с собственными правами и сроками жизни
-- здесь нет ни объёма, ни причины усложнять доступ.
create table if not exists kb_files (
  -- id — это и есть ссылка вида `kbf_ab12cd34ef56.png`, которую хранит запись КБ.
  id         text primary key,
  -- Имя как его видит человек. Хранится отдельно: в id оно намеренно не попадает,
  -- чтобы имя файла не могло увести чтение в чужой каталог.
  name       text not null,
  mime       text not null,
  size_bytes integer not null,
  data       bytea not null,
  created_at bigint not null
);

create index if not exists knowledge_base_goal_idx on knowledge_base (goal_id, created_at desc);

-- Доступ только у бэкенда (сервисный ключ обходит RLS). Публичной политики нет намеренно:
-- база знаний — это материалы кампании конкретного владельца.
alter table knowledge_base enable row level security;
alter table kb_files       enable row level security;

comment on table knowledge_base is 'База знаний цели. Переехала из server/data/knowledge.json (27.08, MR-186): файл на одной машине, второй инстанс отдавал бы в промпт неполные факты.';
comment on table kb_files is 'Вложения базы знаний, содержимое прямо в базе. Переехали из каталога server/data/kb-files/ (27.08, MR-186): файл на диске одного инстанса для второго не существует.';
comment on column knowledge_base.file_ref is 'Ссылка на kb_files.id. НЕ внешний ключ намеренно: у текстовых записей вложения нет, а удаление файла не должно уносить саму запись.';
