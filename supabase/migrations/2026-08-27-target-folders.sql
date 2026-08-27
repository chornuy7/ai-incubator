-- Папки целей переезжают из файла в общую базу.
--
-- Находка 27.08 (MR-186): `server/targetFolders.js` писал в data/target-folders.json,
-- ветки Supabase не было, а env для пути не было вовсе — то есть даже тесты писали туда,
-- куда и боевой сервер. Что в папках лежит: кого именно клиент собрался обрабатывать —
-- его ниша и его наработка. Пропал диск — наработка не восстанавливается ниоткуда.
create table if not exists target_folders (
  id      text primary key,
  -- Владелец пространства. NULL — папки, заведённые до владельческой модели (21.08):
  -- угадать задним числом, чьи они, нельзя, поэтому их видит только админ.
  user_id text,
  name    text not null,
  created_at bigint not null,
  updated_at bigint not null
);

-- Цели папки — ОТДЕЛЬНЫМИ строками, а не списком в одном поле.
--
-- Дело не только в правиле «JSON в базе = ошибка». Первичный ключ (папка, канал) делает
-- невозможными дубли, на которых платформа уже обжигалась: юзернеймы Telegram
-- регистронезависимы, `@nuancesprog` и `@NUANCESPROG` — один канал, и пока они лежали
-- двумя строками списка, кампания отрабатывала по такому каналу ДВАЖДЫ одним аккаунтом.
-- Повторные действия в один чат читаются как сигнатура бота. Раньше это держалось только
-- на normalizeTargets в коде; теперь этого не даст сделать сама база.
create table if not exists target_folder_targets (
  folder_id text not null references target_folders(id) on delete cascade,
  -- Всегда в нижнем регистре и без «@» — приводит normalizeTargets перед записью.
  username  text not null,
  -- Порядок, в котором цели добавили: список в папке не должен перетасовываться.
  position  integer not null default 0,
  primary key (folder_id, username)
);

create index if not exists target_folders_owner_idx  on target_folders (user_id);
create index if not exists target_folder_targets_idx on target_folder_targets (folder_id, position);

-- Доступ только у бэкенда (сервисный ключ обходит RLS). Публичной политики нет намеренно:
-- база каналов — это наработка конкретного клиента, чужому её видеть нельзя.
alter table target_folders        enable row level security;
alter table target_folder_targets enable row level security;

comment on table target_folders is 'Папки целей. Переехали из server/data/target-folders.json (27.08, MR-186): файл на одной машине, у пути даже не было env — тесты писали туда же, куда боевой сервер.';
comment on table target_folder_targets is 'Цели папки построчно. Первичный ключ (папка, канал) не даёт завести один канал дважды — раньше дубли приводили к повторной обработке канала одним аккаунтом, а это сигнатура бота.';
